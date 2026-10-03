"""Export the Pleiades sites as a compact JSON file for the web viewer.

Reads data/sites/pleiades-sites.csv (from scripts/pleiades.py) row by row and
writes web/public/data/sites.json:

{"fields": [...], "categories": [...], "rows": [[...], ...]}

Heights are metres above the WGS84 ellipsoid; years are HE.

Usage: python scripts/export_sites.py
"""

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "sites" / "pleiades-sites.csv"
OUT = ROOT / "web" / "public" / "data" / "sites.json"

FIELDS = ["id", "name", "lon", "lat", "h", "start", "end", "category", "confidence", "precision", "view_km"]


def num(v, digits=None):
    if v in ("", None, "None"):
        return None
    f = float(v)
    return round(f, digits) if digits is not None else int(round(f))


def main():
    categories, rows = [], []
    with open(SRC, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["category"] not in categories:
                categories.append(r["category"])
            rows.append([
                r["id"].split(":")[1],
                r["name"],
                num(r["lon"], 6),
                num(r["lat"], 6),
                num(r["elev_ellipsoidal_m"], 1),
                num(r["start"]),
                num(r["end"]),
                categories.index(r["category"]),
                int(r["conf_overall"]),
                num(r["publication_precision_m"]),
                num(r["view_km"]),  # null: shown from any distance
            ])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"fields": FIELDS, "categories": categories, "rows": rows}, f,
                  ensure_ascii=False, separators=(",", ":"))
    print(f"{len(rows)} sites -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
