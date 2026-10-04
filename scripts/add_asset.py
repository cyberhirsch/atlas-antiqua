"""Add a 3D asset to the viewer (PRD A3): optimise it and enter it in
web/public/assets/assets.json with its georeference, dates and licence.

Supported input:
- glTF/GLB meshes: compressed with gltf-transform (meshopt geometry, WebP
  textures at most 2048 px)
- Gaussian splats: .ply (3DGS layout) or .spz, copied as they are
- point clouds: .las/.laz, written as a GLB of coloured points

Georeference: lon/lat (WGS84) of the model origin, height (m above the
ellipsoid; omit to place it on the terrain), heading (degrees clockwise
from north), scale, and the model's up axis (glTF is Y-up; scans are often
Z-up).

Usage:
  python scripts/add_asset.py FILE --id ID --name NAME --lon LON --lat LAT
      [--h H] [--heading DEG] [--scale S] [--up y|z] [--site PLEIADES_ID]
      [--start HE] [--end HE] [--captured YYYY-MM-DD] --creator WHO
      --licence LICENCE [--source URL] [--note TEXT]
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "web" / "public" / "assets"
MANIFEST = ASSETS / "assets.json"


def optimise_glb(src: Path, dst: Path) -> None:
    cmd = ["npx", "--yes", "@gltf-transform/cli", "optimize", str(src.resolve()), str(dst.resolve()),
           "--compress", "meshopt", "--texture-compress", "webp", "--texture-size", "2048"]
    subprocess.run(cmd, check=True, cwd=ROOT / "web", shell=sys.platform == "win32")


def las_to_glb(src: Path, dst: Path) -> None:
    import laspy
    import numpy as np
    from pygltflib import GLTF2, Accessor, Asset, Attributes, Buffer, BufferView, Mesh, Node, Primitive, Scene

    las = laspy.read(src)
    xyz = np.vstack([las.x, las.y, las.z]).T
    xyz = (xyz - xyz.mean(axis=0)).astype("<f4")
    # LAS is Z-up; glTF is Y-up.
    xyz = xyz[:, [0, 2, 1]] * np.array([1, 1, -1], dtype="<f4")
    if {"red", "green", "blue"} <= set(las.point_format.dimension_names):
        rgb = np.vstack([las.red, las.green, las.blue]).T.astype(np.float32)
        rgb = (rgb / (65535 if rgb.max() > 255 else 255) * 255).astype("<u1")
    else:
        rgb = np.full((len(xyz), 3), 200, dtype="<u1")
    rgba = np.hstack([rgb, np.full((len(rgb), 1), 255, dtype="<u1")])
    blob = xyz.tobytes() + rgba.tobytes()
    g = GLTF2(asset=Asset(version="2.0"), scene=0, scenes=[Scene(nodes=[0])], nodes=[Node(mesh=0)],
              meshes=[Mesh(primitives=[Primitive(attributes=Attributes(POSITION=0, COLOR_0=1), mode=0)])],
              buffers=[Buffer(byteLength=len(blob))],
              bufferViews=[BufferView(buffer=0, byteOffset=0, byteLength=xyz.nbytes),
                           BufferView(buffer=0, byteOffset=xyz.nbytes, byteLength=rgba.nbytes)],
              accessors=[Accessor(bufferView=0, componentType=5126, count=len(xyz), type="VEC3",
                                  min=xyz.min(axis=0).tolist(), max=xyz.max(axis=0).tolist()),
                         Accessor(bufferView=1, componentType=5121, normalized=True, count=len(rgba), type="VEC4")])
    g.set_binary_blob(blob)
    g.save_binary(str(dst))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file", type=Path)
    for name in ("id", "name", "creator", "licence"):
        ap.add_argument(f"--{name}", required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--h", type=float)
    ap.add_argument("--heading", type=float, default=0.0)
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--up", choices=("y", "z"), default="y")
    ap.add_argument("--site")
    ap.add_argument("--start", type=int)
    ap.add_argument("--end", type=int)
    ap.add_argument("--captured")
    ap.add_argument("--source")
    ap.add_argument("--note")
    args = ap.parse_args()

    ASSETS.mkdir(parents=True, exist_ok=True)
    ext = args.file.suffix.lower()
    if ext in (".glb", ".gltf"):
        kind, out = "mesh", ASSETS / f"{args.id}.glb"
        optimise_glb(args.file, out)
    elif ext in (".ply", ".spz", ".splat"):
        kind, out = "splat", ASSETS / f"{args.id}{ext}"
        shutil.copy(args.file, out)
    elif ext in (".las", ".laz"):
        kind, out = "points", ASSETS / f"{args.id}.glb"
        las_to_glb(args.file, out)
    else:
        sys.exit(f"unsupported file type {ext}")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else []
    manifest = [a for a in manifest if a["id"] != args.id]
    manifest.append({
        "id": args.id, "name": args.name, "kind": kind, "url": out.name,
        "lon": args.lon, "lat": args.lat, "h": args.h, "heading": args.heading, "scale": args.scale,
        "up": args.up, "site": args.site, "start": args.start, "end": args.end,
        "captured": args.captured, "creator": args.creator, "licence": args.licence,
        "source": args.source, "note": args.note, "bytes": out.stat().st_size,
    })
    MANIFEST.write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{kind} {out.name}: {out.stat().st_size / 1e6:.1f} MB -> {MANIFEST}")


if __name__ == "__main__":
    main()
