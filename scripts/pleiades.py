"""Import Pleiades places as Atlas Antiqua sites (PRD §6, D1, D3, D7, P1).

Every place that is an archaeological site becomes:

- one point in data/sites/pleiades-sites.geojson: lon, lat and elevation, with
  time bounds in the Holocene calendar, category, size, per-axis confidence,
  publication precision and per-field provenance;
- one feature per Pleiades location in data/sites/pleiades-shapes.geojson:
  the outline shapes (points, lines, polygons) with their own time bounds and
  precision, for LODs and for the later tiling step;
- one row in data/sites/pleiades-sites.csv, a flat view of the points.

Elevation comes from the Copernicus GLO-30 DEM (EGM2008 geoid), read directly
from its cloud-optimised GeoTIFFs on AWS, so only the blocks around each site
are downloaded. It describes today's surface (PRD §6.7).

Usage: python scripts/pleiades.py [--refresh]
"""

import argparse
import csv
import datetime
import gzip
import json
import math
import os
import sys
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "pleiades-places.json.gz"
CACHE = ROOT / "data" / "cache" / "elevation-glo30.csv"
OUT = ROOT / "data" / "sites"

PLEIADES_URL = "https://atlantides.org/downloads/pleiades/json/pleiades-places-latest.json.gz"
DEM_URL = {
    "glo30": "https://copernicus-dem-30m.s3.amazonaws.com/{0}/{0}.tif",
    "glo90": "https://copernicus-dem-90m.s3.amazonaws.com/{0}/{0}.tif",
}

SOURCES = {
    "pleiades": {
        "name": "Pleiades",
        "url": "https://pleiades.stoa.org",
        "licence": "CC BY 3.0",
        "attribution": "Pleiades, (c) the contributors, pleiades.stoa.org",
    },
    "glo30": {
        "name": "Copernicus DEM GLO-30",
        "url": "https://registry.opendata.aws/copernicus-dem/",
        "licence": "Copernicus DEM licence (free use with attribution)",
        "attribution": "(c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH "
                       "2014-2018 provided under COPERNICUS by the European Union and ESA",
    },
    "glo90": {
        "name": "Copernicus DEM GLO-90",
        "url": "https://registry.opendata.aws/copernicus-dem/",
        "licence": "Copernicus DEM licence (free use with attribution)",
        "attribution": "(c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH "
                       "2014-2018 provided under COPERNICUS by the European Union and ESA",
    },
}

# Place types that are not archaeological sites: landforms, waters, peoples,
# administrative units, map labels, and places Pleiades marks as false.
# A place is kept if it has at least one type outside this set.
NON_SITE_TYPES = {
    "archipelago", "bay", "cape", "coast", "coastal-change", "delta", "desert",
    "escarpment", "estuary", "forest", "gorge", "grove", "gulf", "hill", "island",
    "island-group", "isthmus", "lagoon", "lake", "marsh-wetland", "meadow",
    "mountain", "mouth", "oasis", "pass", "peninsula", "plain", "plateau",
    "rapid", "reef", "river", "rock-landform", "salt-marsh", "spring", "strait",
    "valley", "volcano", "water", "water-feature", "water-inland", "water-open",
    "watercourse", "whirlpool",
    "people", "region", "province", "province-2", "kingdom", "state",
    "territory", "satrapy", "league", "tribus", "diocese-roman", "district",
    "nome-egyptian", "nome-gr", "pagus", "regio-augusti", "cultural-landscape",
    "protected-area-modern",
    "label", "unlocated-group",
    "false", "false toponym", "fiction",
}
# Say nothing about whether a place is an archaeological site.
GENERIC_TYPES = {"unknown", "feature", "unlabeled", "numbered feature", "labeled feature", "place",
                 "settlement-modern"}
# Kept out even when the place also has a site type.
FALSE_TYPES = {"false", "false toponym", "fiction"}

# Coarse category from Pleiades place types. The first matching category in
# this order wins, so a settlement with a fort is a settlement.
CATEGORIES = [
    ("settlement", {
        "settlement", "settlement-modern", "urban", "polis", "vicus",
        "fortified-settlement", "hillfort", "tell", "deme-attic", "city-center",
        "grama"}),
    ("fortification", {
        "fort", "fort-2", "fort-group", "fortlet", "castle", "castellum",
        "citadel", "acropolis", "barracks", "military-base",
        "military-installation-or-camp-temporary", "tower-defensive",
        "tower-single", "tower-wall", "tower-gate", "city-wall",
        "defensive-wall", "wall", "wall-2", "interior-wall", "city-gate",
        "gateway", "postern", "frontier-system-limes", "siege-mine",
        "siege-ramp", "nuraghe"}),
    ("religious", {
        "temple", "temple-2", "sanctuary", "shrine", "church", "church-2",
        "abbey", "abbey-church", "priory", "monastery", "mosque", "synagogue",
        "altar", "stupa", "ziggurat", "fortified-church", "diocese-church"}),
    ("funerary", {"cemetery", "tomb", "tumulus", "cairn", "cenotaph", "pyramid"}),
    ("rural", {
        "villa", "farm", "estate", "garden-hortus", "paradise-garden",
        "centuriation", "field", "fishpond"}),
    ("building", {
        "theatre", "amphitheatre", "odeon", "circus", "stadion", "gymnasium",
        "palaestra", "palaistra", "bath", "agora", "forum", "basilica", "stoa",
        "macellum", "plaza", "ekklesiasterion", "lesche", "archive-repository",
        "treasury", "treasure-house", "palace", "palace-complex", "monument",
        "arch", "statue", "fountain", "architecturalcomplex", "building",
        "taberna-shop", "brothel", "townhouse", "house", "city-block", "room",
        "space-interior", "space-uncovered", "swimming-pool", "piscina-roman",
        "platform", "landmark"}),
    ("infrastructure", {
        "road", "street", "bridge", "bridge-group", "aqueduct", "aqueduct-group",
        "canal", "dam", "dike", "dike-group", "levee", "causeway", "tunnel",
        "cistern", "reservoir", "well", "sewer", "station", "port", "harbor",
        "anchorage", "shipshed", "lighthouse", "milestone", "waterwheel",
        "wheel"}),
    ("production", {
        "mine", "mine-2", "quarry", "production", "ceramicproduction",
        "metalworking", "slag-heap", "salt-pan-salina"}),
    ("site", {
        "archaeological-site", "ruin", "findspot", "crop-marks", "pit", "site",
        "cave", "hunting-base", "earthwork", "earthworks"}),
]

# Camera distance (km) within which a site of each category is shown,
# unless links from other places make it more important (view_distance).
VIEW_KM = {
    "settlement": 100, "fortification": 50, "religious": 30, "building": 30,
    "infrastructure": 30, "production": 30, "rural": 20, "site": 20,
    "other": 20, "funerary": 10,
}

MODERN_LOCATION_TYPES = {"associated_modern", "associated modern", "relocated_modern"}

# Pleiades attestation confidence -> PRD time level (§6.7).
# Pleiades periods are period attributions (level 3); "less confident" and
# "inferred" attributions are inferred from context (level 2).
TIME_LEVEL = {
    "confident": 3,
    "less-confident": 2,
    "confident-inferred": 2,
    "less-confident-inferred": 2,
}
ASSOCIATION_LEVEL = {"certain": 3, "less-certain": 2, "uncertain": 1}
REMAINS_PRESENT = {"substantive", "traces", "restored", "notvisible"}

# Copernicus DEM absolute vertical accuracy, LE90 (GLO-90 is resampled GLO-30).
DEM_VERTICAL_M = {"glo30": 4.0, "glo90": 4.0}
DEM_LABEL = {"glo30": "Copernicus GLO-30 (30 m)", "glo90": "Copernicus GLO-90 (90 m)"}
THREADS = 8             # concurrent DEM tiles; each holds only small windows
MAX_WINDOW_M = 500.0    # largest radius searched for the elevation range
UNKNOWN_PUBLICATION_M = 10000  # published precision while the accuracy is unknown
EARTH_RADIUS_M = 6371008.8

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")


# --- time --------------------------------------------------------------------

def to_he(year):
    """Pleiades year (historical: negative = BC, no year zero) to HE."""
    return year + 10001 if year < 0 else year + 10000


def first_pass(places):
    """Period year ranges and inbound link counts, from one pass over places.

    Pleiades sets a record's start/end from its periods, so a record with a
    single attestation carries that period's range. Inbound links count how
    many places connect to a place (a temple "at" Rome, a road to Rome); they
    measure its importance.
    """
    ranges, inbound = {}, Counter()
    for p in places:
        for rec in p.get("locations", []) + p.get("names", []):
            at = rec.get("attestations") or []
            if len(at) == 1 and rec.get("start") is not None and rec.get("end") is not None:
                ranges.setdefault(at[0]["timePeriod"], (rec["start"], rec["end"]))
        for c in p.get("connections") or []:
            target = (c.get("connectsTo") or "").rstrip("/").split("/")[-1]
            if target and target != p["id"]:
                inbound[target] += 1
    return ranges, inbound


def view_distance(types, category, inbound):
    """Largest camera distance (km) at which the site is shown; None = always.

    Major places show from orbit, minor ones only close up, so the map is not
    flooded with points from a distance.
    """
    if inbound >= 8 or {"urban", "polis"} & set(types):
        return None, f"major place: {inbound} places link to it" if inbound >= 8 else "city (urban or polis)"
    if inbound >= 3:
        return 1000, f"{inbound} places link to it"
    km = VIEW_KM.get(category, 20)
    return km, f"{category}: shown within {km} km"


def time_bounds(records, ranges, present_he):
    """Start and end year of an interval from attested Pleiades periods.

    One year per bound, for the viewer's time slider: start is the beginning
    of the earliest attested period, end the end of the latest. Confident
    attestations set the bounds when there are any.
    """
    periods = []
    for rec in records:
        for a in rec.get("attestations") or []:
            key = a["timePeriod"]
            if key in ranges:
                lo, hi, how = *ranges[key], "period"
            elif rec.get("start") is not None and rec.get("end") is not None:
                lo, hi, how = rec["start"], rec["end"], "record"
            else:
                continue
            periods.append({
                "id": key,
                "uri": a.get("timePeriodURI"),
                "periodo": None,
                "confidence": a.get("confidence"),
                "earliest": to_he(lo),
                "latest": min(to_he(hi), present_he),
                "range_from": how,
            })
            # The record's range bounds the site, but it is not this period's
            # range: the period never appears alone, so its own range is unknown.
    if not periods:
        return None

    confident = [x for x in periods if x["confidence"] == "confident"]
    basis = confident or periods
    level = min(TIME_LEVEL.get(x["confidence"], 2) for x in basis)
    raw_end = max(to_he(ranges[x["id"]][1]) if x["range_from"] == "period" else x["latest"]
                  for x in basis)
    seen, unique = set(), []
    for x in sorted(periods, key=lambda x: (x["earliest"], x["latest"], x["id"])):
        if (x["id"], x["confidence"]) not in seen:
            seen.add((x["id"], x["confidence"]))
            unique.append(x)
    start = min(x["earliest"] for x in basis)
    end = max(x["latest"] for x in basis)
    published = [{**x, "earliest": None, "latest": None} if x["range_from"] == "record" else x for x in unique]
    return {
        "status": "dated",
        "start": start,
        "end": end,
        "ongoing": raw_end >= present_he,
        "periods": published,
        "level": level,
        "basis": "confident" if confident else "all",
    }


# --- geometry ------------------------------------------------------------------

def coords_of(geom):
    t, c = geom["type"], geom["coordinates"]
    if t == "Point":
        return [c]
    if t in ("LineString", "MultiPoint"):
        return c
    if t in ("Polygon", "MultiLineString"):
        return [pt for part in c for pt in part]
    if t == "MultiPolygon":
        return [pt for poly in c for ring in poly for pt in ring]
    return []


def haversine_m(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def ring_area_m2(ring):
    """Area of a lon/lat ring, projected to a local equal-area plane."""
    if len(ring) < 3:
        return 0.0
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    k = EARTH_RADIUS_M * math.pi / 180
    xy = [(p[0] * k * math.cos(lat0), p[1] * k) for p in ring]
    s = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(xy, xy[1:] + xy[:1]))
    return abs(s) / 2


def area_m2(geom):
    t, c = geom["type"], geom["coordinates"]
    polys = [c] if t == "Polygon" else c if t == "MultiPolygon" else []
    return sum(ring_area_m2(p[0]) - sum(ring_area_m2(h) for h in p[1:]) for p in polys)


def length_m(geom):
    t, c = geom["type"], geom["coordinates"]
    lines = [c] if t == "LineString" else c if t == "MultiLineString" else []
    return sum(haversine_m(a, b) for line in lines for a, b in zip(line, line[1:]))


def extent_m(points):
    if len(points) < 2:
        return 0.0
    w, e = min(p[0] for p in points), max(p[0] for p in points)
    s, n = min(p[1] for p in points), max(p[1] for p in points)
    return haversine_m((w, s), (e, n))


# --- confidence ------------------------------------------------------------------

def position_level(precision_m, has_own_location):
    """PRD §6.7 position level. Pleiades is a gazetteer, so it caps at 3."""
    if not has_own_location:
        return 2, "pleiades: point taken from connected places; no location of its own"
    if precision_m is None:
        return 2, "pleiades: located, accuracy not stated"
    if precision_m <= 1000:
        return 3, "pleiades: accuracy <= 1 km (gazetteer tier caps at 3)"
    if precision_m <= 10000:
        return 2, "pleiades: accuracy <= 10 km"
    return 1, "pleiades: accuracy > 10 km"


def identity_level(locations, types, names):
    """PRD §6.7 identity: is it a site, and is the name <-> place link right?

    The weaker of the location association and the best ancient name
    association sets the level.
    """
    certainties = [l.get("associationCertainty") for l in locations]
    level = min((ASSOCIATION_LEVEL.get(c, 2) for c in certainties), default=2)
    if not certainties:
        rule = "pleiades: no location record"
    elif level == 3:
        rule = "pleiades: scholarly gazetteer, location association certain"
    else:
        rule = f"pleiades: location association {min(certainties, key=lambda c: ASSOCIATION_LEVEL.get(c, 2))}"
    ancient_names = [n for n in names if "modern" not in (n.get("nameType") or "")]
    if ancient_names:
        best = max(ancient_names, key=lambda n: ASSOCIATION_LEVEL.get(n.get("associationCertainty"), 2))
        name_level = ASSOCIATION_LEVEL.get(best.get("associationCertainty"), 2)
        if name_level < level:
            level = name_level
            rule = f"pleiades: ancient name association at best {best.get('associationCertainty')}"
    if level > 2 and set(types) <= {"settlement-modern", "unknown", "feature", "place"}:
        level, rule = 2, "pleiades: recorded only as a modern settlement"
    remains = {l.get("archaeologicalRemains") for l in locations}
    if level > 2 and remains == {"none"}:
        level, rule = 2, "pleiades: no archaeological remains recorded"
    if level > 2 and not (set(types) - {"unknown", "feature", "unlabeled",
                                         "numbered feature", "labeled feature", "place"}):
        level, rule = 2, "pleiades: place type not identified"
    return level, rule


# --- elevation ------------------------------------------------------------------

def x_res_arcsec(lat):
    """Copernicus DEM longitude spacing (arc seconds at 30 m) by latitude band."""
    a = abs(lat)
    return 1 if a < 50 else 1.5 if a < 60 else 2 if a < 70 else 3 if a < 80 else 5 if a < 85 else 10


def tile_name(lat, lon, dem="glo30"):
    """Copernicus tile holding the pixel nearest to (lat, lon).

    Pixel centres lie on the integer degree grid, so a tile reaches half a
    pixel below its integer latitude and stops half a pixel short of the next
    integer longitude.
    """
    scale = 1 if dem == "glo30" else 3
    la = math.floor(lat - scale / 7200)
    lo = math.floor(lon + scale * x_res_arcsec(lat) / 7200)
    lo = -180 if lo >= 180 else lo
    ns = f"{'N' if la >= 0 else 'S'}{abs(la):02d}"
    ew = f"{'E' if lo >= 0 else 'W'}{abs(lo):03d}"
    return f"Copernicus_DSM_COG_{10 if dem == 'glo30' else 30}_{ns}_00_{ew}_00_DEM"


class TileMissing(Exception):
    pass


def open_tile(dem, name):
    import rasterio
    from rasterio.errors import RasterioIOError

    try:
        return rasterio.open("/vsicurl/" + DEM_URL[dem].format(name))
    except RasterioIOError as e:
        if "404" in str(e):
            raise TileMissing(name) from e
        raise


def sample_tile(dem_id, name, points):
    """Elevation at each point and the elevation spread within its radius.

    points: [(key, lat, lon, radius_m)] -> {key: (status, elev, spread)}
    status: "ok", "sea" or "no-tile". Raises on network or read errors, so
    those are retried on the next run instead of being cached.
    """
    import numpy as np
    from rasterio.windows import Window

    try:
        dem = open_tile(dem_id, name)
    except TileMissing:
        return {k: ("no-tile", None, None) for k, *_ in points}
    out = {}
    with dem:
        for key, lat, lon, radius in points:
            row, col = dem.index(lon, lat)
            row = min(max(row, 0), dem.height - 1)
            col = min(max(col, 0), dem.width - 1)
            dy = max(0, math.ceil(radius / (abs(dem.res[1]) * 111320)))
            dx = max(0, math.ceil(radius / (abs(dem.res[0]) * 111320 * max(math.cos(math.radians(lat)), 0.01))))
            r0, r1 = max(row - dy, 0), min(row + dy + 1, dem.height)
            c0, c1 = max(col - dx, 0), min(col + dx + 1, dem.width)
            win = dem.read(1, window=Window(c0, r0, c1 - c0, r1 - r0), masked=True)
            centre = win[row - r0, col - c0]
            if centre is np.ma.masked:
                out[key] = ("no-tile", None, None)
                continue
            centre = float(centre)
            spread = max(float(win.max()) - centre, centre - float(win.min())) if win.count() else 0.0
            # Copernicus has no nodata over sea; open water reads exactly 0.
            status = "sea" if centre == 0.0 and spread == 0.0 else "ok"
            out[key] = (status, round(centre, 1), round(spread, 1))
    return out


CACHE_COLUMNS = ["key", "status", "elev", "spread", "dem", "tile", "sampled"]


def load_cache():
    """Elevation cache: {key: row}. A cache in an older format is set aside."""
    if not CACHE.exists() or CACHE.stat().st_size == 0:
        return {}
    with open(CACHE, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames == ["key", "elev", "spread"]:
            rows = list(reader)
        else:
            rows = None
        if rows is not None:
            # First format: no status. Keep values; empty ones were network
            # errors or missing tiles and are sampled again.
            f.close()
            cache = {}
            for r in rows:
                if r["elev"]:
                    sea = float(r["elev"]) == 0.0 and float(r["spread"] or 0) == 0.0
                    cache[r["key"]] = {"key": r["key"], "status": "sea" if sea else "ok",
                                       "elev": r["elev"], "spread": r["spread"], "dem": "glo30",
                                       "tile": "", "sampled": "2026-10-03"}
            with open(CACHE, "w", encoding="utf-8", newline="") as w:
                out = csv.writer(w)
                out.writerow(CACHE_COLUMNS)
                out.writerows([r[c] for c in CACHE_COLUMNS] for r in cache.values())
            print(f"elevation cache converted: {len(cache)} values kept")
            return cache
        if reader.fieldnames != CACHE_COLUMNS:
            f.close()
            old = CACHE.with_suffix(".old.csv")
            CACHE.replace(old)
            print(f"elevation cache in an old format, moved to {old.name}")
            return {}
        return {r["key"]: r for r in reader}


def sample_elevations(requests, today):
    """requests: {key: (lat, lon, radius)} -> {key: cache row}

    GLO-30 first; where GLO-30 has no tile (e.g. Armenia, Azerbaijan), GLO-90.
    """
    cache = load_cache()
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE, "a", encoding="utf-8", newline="") as f:
        out = csv.writer(f)
        if f.tell() == 0:
            out.writerow(CACHE_COLUMNS)
            f.flush()
        for dem_id in ("glo30", "glo90"):
            todo = defaultdict(list)
            for key, (lat, lon, radius) in requests.items():
                row = cache.get(key)
                if dem_id == "glo30":
                    needed = row is None
                else:
                    needed = row is not None and row["status"] == "no-tile" and row["dem"] == "glo30"
                if needed:
                    todo[tile_name(lat, lon, dem_id)].append((key, lat, lon, radius))
            if not todo:
                continue
            print(f"sampling {sum(map(len, todo.values()))} points in {len(todo)} {dem_id} tiles", flush=True)
            failed = 0
            pool = ThreadPoolExecutor(THREADS)
            try:
                jobs = {pool.submit(sample_tile, dem_id, n, pts): n for n, pts in todo.items()}
                for i, job in enumerate(as_completed(jobs), 1):
                    try:
                        result = job.result()
                    except Exception as e:
                        failed += 1
                        print(f"  {jobs[job]}: {e}", file=sys.stderr)
                        continue
                    for k, (status, elev, spread) in result.items():
                        row = {"key": k, "status": status, "elev": "" if elev is None else elev,
                               "spread": "" if spread is None else spread, "dem": dem_id,
                               "tile": jobs[job], "sampled": today}
                        cache[k] = row
                        out.writerow([row[c] for c in CACHE_COLUMNS])
                    f.flush()
                    if i % 100 == 0 or i == len(jobs):
                        print(f"  {i}/{len(jobs)} tiles", file=sys.stderr, flush=True)
            finally:
                pool.shutdown(wait=True, cancel_futures=True)
            if failed:
                print(f"  {failed} tiles failed; their points are retried on the next run", file=sys.stderr)
    return cache


def ellipsoidal_heights(points):
    """EGM2008 heights to WGS84 ellipsoidal heights (GeoJSON z, RFC 7946).

    points: [(lon, lat, h)] -> [h_ellipsoid]. Needs the EGM2008 grid, which
    pyproj fetches from the PROJ CDN on first use.
    """
    import pyproj

    pyproj.network.set_network_enabled(True)
    t = pyproj.Transformer.from_crs("EPSG:9518", "EPSG:4979", always_xy=True)
    lons, lats, hs = zip(*points)
    _, _, z = t.transform(lons, lats, hs)
    if any(math.isinf(v) or math.isnan(v) for v in z):
        raise RuntimeError("EGM2008 grid not available; check network access to cdn.proj.org")
    return [round(v, 2) for v in z]


# --- import ------------------------------------------------------------------

def download(refresh):
    if RAW.exists() and not refresh:
        return
    RAW.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {PLEIADES_URL}")
    urllib.request.urlretrieve(PLEIADES_URL, RAW)


def category_of(types):
    for name, members in CATEGORIES:
        if members & set(types):
            return name
    return "other"


def is_modern(location):
    return bool(MODERN_LOCATION_TYPES & set(location.get("locationType") or []))


def names_of(place):
    names = []
    for n in place.get("names") or []:
        for v in (n.get("romanized") or "").split(","):
            v = v.strip()
            if v and v not in names:
                names.append(v)
        v = (n.get("attested") or "").strip()
        if v and v not in names:
            names.append(v)
    return names


def is_osm(location):
    """Location geometry copied from OpenStreetMap, which is ODbL (PRD §8)."""
    if "openstreetmap" in (location.get("provenance") or "").lower():
        return True
    if (location.get("title") or "").startswith("OSM"):
        return True
    if "osm" in (location.get("accuracy") or "").lower():
        return True
    return any("openstreetmap.org" in (r.get("accessURI") or "")
               for r in location.get("references") or [])


def licence_of(place):
    rights = (place.get("rights") or "").lower()
    return "CC BY-SA 3.0" if "cc-by-sa" in rights else "CC BY 3.0"


def centroid(geom):
    pts = coords_of(geom)
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def location_precision(location):
    """Accuracy of one location in metres: stated, or half its extent.

    For uncertainty areas (grid boxes) the box itself is the precision, even
    when an accuracy is stated (TAVO cells say 1524 m but span 0.5°).
    """
    half = extent_m(coords_of(location["geometry"])) / 2
    if location.get("accuracy_value") is not None:
        stated = float(location["accuracy_value"])
        return round(max(stated, half)) if is_uncertainty_area(location) else stated
    return round(half) if half > 0 else None


def is_rectangle(geom):
    if geom["type"] != "Polygon" or len(geom["coordinates"]) != 1:
        return False
    ring = geom["coordinates"][0]
    xs = {round(p[0], 6) for p in ring}
    ys = {round(p[1], 6) for p in ring}
    return len(ring) == 5 and len(xs) == 2 and len(ys) == 2


def is_uncertainty_area(location):
    """A box marking where a place lies (Barrington map grid, TAVO cell),
    not the site's footprint."""
    g = location.get("geometry") or {}
    lid = (location.get("id") or "").lower()
    title = (location.get("title") or "").lower()
    prov = (location.get("provenance") or "").lower()
    if "undetermined" in lid or "undetermined" in title or lid.startswith("gane-location"):
        return True
    return is_rectangle(g) and (location.get("accuracy_value") is None or "barrington" in prov or "tavo" in prov)


def is_label(location):
    """The curve an atlas label is drawn along, not a feature."""
    return "label" in (location.get("id") or "").lower()


def is_outline(location):
    """Geometry that describes the site itself (usable for size and LOD 0)."""
    return not is_uncertainty_area(location) and not is_label(location)


def time_rule_of(time, source):
    if time is None:
        return "pleiades: no attested period"
    rule = f"pleiades: {source} attestations"
    rule += "" if time["basis"] == "confident" else ", none confident"
    rule += "; period attribution" if time["level"] == 3 else "; inferred or less confident"
    return rule


def public_precision(h_precision):
    if h_precision is not None:
        return h_precision, "source publishes coordinates openly; published at source precision"
    return UNKNOWN_PUBLICATION_M, (f"accuracy unknown; published to {UNKNOWN_PUBLICATION_M / 1000:g} km "
                                   "until a precision is known")


def read_places():
    """Stream places from the dump one at a time, to keep memory low."""
    import ijson

    with gzip.open(RAW, "rb") as f:
        yield from ijson.items(f, "@graph.item", use_float=True)


def build(places, present_he):
    """places: a callable returning a fresh iterator over Pleiades places."""
    ranges, inbound = first_pass(places())
    sites, shapes, skipped = [], [], Counter()
    count = 0

    for p in places():
        count += 1
        types = [t for t in p.get("placeTypes") or [] if t]
        if set(types) & FALSE_TYPES:
            skipped["false or fictional"] += 1
            continue
        # Dropped when typed as a non-site and nothing more specific; generic
        # types alone (e.g. "unknown") keep a place, they cannot rescue one.
        if set(types) & NON_SITE_TYPES and not set(types) - NON_SITE_TYPES - GENERIC_TYPES:
            skipped["not a site: " + "/".join(sorted(types))] += 1
            continue
        if not p.get("reprPoint"):
            skipped["no coordinates"] += 1
            continue

        pid = p["id"]
        site_id = f"pleiades:{pid}"
        uri = p.get("uri") or f"https://pleiades.stoa.org/places/{pid}"
        lon, lat = (round(v, 7) for v in p["reprPoint"][:2])
        licence = licence_of(p)

        locations = p.get("locations") or []
        located = [l for l in locations if l.get("geometry")]
        ancient_located = [l for l in located if not is_modern(l)]
        ancient = ancient_located or located

        # position: the published point is Pleiades' reprPoint. With several
        # locations it is their midpoint, so its precision includes the
        # distance to the farthest location as well as that location's own
        # accuracy.
        precisions = [location_precision(l) for l in ancient]
        offset = max((haversine_m((lon, lat), centroid(l["geometry"])) for l in ancient), default=0.0)
        if ancient and None not in precisions:
            h_precision = round(max(precisions) + offset)
        else:
            h_precision = None
        pos_level, pos_rule = position_level(h_precision, bool(located))
        if offset > 10000 and pos_level > 1:
            pos_level, pos_rule = 1, "pleiades: point is a midpoint of locations more than 10 km apart"
        if located and not ancient_located and pos_level > 2:
            pos_level, pos_rule = 2, "pleiades: only modern locations; ancient position not recorded"
        pub_m, pub_rule = public_precision(h_precision)

        # time: ancient locations first, then ancient names
        time = time_bounds([l for l in locations if not is_modern(l)], ranges, present_he)
        time_rule = time_rule_of(time, "location")
        if time is None:
            ancient_names = [n for n in p.get("names") or []
                             if "modern" not in (n.get("nameType") or "")]
            time = time_bounds(ancient_names, ranges, present_he)
            time_rule = time_rule_of(time, "name")
            if time and time["level"] > 2:
                time["level"] = 2
                time_rule += "; capped at 2: dated from names only"
        if time is None:
            time = {"status": "not-entered", "start": None, "end": None,
                    "ongoing": None, "periods": [], "level": 0, "basis": None}
        time_level = time.pop("level")
        time.pop("basis")

        # size
        geoms = [l["geometry"] for l in ancient if is_outline(l)]
        pts = [pt for g in geoms for pt in coords_of(g)]
        size = {
            "area_m2": round(max((area_m2(g) for g in geoms), default=0.0)) or None,
            "length_m": round(max((length_m(g) for g in geoms), default=0.0)) or None,
            "extent_m": round(extent_m(pts)) or None,
            "rule": "largest polygon area and longest line among ancient locations; "
                    "extent is the diagonal of their bounding box",
        }

        id_level, id_rule = identity_level(ancient or locations, types, p.get("names") or [])

        odbl = any(is_osm(l) for l in ancient)
        geo_source = "pleiades (OpenStreetMap-derived, ODbL)" if odbl else "pleiades"

        sites.append({
            "id": site_id,
            "name": p.get("title"),
            "names": names_of(p),
            "category": category_of(types),
            "place_types": types,
            "lon": lon,
            "lat": lat,
            "position": {
                "horizontal_precision_m": h_precision,
                "publication_precision_m": pub_m,
                "publication_rule": pub_rule,
            },
            "time": time,
            "size": size,
            "confidence": {
                "identity": {"level": id_level, "rule": id_rule},
                "position": {"level": pos_level, "rule": pos_rule},
                "time": {"level": time_level, "rule": time_rule},
            },
            "view": dict(zip(("km", "rule"), view_distance(types, category_of(types), inbound[pid])),
                         inbound_links=inbound[pid]),
            "remains": sorted({l.get("archaeologicalRemains") for l in ancient
                               if l.get("archaeologicalRemains")}),
            "shape_count": sum(1 for l in located if is_outline(l)),
            "licence": [licence] + (["ODbL 1.0"] if odbl else []),
            "odbl": odbl,
            "provenance": {
                "identity": "pleiades", "name": "pleiades", "category": "pleiades",
                "time": "pleiades", "position": geo_source, "size": geo_source,
            },
            "record": uri,
        })

        for l in (x for x in located if is_outline(x)):
            lt = time_bounds([l], ranges, present_he)
            l_prec = location_precision(l)
            l_pos, l_pos_rule = position_level(l_prec, True)
            l_id = ASSOCIATION_LEVEL.get(l.get("associationCertainty"), 2)
            l_pub, l_pub_rule = public_precision(l_prec)
            osm = is_osm(l)
            shapes.append({
                "type": "Feature",
                "id": f"{site_id}/{l['id']}",
                "geometry": l["geometry"],
                "properties": {
                    "site": site_id,
                    # Outline shapes are the most distant LOD; scans and splats
                    # take over closer in.
                    "lod": 0,
                    "title": l.get("title"),
                    "location_types": [t for t in l.get("locationType") or [] if t],
                    "feature_types": [t for t in l.get("featureType") or [] if t],
                    "modern": is_modern(l),
                    "start": lt and lt["start"],
                    "end": lt and lt["end"],
                    "ongoing": lt and lt["ongoing"],
                    "time_status": "dated" if lt else "not-entered",
                    "periods": unique_ids(lt["periods"]) if lt else [],
                    "horizontal_precision_m": l_prec,
                    "publication_precision_m": l_pub,
                    "publication_rule": l_pub_rule,
                    "confidence": {
                        "identity": {"level": l_id, "rule": f"pleiades: location association "
                                                            f"{l.get('associationCertainty') or 'not stated'}"},
                        "position": {"level": l_pos, "rule": l_pos_rule},
                        "time": {"level": lt["level"] if lt else 0,
                                 "rule": time_rule_of(lt, "location")},
                    },
                    "remains": l.get("archaeologicalRemains"),
                    "area_m2": round(area_m2(l["geometry"])) or None,
                    "length_m": round(length_m(l["geometry"])) or None,
                    "source": "pleiades",
                    "record": l.get("uri"),
                    "upstream": l.get("provenance") or "",
                    "licence": [licence] + (["ODbL 1.0"] if osm else []),
                    "odbl": osm,
                },
            })
    return sites, shapes, skipped, ranges, count


def unique_ids(periods):
    ids = []
    for x in periods:
        if x["id"] not in ids:
            ids.append(x["id"])
    return ids


def add_elevation(sites, today):
    requests = {}
    for s in sites:
        h = s["position"]["horizontal_precision_m"]
        radius = min(h or 0.0, MAX_WINDOW_M)
        key = f"{s['lat']},{s['lon']},{radius:g}"
        requests[key] = (s["lat"], s["lon"], radius)
        s["_elev"] = (key, radius)
    cache = sample_elevations(requests, today)

    for s in sites:
        key, radius = s.pop("_elev")
        row = cache.get(key)
        pos_level = s["confidence"]["position"]["level"]
        status = row["status"] if row else "not-sampled"
        if status != "ok":
            reason = {
                "sea": "the point lies on open water in the DEM (submerged site or misplaced point)",
                "no-tile": "no Copernicus DEM tile covers the point",
                "not-sampled": "DEM sampling failed; retried on the next run",
            }[status]
            s["elevation"] = {"value_m": None, "ellipsoidal_m": None, "status": status,
                              "vertical_precision_m": None, "surface": None, "datum": "EGM2008",
                              "rule": reason}
            s["confidence"]["elevation"] = {"level": 0, "rule": f"{row['dem'] if row else 'glo30'}: {reason}"}
            continue

        dem = row["dem"]
        label = DEM_LABEL[dem]
        h = s["position"]["horizontal_precision_m"]
        if h is None:
            v_prec = None
            prec_rule = "vertical precision unknown because the horizontal precision is unknown"
        else:
            v_prec = round(max(DEM_VERTICAL_M[dem], float(row["spread"] or 0)), 1)
            prec_rule = (f"precision is the larger of {DEM_VERTICAL_M[dem]:g} m and the elevation "
                         f"spread within {radius:g} m")
            if h > MAX_WINDOW_M:
                prec_rule += f" (a lower bound: horizontal precision is {h:g} m)"
        s["elevation"] = {
            "value_m": float(row["elev"]),
            "ellipsoidal_m": None,
            "status": "dem",
            "vertical_precision_m": v_prec,
            "surface": "modern",
            "model": "DSM: includes buildings and vegetation",
            "datum": "EGM2008",
            "rule": f"{label} at the point; {prec_rule}",
        }
        s["_dem"] = row
        cap = 3 if h is not None else 2
        level = min(cap, pos_level)
        rule = f"{dem}: surface model of today's terrain, capped at 3"
        if h is None:
            rule += "; 2 while the horizontal precision is unknown"
        if level < cap:
            rule += f"; limited by position level {pos_level}"
        s["confidence"]["elevation"] = {"level": level, "rule": rule}

    with_value = [s for s in sites if s["elevation"]["value_m"] is not None]
    zs = ellipsoidal_heights([(s["lon"], s["lat"], s["elevation"]["value_m"]) for s in with_value])
    for s, z in zip(with_value, zs):
        s["elevation"]["ellipsoidal_m"] = z


def finish(sites, retrieved):
    for s in sites:
        c = s["confidence"]
        c["overall"] = min(c[a]["level"] for a in ("identity", "position", "elevation", "time"))
        s["sources"] = [{"source": "pleiades", "record": s.pop("record"), "retrieved": retrieved,
                         "licence": s["licence"][0]}]
        dem = s.pop("_dem", None)
        s["provenance"]["elevation"] = dem and dem["dem"]
        if dem:
            s["sources"].append({"source": dem["dem"], "record": dem["tile"] or None,
                                 "retrieved": dem["sampled"], "licence": SOURCES[dem["dem"]]["licence"]})


def write(sites, shapes, meta):
    OUT.mkdir(parents=True, exist_ok=True)

    features = []
    for s in sites:
        e = s["elevation"]
        coords = [s["lon"], s["lat"]]
        if e["ellipsoidal_m"] is not None:
            # RFC 7946: z is the height above the WGS84 ellipsoid.
            coords.append(e["ellipsoidal_m"])
        props = {k: v for k, v in s.items() if k not in ("lon", "lat")}
        features.append({"type": "Feature", "id": s["id"],
                         "geometry": {"type": "Point", "coordinates": coords},
                         "properties": props})
    for name, feats in (("pleiades-sites", features), ("pleiades-shapes", shapes)):
        with open(OUT / f"{name}.geojson", "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "metadata": meta, "features": feats},
                      f, ensure_ascii=False, separators=(",", ":"))

    columns = [
        "id", "name", "category", "lon", "lat",
        "elev_m", "elev_ellipsoidal_m", "elev_status", "elev_surface", "elev_datum", "vertical_precision_m",
        "horizontal_precision_m", "publication_precision_m",
        "start", "end", "ongoing", "time_status",
        "conf_identity", "conf_position", "conf_elevation", "conf_time", "conf_overall",
        "rule_identity", "rule_position", "rule_elevation", "rule_time",
        "area_m2", "length_m", "extent_m", "view_km", "inbound_links", "place_types", "periods",
        "licence", "odbl", "record",
    ]
    with open(OUT / "pleiades-sites.csv", "w", encoding="utf-8", newline="") as f:
        out = csv.writer(f)
        out.writerow(columns)
        for s in sites:
            t, c, e = s["time"], s["confidence"], s["elevation"]
            out.writerow([
                s["id"], s["name"], s["category"], s["lon"], s["lat"],
                e["value_m"], e["ellipsoidal_m"], e["status"], e["surface"], e["datum"],
                e["vertical_precision_m"],
                s["position"]["horizontal_precision_m"], s["position"]["publication_precision_m"],
                t["start"], t["end"], t["ongoing"], t["status"],
                c["identity"]["level"], c["position"]["level"], c["elevation"]["level"],
                c["time"]["level"], c["overall"],
                c["identity"]["rule"], c["position"]["rule"], c["elevation"]["rule"], c["time"]["rule"],
                s["size"]["area_m2"], s["size"]["length_m"], s["size"]["extent_m"],
                s["view"]["km"], s["view"]["inbound_links"],
                "|".join(s["place_types"]), "|".join(unique_ids(t["periods"])),
                "|".join(s["licence"]), s["odbl"], s["sources"][0]["record"],
            ])
    with open(OUT / "ATTRIBUTION.md", "w", encoding="utf-8") as f:
        f.write("# Attribution\n\nBuilt by scripts/pleiades.py on " + meta["built"] + ".\n\n")
        for src in meta["sources"].values():
            f.write(f"- **{src['name']}** ({src['url']}): {src['licence']}. {src['attribution']}\n")
        f.write("- Sites and shapes with `odbl: true` contain geometry from OpenStreetMap "
                "(c) OpenStreetMap contributors, ODbL 1.0.\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--refresh", action="store_true", help="download the latest Pleiades dump")
    args = parser.parse_args()

    download(args.refresh)
    today = datetime.date.today()
    present_he = today.year + 10000
    retrieved = datetime.date.fromtimestamp(RAW.stat().st_mtime).isoformat()

    sites, shapes, skipped, ranges, count = build(read_places, present_he)
    add_elevation(sites, today.isoformat())
    finish(sites, retrieved)

    meta = {
        "calendar": "Holocene: HE = astronomical year + 10000",
        "coordinates": "WGS84; Point z is the height above the WGS84 ellipsoid (RFC 7946)",
        "elevation": "properties.elevation.value_m: metres above the EGM2008 geoid, from the "
                     "Copernicus DEM (a surface model of today's terrain, GLO-30, GLO-90 where "
                     "GLO-30 has no tile)",
        "confidence": "levels 0-5 per axis, PRD section 6.7; overall is the lowest axis",
        "sources": SOURCES,
        "retrieved": retrieved,
        "built": today.isoformat(),
    }
    write(sites, shapes, meta)

    dated = sum(s["time"]["status"] == "dated" for s in sites)
    with_elev = sum(s["elevation"]["value_m"] is not None for s in sites)
    print(f"{count} places -> {len(sites)} sites ({dated} dated, {with_elev} with elevation), "
          f"{len(shapes)} shapes, {len(ranges)} period ranges known")
    print("skipped:", sum(skipped.values()))
    for reason, n in skipped.most_common(12):
        print(f"  {n:6d}  {reason}")
    levels = Counter(s["confidence"]["overall"] for s in sites)
    print("overall confidence:", dict(sorted(levels.items())))
    print("categories:", dict(Counter(s["category"] for s in sites).most_common()))


if __name__ == "__main__":
    main()
