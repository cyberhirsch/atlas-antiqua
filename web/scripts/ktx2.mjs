// Re-encode a GLB's textures as KTX2 / Basis Universal (PRD §9.1), so GPU
// memory holds the compressed form. ETC1S by default (small); --uastc for
// higher quality. Mesh compression (meshopt) is kept.
//
// Usage: node scripts/ktx2.mjs in.glb out.glb [--uastc]

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { ktx2 } from "ktx2-encoder/gltf-transform";
import sharp from "sharp";

const [src, dst, flag] = process.argv.slice(2);
if (!src || !dst) {
  console.error("usage: node scripts/ktx2.mjs in.glb out.glb [--uastc]");
  process.exit(1);
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

const imageDecoder = async (buffer) => {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

const doc = await io.read(src);
await doc.transform(ktx2({ isUASTC: flag === "--uastc", generateMipmap: true, enableDebug: false, imageDecoder }));
await io.write(dst, doc);
console.log(`KTX2 textures -> ${dst}`);
