"""Export sites and outline shapes for the web viewer.

Reads data/sites/pleiades-sites.geojson and pleiades-shapes.geojson (from
scripts/pleiades.py) as streams and writes:

- web/public/data/sites.json: compact site table for the viewer
- web/public/data/shapes/{lat}_{lon}.json: outline shapes (LOD 0) per 1° cell,
  with heights sampled from the terrain tiles (scripts/build_terrain.py)
- web/public/data/coverage.json: site counts per country and per period (D5)
- web/public/downloads/: the open export with attribution (D6)

Publication precision (PRD §7.8 P1): where a site's publication precision is
coarser than its known precision, its public coordinates are snapped to the
centre of a grid cell of that size, and its shapes are left out, so no public
file holds a more precise location. Heights are metres above the WGS84
ellipsoid; years are HE.

Usage: python scripts/export_sites.py
"""

import csv
import gzip
import json
import math
import shutil
from collections import Counter, OrderedDict, defaultdict
from pathlib import Path

import ijson
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SITES = ROOT / "data" / "sites" / "pleiades-sites.geojson"
SHAPES = ROOT / "data" / "sites" / "pleiades-shapes.geojson"
CSV = ROOT / "data" / "sites" / "pleiades-sites.csv"
COUNTRIES = ROOT / "data" / "raw" / "naturalearth" / "ne_50m_admin_0_countries.geojson"
TILES = ROOT / "web" / "public" / "tiles" / "terrain"
OUT = ROOT / "web" / "public" / "data"
DOWNLOADS = ROOT / "web" / "public" / "downloads"

FIELDS = ["id", "name", "lon", "lat", "h", "start", "end", "category", "confidence", "precision",
          "view_km", "names", "periods", "country", "conf_identity", "conf_position",
          "conf_elevation", "conf_time", "has_shapes", "degraded", "source", "qid", "wikipedia"]
WD_LINKS = ROOT / "data" / "sites" / "wikidata-links.csv"
WD_SITES = ROOT / "data" / "sites" / "wikidata-sites.json"
AXES = ("identity", "position", "elevation", "time")
MAX_AREA_M2 = 20e6    # larger polygons are not site outlines
MAX_LENGTH_M = 300e3  # longer lines are routes across regions
M_PER_DEG = 111320.0


# --- countries -------------------------------------------------------------------

class Countries:
    """Point in polygon against Natural Earth admin-0 (public domain)."""

    def __init__(self):
        data = json.loads(COUNTRIES.read_text(encoding="utf-8"))
        self.polys = []  # (name, bbox, rings)
        for f in data["features"]:
            name = f["properties"].get("NAME_EN") or f["properties"]["NAME"]
            g = f["geometry"]
            polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
            for poly in polys:
                rings = [np.asarray(r, dtype=np.float64) for r in poly]
                outer = rings[0]
                bbox = (outer[:, 0].min(), outer[:, 1].min(), outer[:, 0].max(), outer[:, 1].max())
                self.polys.append((name, bbox, rings))

    @staticmethod
    def inside(ring, x, y):
        xs, ys = ring[:, 0], ring[:, 1]
        xj, yj = np.roll(xs, 1), np.roll(ys, 1)
        cross = ((ys > y) != (yj > y)) & (x < (xj - xs) * (y - ys) / np.where(yj - ys == 0, 1e-12, yj - ys) + xs)
        return bool(cross.sum() % 2)

    def of(self, lon, lat):
        best, best_d = None, 0.5  # within ~50 km of a coast counts (islands, harbours)
        for name, (w, s, e, n), rings in self.polys:
            if w - 0.5 <= lon <= e + 0.5 and s - 0.5 <= lat <= n + 0.5:
                if w <= lon <= e and s <= lat <= n and self.inside(rings[0], lon, lat) \
                        and not any(self.inside(h, lon, lat) for h in rings[1:]):
                    return name
                # nearest polygon vertex as a fallback for points just offshore
                d = np.min(np.hypot(rings[0][:, 0] - lon, rings[0][:, 1] - lat))
                if d < best_d:
                    best, best_d = name, d
        return best


# --- terrain heights -------------------------------------------------------------

class TerrainHeights:
    """Samples the built terrain tiles at the finest level available."""

    def __init__(self):
        meta = json.loads((TILES / "regions.json").read_text(encoding="utf-8"))
        self.n = meta["samples"]
        self.max_global = meta["maxGlobal"]
        self.regions = meta["regions"]
        self.cache = OrderedDict()

    def level(self, lon, lat):
        z = self.max_global
        for r in self.regions:
            w, s, e, n = r["bbox"]
            if w <= lon <= e and s <= lat <= n:
                z = max(z, r["maxLevel"])
        return z

    def tile(self, z, x, y):
        key = (z, x, y)
        if key not in self.cache:
            path = TILES / str(z) / str(x) / f"{y}.hgt"
            d = np.frombuffer(gzip.decompress(path.read_bytes()), "<i4")
            self.cache[key] = (np.cumsum(d) / 10.0).reshape(self.n, self.n)
            if len(self.cache) > 64:
                self.cache.popitem(last=False)
        self.cache.move_to_end(key)
        return self.cache[key]

    def sample(self, lon, lat):
        z = self.level(lon, lat)
        while True:
            span = 180.0 / 2 ** z
            x, y = int((lon + 180) // span), int((90 - lat) // span)
            if (TILES / str(z) / str(x) / f"{y}.hgt").exists() or z == 0:
                break
            z -= 1
        h = self.tile(z, x, y)
        w, n = -180 + x * span, 90 - y * span
        c = (lon - w) / span * (self.n - 1)
        r = (n - lat) / span * (self.n - 1)
        c0, r0 = min(int(c), self.n - 2), min(int(r), self.n - 2)
        fc, fr = c - c0, r - r0
        return float(h[r0, c0] * (1 - fr) * (1 - fc) + h[r0, c0 + 1] * (1 - fr) * fc
                     + h[r0 + 1, c0] * fr * (1 - fc) + h[r0 + 1, c0 + 1] * fr * fc)


# --- export ------------------------------------------------------------------

def degrade(lon, lat, precision_m):
    """Snap to the centre of a grid cell of the publication precision."""
    step_lat = precision_m / M_PER_DEG
    step_lon = precision_m / (M_PER_DEG * max(math.cos(math.radians(lat)), 0.05))
    return (round((math.floor(lon / step_lon) + 0.5) * step_lon, 6),
            round((math.floor(lat / step_lat) + 0.5) * step_lat, 6))


def stream(path):
    with open(path, "rb") as f:
        yield from ijson.items(f, "features.item", use_float=True)


def main():
    countries = Countries()
    heights = TerrainHeights()
    links = {}
    if WD_LINKS.exists():
        with open(WD_LINKS, encoding="utf-8", newline="") as f:
            links = {r["pleiades"]: r for r in csv.DictReader(f)}
    OUT.mkdir(parents=True, exist_ok=True)

    categories, period_ids, period_ranges = [], [], {}
    rows, hidden_shapes = [], set()
    by_country, by_period = Counter(), Counter()
    with_shapes = set()

    # Shapes first, to know which sites have them.
    shape_sites = set()
    for f in stream(SHAPES):
        pr = f["properties"]
        if f["geometry"]["type"] != "Point" and (pr.get("area_m2") or 0) <= MAX_AREA_M2                 and (pr.get("length_m") or 0) <= MAX_LENGTH_M:
            shape_sites.add(pr["site"])

    for f in stream(SITES):
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        pos = p["position"]
        pub = pos["publication_precision_m"]
        known = pos["horizontal_precision_m"]
        degraded = pub is not None and (known is None or pub > known) and pub > 50
        if degraded:
            lon, lat = degrade(lon, lat, pub)
            hidden_shapes.add(f["id"])
        if p["category"] not in categories:
            categories.append(p["category"])
        t = p["time"]
        pids = []
        for per in t["periods"]:
            if per["id"] not in period_ids:
                period_ids.append(per["id"])
            i = period_ids.index(per["id"])
            if i not in pids:
                pids.append(i)
            lo, hi = period_ranges.get(per["id"], (per["earliest"], per["latest"]))
            period_ranges[per["id"]] = (min(lo, per["earliest"]), max(hi, per["latest"]))
            by_period[per["id"]] += 1
        country = countries.of(lon, lat) or "unknown"
        by_country[country] += 1
        c = p["confidence"]
        has = f["id"] in shape_sites and not degraded
        if has:
            with_shapes.add(f["id"])
        rows.append([
            f["id"].split(":")[1], p["name"], round(lon, 6), round(lat, 6),
            p["elevation"]["ellipsoidal_m"], t["start"], t["end"],
            categories.index(p["category"]), c["overall"], pub, p["view"]["km"],
            "|".join(n for n in p["names"] if n != p["name"])[:300], pids, country,
            *(c[a]["level"] for a in AXES), int(has), int(degraded), "pleiades",
            links.get(f["id"].split(":")[1], {}).get("qid", ""),
            links.get(f["id"].split(":")[1], {}).get("wikipedia", "").rsplit("/", 1)[-1],
        ])

    # Sites only in Wikidata (D2): own provenance; identity 2 (crowd-sourced,
    # not reviewed), position from Wikidata's coordinate precision, elevation
    # from the terrain tiles (capped by position), time not entered.
    wd_count = 0
    if WD_SITES.exists():
        if "site" not in categories:
            categories.append("site")
        for it in json.loads(WD_SITES.read_text(encoding="utf-8")):
            lon, lat, prec = it["lon"], it["lat"], it.get("precision_m")
            pos = 3 if prec is not None and prec <= 1000 else 2 if prec is not None and prec <= 10000 else 1 if prec else 2
            pub = prec if prec is not None else 10000
            degraded = prec is None
            if degraded:
                lon, lat = degrade(lon, lat, pub)
            country = countries.of(lon, lat) or "unknown"
            by_country[country] += 1
            h = round(heights.sample(lon, lat), 1)
            levels = [2, pos, min(2, pos), 0]
            rows.append([it["qid"], it["name"], round(lon, 6), round(lat, 6), h, None, None,
                         categories.index("site"), min(levels), pub, 20, "", [], country, *levels,
                         0, int(degraded), "wikidata", it["qid"], it.get("wikipedia", "").rsplit("/", 1)[-1]])
            wd_count += 1
    print(f"{len(links)} Pleiades sites linked to Wikidata, {wd_count} sites only in Wikidata")

    countries_list = sorted({r[13] for r in rows})
    for r in rows:
        r[13] = countries_list.index(r[13])
    periods = [{"id": pid, "start": period_ranges[pid][0], "end": period_ranges[pid][1],
                "label": pid.replace("-", " ")} for pid in period_ids]
    with open(OUT / "sites.json", "w", encoding="utf-8") as f:
        json.dump({"fields": FIELDS, "categories": categories, "countries": countries_list,
                   "periods": periods, "rows": rows}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(rows)} sites -> sites.json ({(OUT / 'sites.json').stat().st_size // 1024} KB), "
          f"{len(hidden_shapes)} at reduced publication precision")

    # Shapes per 1° cell, with terrain heights per vertex.
    cells = defaultdict(list)
    site_pos = {f"pleiades:{r[0]}": (r[2], r[3]) for r in rows if r[20] == "pleiades"}
    for f in stream(SHAPES):
        p = f["properties"]
        g = f["geometry"]
        if g["type"] == "Point" or p["site"] not in with_shapes:
            continue
        # Not site outlines: map-sheet areas standing in for rough locations,
        # whole regions, long routes.
        if (p.get("area_m2") or 0) > MAX_AREA_M2 or (p.get("length_m") or 0) > MAX_LENGTH_M:
            continue
        lift = lambda ring: [[round(x, 6), round(y, 6), round(heights.sample(x, y), 1)] for x, y, *_ in ring]
        if g["type"] in ("LineString",):
            parts, kind = [lift(g["coordinates"])], "L"
        elif g["type"] == "MultiLineString":
            parts, kind = [lift(l) for l in g["coordinates"]], "L"
        elif g["type"] == "Polygon":
            parts, kind = [[lift(r) for r in g["coordinates"]]], "P"
        elif g["type"] == "MultiPolygon":
            parts, kind = [[lift(r) for r in poly] for poly in g["coordinates"]], "P"
        else:
            continue
        slon, slat = site_pos[p["site"]]
        cells[(math.floor(slat), math.floor(slon))].append({
            "site": p["site"].split(":")[1], "kind": kind, "start": p["start"], "end": p["end"],
            "modern": p["modern"], "conf": p["confidence"]["position"]["level"], "parts": parts,
        })
    shapes_dir = OUT / "shapes"
    if shapes_dir.exists():
        shutil.rmtree(shapes_dir)
    shapes_dir.mkdir(parents=True)
    for (lat, lon), shapes in cells.items():
        with open(shapes_dir / f"{lat}_{lon}.json", "w", encoding="utf-8") as f:
            json.dump(shapes, f, separators=(",", ":"))
    (shapes_dir / "index.json").write_text(json.dumps(sorted(f"{a}_{b}" for a, b in cells)), encoding="utf-8")
    print(f"{sum(map(len, cells.values()))} shapes in {len(cells)} cells -> shapes/")

    # Coverage report (D5).
    coverage = {
        "sites": len(rows),
        "by_country": dict(by_country.most_common()),
        "by_period": [{"id": pid, "start": period_ranges[pid][0], "end": period_ranges[pid][1],
                       "sites": by_period[pid]} for pid in sorted(period_ids, key=lambda i: period_ranges[i])],
        "dated": sum(1 for r in rows if r[5] is not None),
        "with_elevation": sum(1 for r in rows if r[4] is not None),
        "with_shapes": len(with_shapes),
    }
    (OUT / "coverage.json").write_text(json.dumps(coverage, ensure_ascii=False, indent=1), encoding="utf-8")

    # Open export with attribution (D6): the public site table and its licences.
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    with open(CSV, encoding="utf-8", newline="") as src, \
            gzip.open(DOWNLOADS / "atlas-antiqua-sites.csv.gz", "wt", encoding="utf-8", newline="") as dst:
        reader = csv.DictReader(src)
        public = [c for c in reader.fieldnames if c not in ("vertical_precision_m",)]
        out = csv.DictWriter(dst, fieldnames=public, extrasaction="ignore")
        out.writeheader()
        degraded = {f"pleiades:{r[0]}": (r[2], r[3]) for r in rows if r[19] and r[20] == "pleiades"}
        for r in reader:
            if r["id"] in degraded:
                r["lon"], r["lat"] = degraded[r["id"]]
                r["elev_m"] = r["elev_ellipsoidal_m"] = ""
            out.writerow(r)
    shutil.copy(ROOT / "data" / "sites" / "ATTRIBUTION.md", DOWNLOADS / "ATTRIBUTION.md")
    print("coverage.json and downloads/ written")


if __name__ == "__main__":
    main()
