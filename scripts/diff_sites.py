"""Compare a new site export with the published one and report the changes
(PRD D4): sites added, removed, moved, re-dated or re-rated.

Usage: python scripts/diff_sites.py [--baseline URL_OR_PATH] [--out report.md]

The baseline defaults to the CSV published with the viewer. Writes a
Markdown report (also suitable for a GitHub Actions job summary).
"""

import argparse
import csv
import gzip
import io
import math
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEW = ROOT / "data" / "sites" / "pleiades-sites.csv"
DEFAULT_BASELINE = "https://cyberhirsch.github.io/atlas-antiqua/downloads/atlas-antiqua-sites.csv.gz"


def read(src: str) -> dict[str, dict]:
    if src.startswith("http"):
        raw = urllib.request.urlopen(src, timeout=120).read()
    else:
        raw = Path(src).read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return {r["id"]: r for r in csv.DictReader(io.StringIO(raw.decode("utf-8")))}


def moved_m(a: dict, b: dict) -> float:
    lat = math.radians((float(a["lat"]) + float(b["lat"])) / 2)
    dx = (float(a["lon"]) - float(b["lon"])) * 111320 * math.cos(lat)
    dy = (float(a["lat"]) - float(b["lat"])) * 111320
    return math.hypot(dx, dy)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--baseline", default=DEFAULT_BASELINE)
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "sites" / "changes.md")
    args = ap.parse_args()

    old, new = read(args.baseline), read(str(NEW))
    added = [new[k] for k in new.keys() - old.keys()]
    removed = [old[k] for k in old.keys() - new.keys()]
    moved, redated, rerated = [], [], []
    for k in new.keys() & old.keys():
        a, b = old[k], new[k]
        # Published coordinates may be reduced (P1); only report real moves.
        tolerance = max(float(b.get("publication_precision_m") or 0), 50)
        d = moved_m(a, b)
        if d > tolerance:
            moved.append((b, d))
        if (a["start"], a["end"]) != (b["start"], b["end"]):
            redated.append((a, b))
        if a["conf_overall"] != b["conf_overall"]:
            rerated.append((a, b))

    lines = [
        "# Site changes",
        "",
        f"Baseline: {args.baseline}",
        "",
        "| change | sites |", "|---|---|",
        f"| added | {len(added)} |", f"| removed | {len(removed)} |", f"| moved | {len(moved)} |",
        f"| re-dated | {len(redated)} |", f"| confidence changed | {len(rerated)} |",
        "",
    ]
    def section(title, rows):
        if rows:
            lines.extend([f"## {title}", "", *rows[:200], *(["", f"… and {len(rows) - 200} more"] if len(rows) > 200 else []), ""])
    section("Added", [f"- {r['id']} {r['name']} ({r['category']})" for r in added])
    section("Removed", [f"- {r['id']} {r['name']}" for r in removed])
    section("Moved", [f"- {r['id']} {r['name']}: {d:.0f} m" for r, d in sorted(moved, key=lambda x: -x[1])])
    section("Re-dated", [f"- {b['id']} {b['name']}: {a['start']}–{a['end']} → {b['start']}–{b['end']} HE" for a, b in redated])
    section("Confidence changed", [f"- {b['id']} {b['name']}: {a['conf_overall']} → {b['conf_overall']}" for a, b in rerated])
    args.out.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[:14]))


if __name__ == "__main__":
    main()
