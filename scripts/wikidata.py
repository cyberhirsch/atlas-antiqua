"""Wikidata as a second source, merged with Pleiades (PRD D2).

1. Items with a Pleiades ID (P1584) are linked to that site: Wikidata ID,
   English Wikipedia article and image are added.
2. Archaeological sites (instances of Q839954 or its subclasses) with
   coordinates in the Pleiades region and no Pleiades ID are matched to the
   nearest Pleiades site by distance and name:
   - within 1 km and name similarity >= 0.8: linked automatically
   - within 1 km and similarity 0.5-0.8, or same name within 5 km: listed
     for manual review (data/sites/merge-review.csv), kept separate meanwhile
   - otherwise: a new site, with its own provenance and confidence
Wikidata is CC0.

Writes data/sites/wikidata-links.csv, wikidata-sites.json and merge-review.csv.

Usage: python scripts/wikidata.py [--refresh]
"""

import argparse
import csv
import difflib
import json
import math
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITES_CSV = ROOT / "data" / "sites" / "pleiades-sites.csv"
CACHE = ROOT / "data" / "raw" / "wikidata"
OUT = ROOT / "data" / "sites"
ENDPOINT = "https://query.wikidata.org/sparql"
AGENT = "AtlasAntiqua/0.1 (https://github.com/cyberhirsch/atlas-antiqua)"
REGION = (-10, 25, 45, 55)  # lon/lat box of the Pleiades data, queried in 5° tiles
LANGS = "en,mul,de,fr,it,es,el,tr,ar,bg,hr,sr,pt"
MIN_TILE = 0.15625  # smallest tile (degrees) a timed-out region is split into

Q_PLEIADES = f"""
SELECT ?item ?pleiades ?label ?article ?image WHERE {{
  ?item wdt:P1584 ?pleiades .
  OPTIONAL {{ ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }}
  OPTIONAL {{ ?item wdt:P18 ?image . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "{LANGS}". ?item rdfs:label ?label . }}
}}"""

Q_SITES = """
SELECT ?item ?label ?coord ?precision ?article ?inception WHERE {{
  SERVICE wikibase:box {{
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point({w} {s})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point({e} {n})"^^geo:wktLiteral .
  }}
  ?item wdt:P31/wdt:P279* wd:Q839954 .
  FILTER NOT EXISTS {{ ?item wdt:P1584 [] }}
  OPTIONAL {{ ?item p:P625/psv:P625/wikibase:geoPrecision ?precision . }}
  OPTIONAL {{ ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }}
  OPTIONAL {{ ?item wdt:P571 ?inception . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "{langs}". ?item rdfs:label ?label . }}
}}"""


def sparql(query: str, cache: Path, refresh: bool, attempts: int = 4) -> list[dict]:
    if cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    for attempt in range(attempts):
        req = urllib.request.Request(ENDPOINT, data=urllib.parse.urlencode({"query": query}).encode(),
                                     headers={"User-Agent": AGENT, "Accept": "application/sparql-results+json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                rows = [{k: v["value"] for k, v in b.items()} for b in json.load(r)["results"]["bindings"]]
            cache.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache.with_suffix(".tmp")
            tmp.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
            tmp.replace(cache)  # never leave a half-written cache file
            time.sleep(1)  # be polite to the public endpoint
            return rows
        except Exception as e:  # noqa: BLE001 - retried, then reported
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"query failed: {cache.name}")


def fold(s: str) -> str:
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", s).strip()


def similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, fold(a), fold(b)).ratio()


def auto_decision(wd_name: str, pl_name: str, distance: float, sim: float) -> str:
    """First-pass review rules; manual decisions in merge-review.csv win."""
    if (fold(wd_name) == fold(pl_name) and distance <= 5000) or (distance <= 500 and sim >= 0.65):
        return "same (auto: name equal within 5 km, or <= 500 m and similarity >= 0.65)"
    if sim < 0.55 and distance > 300:
        return "different (auto: similarity < 0.55 and > 300 m apart)"
    return ""


def metres(lon1, lat1, lon2, lat2) -> float:
    x = (lon2 - lon1) * 111320 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(x, (lat2 - lat1) * 111320)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", action="store_true", help="query Wikidata again instead of using the cache")
    args = ap.parse_args()

    # Pleiades sites: id -> name, names, lon, lat; grid for neighbour search.
    sites, grid = {}, defaultdict(list)
    with open(SITES_CSV, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            pid = r["id"].split(":")[1]
            lon, lat = float(r["lon"]), float(r["lat"])
            sites[pid] = (r["name"], lon, lat)
            grid[(int(lon // 0.1), int(lat // 0.1))].append(pid)

    def near(lon, lat, radius_m):
        out = []
        cx, cy = int(lon // 0.1), int(lat // 0.1)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for pid in grid.get((cx + dx, cy + dy), []):
                    n, slon, slat = sites[pid]
                    d = metres(lon, lat, slon, slat)
                    if d <= radius_m:
                        out.append((d, pid))
        return sorted(out)

    # 1. Items with a Pleiades ID.
    print("Wikidata items with a Pleiades ID")
    links = {}
    for row in sparql(Q_PLEIADES, CACHE / "pleiades-ids.json", args.refresh):
        pid = row["pleiades"].strip()
        if pid in sites and pid not in links:
            links[pid] = {"pleiades": pid, "qid": row["item"].rsplit("/", 1)[1], "wikipedia": row.get("article", ""),
                          "image": row.get("image", ""), "rule": "Wikidata P1584 (Pleiades ID)"}
    print(f"  {len(links)} Pleiades sites linked by ID")

    # 2. Archaeological sites without a Pleiades ID, in 5° tiles.
    print("Wikidata archaeological sites in the Pleiades region")
    items = {}
    uncovered = []
    w0, s0, e0, n0 = REGION

    def tile_rows(w, s, size):
        """Rows for one tile; a tile that times out is split into four."""
        name = f"sites_{w}_{s}.json" if size == 5 else f"sites_{w}_{s}_{size}.json"
        q = Q_SITES.format(w=w, s=s, e=w + size, n=s + size, langs=LANGS)
        marker = CACHE / (name + ".split")
        if marker.exists() and not args.refresh:
            half = size / 2  # split before: go straight to the cached quarters
            return [r for dw in (0, half) for ds in (0, half) for r in tile_rows(w + dw, s + ds, half)]
        try:
            return sparql(q, CACHE / name, args.refresh, attempts=2 if size > MIN_TILE else 3)
        except RuntimeError:
            if size <= MIN_TILE:
                # Still too dense for the public endpoint: skipped and listed,
                # never silently.
                uncovered.append([w, s, w + size, s + size])
                print(f"  giving up on {w},{s} ({size}°)")
                return []
            half = size / 2
            print(f"  splitting {w},{s} ({size}°)")
            marker.write_text("", encoding="utf-8")
            return [r for dw in (0, half) for ds in (0, half) for r in tile_rows(w + dw, s + ds, half)]

    for w in range(w0, e0, 5):
        for s in range(s0, n0, 5):
            for row in tile_rows(w, s, 5):
                m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", row["coord"])
                if not m:
                    continue
                qid = row["item"].rsplit("/", 1)[1]
                items.setdefault(qid, {"qid": qid, "name": row.get("label", qid), "lon": float(m.group(1)),
                                       "lat": float(m.group(2)), "wikipedia": row.get("article", ""),
                                       "inception": row.get("inception", ""),
                                       # geoPrecision is in degrees; about 111 km per degree
                                       "precision_m": round(float(row["precision"]) * 111320) if row.get("precision") else None})
    print(f"  {len(items)} items")

    # Decisions from an earlier review (merge-review.csv, column "decision":
    # "same ..." or "different ..."); kept across runs.
    decided = {}
    if (OUT / "merge-review.csv").exists():
        with open(OUT / "merge-review.csv", encoding="utf-8", newline="") as f:
            # Only manual decisions are carried over; auto ones are recomputed.
            decided = {(r["qid"], r["pleiades"]): r["decision"] for r in csv.DictReader(f)
                       if r.get("decision") and "(auto" not in r["decision"] and "(rule" not in r["decision"]}

    linked_qids = {l["qid"] for l in links.values()}
    review, new, duplicates = [], [], []
    for it in items.values():
        if it["qid"] in linked_qids or it["name"] == it["qid"]:
            continue
        cands = near(it["lon"], it["lat"], 5000)
        best = max(((similarity(it["name"], sites[pid][0]), d, pid) for d, pid in cands), default=None)
        if best and best[1] <= 1000 and best[0] >= 0.8 and best[2] not in links:
            links[best[2]] = {"pleiades": best[2], "qid": it["qid"], "wikipedia": it["wikipedia"], "image": "",
                              "rule": f"distance {best[1]:.0f} m, name similarity {best[0]:.2f}"}
        elif best and ((best[1] <= 1000 and best[0] >= 0.5) or best[0] >= 0.9):
            decision = decided.get((it["qid"], best[2]), "") or auto_decision(it["name"], sites[best[2]][0], best[1], best[0])
            pair = {"qid": it["qid"], "wikidata_name": it["name"], "pleiades": best[2],
                    "pleiades_name": sites[best[2]][0], "distance_m": round(best[1]),
                    "similarity": round(best[0], 2), "decision": decision}
            if decision.startswith("same"):
                # Kept in the review file with its decision, so it survives reruns.
                review.append(pair)
                if best[2] not in links:
                    links[best[2]] = {"pleiades": best[2], "qid": it["qid"], "wikipedia": it["wikipedia"], "image": "",
                                      "rule": f"review: {decision}"}
                else:
                    # A second Wikidata item for a site already linked: a
                    # duplicate within Wikidata, not a new site.
                    duplicates.append({"qid": it["qid"], "pleiades": best[2], "rule": decision})
                continue
            review.append(pair)
            new.append(it)  # separate until reviewed as the same site
        else:
            new.append(it)

    with open(OUT / "wikidata-links.csv", "w", encoding="utf-8", newline="") as f:
        out = csv.DictWriter(f, fieldnames=["pleiades", "qid", "wikipedia", "image", "rule"])
        out.writeheader()
        out.writerows(sorted(links.values(), key=lambda r: int(r["pleiades"])))
    with open(OUT / "merge-review.csv", "w", encoding="utf-8", newline="") as f:
        out = csv.DictWriter(f, fieldnames=["qid", "wikidata_name", "pleiades", "pleiades_name", "distance_m", "similarity", "decision"])
        out.writeheader()
        out.writerows(review)
    (OUT / "wikidata-sites.json").write_text(json.dumps(new, ensure_ascii=False), encoding="utf-8")
    (OUT / "wikidata-uncovered.json").write_text(json.dumps(uncovered), encoding="utf-8")
    with open(OUT / "wikidata-duplicates.csv", "w", encoding="utf-8", newline="") as f:
        out = csv.DictWriter(f, fieldnames=["qid", "pleiades", "rule"])
        out.writeheader()
        out.writerows(duplicates)
    open_pairs = sum(1 for r in review if not r["decision"])
    print(f"{len(duplicates)} Wikidata duplicates of linked sites dropped; {open_pairs} pairs still need a person")
    print(f"{len(links)} Pleiades sites linked, {len(review)} pairs to review, {len(new)} sites only in Wikidata")
    if uncovered:
        print(f"{len(uncovered)} tiles could not be queried (listed in wikidata-uncovered.json)")


if __name__ == "__main__":
    main()
