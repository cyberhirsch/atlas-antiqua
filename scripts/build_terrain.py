"""Build terrain height tiles for the web viewer (PRD §9.1).

Tiles follow the WGS84 quadtree used by EOX's Sentinel-2 cloudless WMTS:
level z has 2^(z+1) x 2^z tiles, x from 180 W eastwards, y from 90 N
southwards. Each tile holds 129 x 129 height samples on a regular lon/lat
grid that includes both edges, so neighbouring tiles share their border.

Heights are metres above the WGS84 ellipsoid (EGM2008 height plus the geoid
undulation), so the viewer can place vertices directly; stored as
Terrain-RGB PNG: h = (R * 65536 + G * 256 + B) / 10 - 10000.

Sources, best first (each one blended into the next at its edge):
- Bavarian DGM1 (1 m LiDAR, DHHN2016 -> EGM2008) in data/raw/dgm1, up to level 16
- Copernicus GLO-30 tiles in data/raw/glo30, up to level 12
- ETOPO 2022 60" (land only; the sea is flat at 0) everywhere, up to level 5

Deeper levels exist only where a better source does, so the globe is low
resolution except in those areas. The viewer reads the same rules from
regions.json.

Usage: python scripts/build_terrain.py [--max-global 5]
"""

import argparse
import datetime
import json
import math
import re
import sys
import time
from collections import OrderedDict
from pathlib import Path

import os

os.environ.setdefault("GDAL_CACHEMAX", "256")  # MB; the default is a share of system RAM

import numpy as np
import pyproj
import rasterio
from PIL import Image
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parent.parent
GLO30_DIR = ROOT / "data" / "raw" / "glo30"
DGM1_DIR = ROOT / "data" / "raw" / "dgm1"
ETOPO = ROOT / "data" / "raw" / "etopo" / "ETOPO_2022_v1_60s_N90W180_surface.nc"
OUT = ROOT / "web" / "public" / "tiles" / "terrain"

N = 129                  # samples per tile edge
GLO30_MAX = 12
DGM1_MAX = 16
GLO30_FEATHER_DEG = 0.02  # GLO-30 fades into ETOPO at the edge of its area
DGM1_FEATHER_M = 300.0    # DGM1 fades into GLO-30 at the edge of its area


def tile_bounds(z, x, y):
    span = 180.0 / 2 ** z
    west = -180.0 + x * span
    north = 90.0 - y * span
    return west, north - span, west + span, north  # w, s, e, n


def tile_grid(z, x, y):
    w, s, e, n = tile_bounds(z, x, y)
    lons = np.linspace(w, e, N)
    lats = np.linspace(n, s, N)
    return np.meshgrid(lons, lats)


def bilinear(a, rows, cols):
    """Sample array a at fractional pixel-centre coordinates (NaN outside)."""
    h, w = a.shape
    r0 = np.floor(rows).astype(int)
    c0 = np.floor(cols).astype(int)
    fr, fc = rows - r0, cols - c0
    out = np.full(rows.shape, np.nan, dtype=np.float64)
    ok = (r0 >= 0) & (c0 >= 0) & (r0 + 1 < h) & (c0 + 1 < w)
    # Allow the last row/column by clamping the neighbour.
    edge = (r0 >= 0) & (c0 >= 0) & (r0 < h) & (c0 < w) & ~ok
    r1 = np.minimum(r0 + 1, h - 1)
    c1 = np.minimum(c0 + 1, w - 1)
    m = ok | edge
    v = (a[r0[m], c0[m]] * (1 - fr[m]) * (1 - fc[m]) + a[r0[m], c1[m]] * (1 - fr[m]) * fc[m]
         + a[r1[m], c0[m]] * fr[m] * (1 - fc[m]) + a[r1[m], c1[m]] * fr[m] * fc[m])
    out[m] = v
    return out


def read_window(ds, lons, lats, step_deg):
    """Read the part of a lon/lat raster covering the sample grid, decimated
    to about the sample spacing, and bilinearly sample it."""
    inv = ~ds.transform
    w, e = lons.min(), lons.max()
    s, n = lats.min(), lats.max()
    c0, r0 = inv * (w, n)
    c1, r1 = inv * (e, s)
    c0, r0 = max(int(math.floor(c0)) - 1, 0), max(int(math.floor(r0)) - 1, 0)
    c1, r1 = min(int(math.ceil(c1)) + 2, ds.width), min(int(math.ceil(r1)) + 2, ds.height)
    if c1 <= c0 or r1 <= r0:
        return np.full(lons.shape, np.nan)
    px = abs(ds.transform.a)
    factor = max(1, int(step_deg / px))
    out_w = max(2, math.ceil((c1 - c0) / factor))
    out_h = max(2, math.ceil((r1 - r0) / factor))
    a = ds.read(1, window=Window(c0, r0, c1 - c0, r1 - r0), out_shape=(out_h, out_w),
                resampling=rasterio.enums.Resampling.average, masked=True).astype(np.float64)
    a = a.filled(np.nan)
    sx = (c1 - c0) / out_w
    sy = (r1 - r0) / out_h
    col, row = inv * (lons, lats)
    # pixel-centre coordinates in the decimated array
    cols = (np.asarray(col) - c0) / sx - 0.5
    rows = (np.asarray(row) - r0) / sy - 0.5
    return bilinear(a, rows, cols)


# --- sources -------------------------------------------------------------------

class Etopo:
    def __init__(self):
        self.ds = rasterio.open(ETOPO)

    def sample(self, lons, lats, step):
        h = read_window(self.ds, lons, lats, step)
        return np.maximum(np.nan_to_num(h, nan=0.0), 0.0)  # sea surface at 0


class Glo30:
    def __init__(self):
        self.files = {}
        for f in GLO30_DIR.glob("*_DEM.tif"):
            m = re.search(r"_([NS])(\d\d)_00_([EW])(\d\d\d)_00_DEM", f.name)
            lat = int(m.group(2)) * (1 if m.group(1) == "N" else -1)
            lon = int(m.group(4)) * (1 if m.group(3) == "E" else -1)
            self.files[(lat, lon)] = f
        self.open = {}

    def cells(self):
        return sorted(self.files)

    def ds(self, cell):
        if cell not in self.open:
            self.open[cell] = rasterio.open(self.files[cell])
        return self.open[cell]

    def intersects(self, w, s, e, n):
        return any(lon < e and lon + 1 > w and lat < n and lat + 1 > s for lat, lon in self.files)

    def sample(self, lons, lats, step):
        out = np.full(lons.shape, np.nan)
        for (lat, lon) in self.files:
            m = (lons >= lon) & (lons <= lon + 1) & (lats >= lat) & (lats <= lat + 1)
            if not m.any():
                continue
            v = read_window(self.ds((lat, lon)), lons[m], lats[m], step)
            take = np.isnan(out[m])
            out_m = out[m]
            out_m[take] = v[take]
            out[m] = out_m
        return out

    def weight(self, lons, lats):
        """1 inside the GLO-30 area, fading to 0 within GLO30_FEATHER_DEG of
        an edge that borders a cell without GLO-30."""
        wgt = np.zeros(lons.shape)
        for (lat, lon) in self.files:
            m = (lons >= lon) & (lons <= lon + 1) & (lats >= lat) & (lats <= lat + 1)
            if not m.any():
                continue
            d = np.full(m.sum(), np.inf)
            lo, la = lons[m], lats[m]
            if (lat, lon - 1) not in self.files:
                d = np.minimum(d, lo - lon)
            if (lat, lon + 1) not in self.files:
                d = np.minimum(d, lon + 1 - lo)
            if (lat - 1, lon) not in self.files:
                d = np.minimum(d, la - lat)
            if (lat + 1, lon) not in self.files:
                d = np.minimum(d, lat + 1 - la)
            wgt[m] = np.maximum(wgt[m], np.clip(d / GLO30_FEATHER_DEG, 0, 1))
        return wgt


class Dgm1:
    """Bavarian DGM1 tiles named {east_km}_{north_km}.tif in ETRS89 / UTM 32N."""

    def __init__(self):
        self.tiles = {}
        for f in DGM1_DIR.glob("*.tif"):
            e, n = f.stem.split("_")
            self.tiles[(int(e), int(n))] = f
        es = [k[0] for k in self.tiles]
        ns = [k[1] for k in self.tiles]
        self.rect = (min(es) * 1000, min(ns) * 1000, (max(es) + 1) * 1000, (max(ns) + 1) * 1000)
        self.to_utm = pyproj.Transformer.from_crs(4326, 25832, always_xy=True)
        pyproj.network.set_network_enabled(True)
        self.to_egm = pyproj.Transformer.from_crs("EPSG:25832+7837", "EPSG:4326+3855", always_xy=True)
        self.cache = OrderedDict()
        # lon/lat bounding box of the UTM rectangle
        to_ll = pyproj.Transformer.from_crs(25832, 4326, always_xy=True)
        x0, y0, x1, y1 = self.rect
        xs = np.linspace(x0, x1, 50)
        ys = np.linspace(y0, y1, 50)
        edge = [(x, y0) for x in xs] + [(x, y1) for x in xs] + [(x0, y) for y in ys] + [(x1, y) for y in ys]
        ll = [to_ll.transform(x, y) for x, y in edge]
        self.bbox = (min(p[0] for p in ll), min(p[1] for p in ll), max(p[0] for p in ll), max(p[1] for p in ll))

    def array(self, key):
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        with rasterio.open(self.tiles[key]) as ds:
            a = ds.read(1, masked=True).astype(np.float32).filled(np.nan)
        self.cache[key] = a
        if len(self.cache) > 24:  # about 100 MB
            self.cache.popitem(last=False)
        return a

    def intersects(self, w, s, e, n):
        bw, bs, be, bn = self.bbox
        return w < be and e > bw and s < bn and n > bs

    def sample(self, lons, lats, step_m):
        x, y = self.to_utm.transform(lons, lats)
        x, y = np.asarray(x), np.asarray(y)
        out = np.full(lons.shape, np.nan)
        factor = min(max(1, int(step_m)), 500)  # decimate 1 m data to the sample spacing
        keys = set(zip((x // 1000).astype(int).ravel(), (y // 1000).astype(int).ravel()))
        for key in keys:
            if key not in self.tiles:
                continue
            m = ((x // 1000).astype(int) == key[0]) & ((y // 1000).astype(int) == key[1])
            a = self.array(key)
            if factor > 1:
                hh = a.shape[0] // factor * factor
                a = np.nanmean(a[:hh, :hh].reshape(hh // factor, factor, hh // factor, factor), axis=(1, 3))
            # row 0 is the north edge; pixel centres at +0.5
            cols = (x[m] - key[0] * 1000) / factor - 0.5
            rows = ((key[1] + 1) * 1000 - y[m]) / factor - 0.5
            out[m] = bilinear(a, np.clip(rows, 0, a.shape[0] - 1), np.clip(cols, 0, a.shape[1] - 1))
        # DHHN2016 -> EGM2008: smooth, so one offset per tile is enough (a few cm).
        # Taken inside the LiDAR area: a coarse tile's centre can lie outside
        # the German geoid grid, where pyproj returns infinity.
        x0, y0, x1, y1 = self.rect
        cx = min(max(float(np.mean(x)), x0), x1)
        cy = min(max(float(np.mean(y)), y0), y1)
        _, _, h = self.to_egm.transform(cx, cy, 0.0)
        if not math.isfinite(h):
            raise RuntimeError(f"DHHN2016 -> EGM2008 offset unavailable at {cx:.0f}, {cy:.0f}")
        out += h
        x0, y0, x1, y1 = self.rect
        d = np.minimum.reduce([x - x0, x1 - x, y - y0, y1 - y])
        wgt = np.clip(d / DGM1_FEATHER_M, 0, 1)
        return out, wgt


# --- build -------------------------------------------------------------------

_GEOID = None


def geoid_undulation(lons, lats):
    """EGM2008 geoid height N on the sample grid (h_ellipsoid = H + N).

    N varies smoothly, so it is computed on a 9 x 9 grid and interpolated.
    """
    global _GEOID
    if _GEOID is None:
        pyproj.network.set_network_enabled(True)
        _GEOID = pyproj.Transformer.from_crs("EPSG:4326+3855", "EPSG:4979", always_xy=True)
    idx = np.linspace(0, N - 1, 9).round().astype(int)
    lo, la = lons[np.ix_(idx, idx)], lats[np.ix_(idx, idx)]
    _, _, z = _GEOID.transform(lo, la, np.zeros_like(lo))
    coarse = np.asarray(z, dtype=np.float64)
    pos = np.arange(N) * (8 / (N - 1))
    rows, cols = np.meshgrid(pos, pos, indexing="ij")
    return bilinear(coarse, rows, cols)


def encode(h):
    v = np.clip(np.round((h + 10000.0) * 10.0), 0, 2 ** 24 - 1).astype(np.uint32)
    rgb = np.stack([(v >> 16) & 255, (v >> 8) & 255, v & 255], axis=-1).astype(np.uint8)
    return Image.fromarray(rgb, "RGB")


def build_tile(z, x, y, etopo, glo, dgm, max_global):
    lons, lats = tile_grid(z, x, y)
    w, s, e, n = tile_bounds(z, x, y)
    step_deg = (e - w) / (N - 1)
    h = etopo.sample(lons, lats, step_deg)
    if z > 0 and glo.intersects(w, s, e, n):
        g = glo.sample(lons, lats, step_deg)
        wg = glo.weight(lons, lats) * ~np.isnan(g)
        h = np.where(wg > 0, np.nan_to_num(g) * wg + h * (1 - wg), h)
    if dgm.intersects(w, s, e, n):
        step_m = step_deg * 111320 * math.cos(math.radians((s + n) / 2))
        d, wd = dgm.sample(lons, lats, step_m)
        wd = wd * ~np.isnan(d)
        h = np.where(wd > 0, np.nan_to_num(d) * wd + h * (1 - wd), h)
    h = h + geoid_undulation(lons, lats)
    path = OUT / str(z) / str(x) / f"{y}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    if not np.isfinite(h).all():
        raise RuntimeError(f"tile {z}/{x}/{y} has non-finite heights")
    encode(h).save(tmp, format="PNG", optimize=True)
    tmp.replace(path)  # never leave a half-written tile


def children(z, x, y):
    return [(z + 1, 2 * x + i, 2 * y + j) for j in (0, 1) for i in (0, 1)]


def refine(z, x, y, glo, dgm, max_global):
    """Whether tile z/x/y gets children. Always all four, so the viewer can
    replace a tile by its children without gaps or overlaps."""
    c = z + 1
    if c <= max_global:
        return True
    w, s, e, n = tile_bounds(z, x, y)
    if c <= GLO30_MAX and glo.intersects(w, s, e, n):
        return True
    return c <= DGM1_MAX and dgm.intersects(w, s, e, n)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--max-global", type=int, default=5)
    args = parser.parse_args()

    etopo, glo, dgm = Etopo(), Glo30(), Dgm1()
    regions = {
        "scheme": "WGS84 quadtree, level z has 2^(z+1) x 2^z tiles; x from 180W, y from 90N",
        "samples": N,
        "encoding": "terrain-rgb: h = (R*65536 + G*256 + B) / 10 - 10000, metres above the WGS84 ellipsoid",
        "maxGlobal": args.max_global,
        "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S"),
        "regions": [{"name": f"GLO-30 {lat:+03d} {lon:+04d}", "bbox": [lon, lat, lon + 1, lat + 1],
                     "maxLevel": GLO30_MAX} for lat, lon in glo.cells()]
                   + [{"name": "DGM1 Traunstein-Ruhpolding", "bbox": list(dgm.bbox),
                       "maxLevel": DGM1_MAX, "imagery": "bayern-dop40"}],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "regions.json").write_text(json.dumps(regions, indent=1), encoding="utf-8")

    stack = [(0, 0, 0), (0, 1, 0)]
    done = 0
    t0 = time.time()
    while stack:
        z, x, y = stack.pop()
        if not (OUT / str(z) / str(x) / f"{y}.png").exists():
            build_tile(z, x, y, etopo, glo, dgm, args.max_global)
        done += 1
        if done % 500 == 0:
            print(f"{done} tiles, {time.time() - t0:.0f} s", flush=True)
        if refine(z, x, y, glo, dgm, args.max_global):
            stack.extend(children(z, x, y))
    print(f"{done} tiles in {time.time() - t0:.0f} s -> {OUT}")


if __name__ == "__main__":
    main()
