"""Turn a textured mesh into a Gaussian splat (.ply, 3DGS layout) for testing.

Samples points on the surface (by area), colours them from the texture and
writes one small round Gaussian per point. This is not a real splat capture;
it exists to test the splat pipeline (PRD A2) with openly licensed data.

Usage: python scripts/mesh_to_splat.py in.glb out.ply [--count 250000]
"""

import argparse
import struct

import numpy as np
import trimesh

SH_C0 = 0.28209479177387814


def sample(mesh, n, rng):
    pts, faces = trimesh.sample.sample_surface(mesh, n, seed=int(rng.integers(1 << 31)))
    colours = np.full((len(pts), 3), 0.6)
    vis = mesh.visual
    if vis.kind == "texture" and vis.uv is not None and getattr(vis.material, "baseColorTexture", None) is not None:
        tri = mesh.triangles[faces]
        bary = trimesh.triangles.points_to_barycentric(tri, pts)
        uv = np.einsum("ij,ijk->ik", bary, vis.uv[mesh.faces[faces]])
        img = np.asarray(vis.material.baseColorTexture.convert("RGB"), dtype=np.float32) / 255.0
        h, w = img.shape[:2]
        x = np.clip((uv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(int)
        y = np.clip((1 - uv[:, 1] % 1.0) * (h - 1), 0, h - 1).astype(int)
        colours = img[y, x]
    return pts, colours


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--count", type=int, default=250000)
    args = ap.parse_args()

    scene = trimesh.load(args.src)
    meshes = [g.copy().apply_transform(scene.graph.get(name)[0]) for name in scene.graph.nodes_geometry
              for g in [scene.geometry[scene.graph.get(name)[1]]]]
    areas = np.array([m.area for m in meshes])
    rng = np.random.default_rng(1)
    counts = np.maximum((areas / areas.sum() * args.count).astype(int), 1)
    pts, cols = zip(*(sample(m, c, rng) for m, c in zip(meshes, counts)))
    pts, cols = np.vstack(pts), np.vstack(cols)
    # Splat radius from the sampling density: about the mean point spacing.
    spacing = np.sqrt(areas.sum() / len(pts))
    log_scale = np.log(spacing * 0.6)

    header = "\n".join([
        "ply", "format binary_little_endian 1.0", f"element vertex {len(pts)}",
        *[f"property float {p}" for p in ("x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2",
                                          "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3")],
        "end_header", "",
    ]).encode()
    rows = np.zeros((len(pts), 17), dtype="<f4")
    rows[:, 0:3] = pts
    rows[:, 6:9] = (cols - 0.5) / SH_C0           # SH degree 0
    rows[:, 9] = 4.0                               # logit opacity, ~0.98
    rows[:, 10:13] = log_scale
    rows[:, 13] = 1.0                              # identity rotation (w, x, y, z)
    with open(args.dst, "wb") as f:
        f.write(header)
        f.write(rows.tobytes())
    print(f"{len(pts)} splats, spacing {spacing:.3f} m -> {args.dst}")


if __name__ == "__main__":
    main()
