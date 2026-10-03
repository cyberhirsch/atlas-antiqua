// Terrain quadtree: height tiles from scripts/build_terrain.py, imagery from
// Sentinel-2 cloudless (EOX) or, in the Bavarian LiDAR area, DOP40 aerial
// photos. Tiles are refined by screen-space error, but only where the
// regions file says deeper data exists; elsewhere the globe stays coarse.
//
// Loading: only tiles that are in view and above the horizon are requested;
// the queue is ordered by need (distance and closeness to the view centre,
// not by level), loads that are no longer needed are aborted, downloads are
// kept in the browser's Cache Storage, and GPU memory has a byte budget.

import * as THREE from "three";
import { Vec3, dot, ecef, geodetic, length, sub } from "./geo";

const BASE = import.meta.env.BASE_URL;
const TERRAIN_URL = `${BASE}tiles/terrain`;
const EOX_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless/default/WGS84";
const DOP40_URL = "https://geoservices.bayern.de/od/wms/dop/v1/dop40";

const MAX_SSE = 2.5;              // refine while a height sample spans more pixels
const MAX_LOADS = 10;             // concurrent tile loads
const GPU_BUDGET = 300 * 2 ** 20; // bytes of geometry and textures kept
const ABORT_AFTER = 30;           // frames a loading tile may go unused
const MAX_HEIGHT = 9000;          // upper bound before a tile's heights are known
const MIN_HEIGHT = -500;

interface Region {
  name: string;
  bbox: [number, number, number, number];
  maxLevel: number;
  imagery?: string;
}

interface RegionsFile {
  samples: number;
  maxGlobal: number;
  built?: string;
  regions: Region[];
}

type State = "empty" | "loading" | "ready" | "failed";

class Tile {
  readonly w: number;
  readonly s: number;
  readonly e: number;
  readonly n: number;
  readonly error: number;
  center!: Vec3;
  radius = 0;
  top: Vec3[] = [];    // probes at the highest point of the tile
  bottom: Vec3[] = []; // probes at the lowest point
  state: State = "empty";
  mesh?: THREE.Mesh;
  kids?: Tile[];
  lastUsed = 0;
  bytes = 0;
  drawn = false;
  abort?: AbortController;

  constructor(readonly z: number, readonly x: number, readonly y: number, samples: number,
    public minH = MIN_HEIGHT, public maxH = MAX_HEIGHT) {
    const span = 180 / 2 ** z;
    this.w = -180 + x * span;
    this.n = 90 - y * span;
    this.e = this.w + span;
    this.s = this.n - span;
    const cosLat = Math.max(Math.cos((Math.max(Math.abs(this.s), Math.abs(this.n)) * Math.PI) / 180), 0.05);
    const widthM = Math.max(span * 111320 * cosLat, span * 111320 * 0.5);
    this.error = widthM / (samples - 1);
    this.bounds();
  }

  /** Bounding sphere and probes from the current height range. */
  bounds(): void {
    const lonC = (this.w + this.e) / 2;
    const latC = (this.s + this.n) / 2;
    this.center = ecef(lonC, latC, (this.minH + this.maxH) / 2);
    this.top = [];
    this.bottom = [];
    for (const lon of [this.w, lonC, this.e]) {
      for (const lat of [this.s, latC, this.n]) {
        this.top.push(ecef(lon, lat, this.maxH));
        this.bottom.push(ecef(lon, lat, this.minH));
      }
    }
    let r = 0;
    for (const p of [...this.top, ...this.bottom]) r = Math.max(r, length(sub(p, this.center)));
    this.radius = r;
  }

  contains(lon: number, lat: number): boolean {
    return lon >= this.w && lon <= this.e && lat >= this.s && lat <= this.n;
  }

  get key(): string {
    return `${this.z}/${this.x}/${this.y}`;
  }
}

/** fetch() with a persistent Cache Storage layer. */
class TileCache {
  private cache?: Promise<Cache | undefined>;
  hits = 0;
  downloads = 0;

  open(name: string): void {
    this.cache = "caches" in self ? caches.open(name).catch(() => undefined) : Promise.resolve(undefined);
  }

  async get(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
    const cache = await this.cache;
    const hit = await cache?.match(url);
    if (hit) {
      this.hits++;
      return hit.arrayBuffer();
    }
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const buf = await res.arrayBuffer();
    this.downloads++;
    cache?.put(url, new Response(buf)).catch(() => undefined);
    return buf;
  }
}

export class Terrain {
  readonly group = new THREE.Group();
  private regions!: RegionsFile;
  private roots: Tile[] = [];
  private tiles = new Map<string, Tile>();
  private queue = new Map<string, Tile>();
  private loading = new Set<Tile>();
  private frame = 0;
  private rendered: Tile[] = [];
  private frustum = new THREE.Frustum();
  private sphere = new THREE.Sphere();
  private matrix = new THREE.Matrix4();
  private canvas = new OffscreenCanvas(1, 1);
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  private terrainCache = new TileCache();
  private imageryCache = new TileCache();
  private gpuBytes = 0;
  private loaded = 0;
  private wasted = 0;
  private aborted = 0;
  private cam: Vec3 = [0, 0, 0];
  private nadir: [number, number, number] = [0, 0, 0];
  private view: Vec3 = [0, 0, 1];
  stats = { rendered: 0, loading: 0, maxLevel: 0, gpuMB: 0, hits: 0, downloads: 0, wasted: 0, aborted: 0 };

  async init(): Promise<void> {
    this.regions = await (await fetch(`${TERRAIN_URL}/regions.json`, { cache: "no-cache" })).json();
    // A rebuilt tile set gets a new cache, so stale tiles are never shown.
    this.terrainCache.open(`atlas-terrain-${this.regions.built ?? "dev"}`);
    this.imageryCache.open("atlas-imagery-v1");
    this.roots = [this.tile(0, 0, 0), this.tile(0, 1, 0)];
  }

  /** Meshes currently drawn, for ground picking. */
  meshes(): THREE.Mesh[] {
    return this.rendered.map((t) => t.mesh!).filter(Boolean);
  }

  private tile(z: number, x: number, y: number, parent?: Tile): Tile {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = new Tile(z, x, y, this.regions.samples, parent?.minH, parent?.maxH);
      this.tiles.set(key, t);
    }
    return t;
  }

  private canRefine(t: Tile): boolean {
    const z = t.z + 1;
    if (z <= this.regions.maxGlobal) return true;
    return this.regions.regions.some(
      (r) => r.maxLevel >= z && t.w < r.bbox[2] && t.e > r.bbox[0] && t.s < r.bbox[3] && t.n > r.bbox[1],
    );
  }

  private imageryRegion(t: Tile): Region | undefined {
    return this.regions.regions.find(
      (r) => r.imagery && t.z >= 12 && t.w < r.bbox[2] && t.e > r.bbox[0] && t.s < r.bbox[3] && t.n > r.bbox[1],
    );
  }

  update(camera: THREE.PerspectiveCamera, cam: Vec3, screenHeight: number): void {
    this.frame++;
    this.cam = cam;
    this.nadir = geodetic(cam);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    this.view = [dir.x, dir.y, dir.z];
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    const k = screenHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));

    const render: Tile[] = [];
    const visit = (t: Tile): void => {
      if (this.culled(t)) return;
      t.lastUsed = this.frame;
      if (t.state !== "ready") {
        this.request(t);
        return;
      }
      const sse = (t.error * k) / this.distance(t);
      if (sse > MAX_SSE && this.canRefine(t)) {
        t.kids ??= [0, 1].flatMap((j) => [0, 1].map((i) => this.tile(t.z + 1, 2 * t.x + i, 2 * t.y + j, t)));
        const live = t.kids.filter((c) => !this.culled(c));
        for (const c of live) {
          c.lastUsed = this.frame;
          this.request(c);
        }
        // Replace this tile only when every visible child can be drawn;
        // otherwise parent and children would overlap.
        if (live.every((c) => c.state === "ready")) {
          for (const c of live) visit(c);
          return;
        }
      }
      render.push(t);
    };
    for (const r of this.roots) visit(r);

    for (const t of this.rendered) {
      if (t.mesh) t.mesh.visible = false;
    }
    for (const t of render) {
      const m = t.mesh!;
      m.visible = true;
      t.drawn = true;
      m.position.set(t.center[0] - cam[0], t.center[1] - cam[1], t.center[2] - cam[2]);
    }
    this.rendered = render;
    this.cancelStale();
    this.pump();
    this.evict();
    this.stats = {
      rendered: render.length,
      loading: this.loading.size,
      maxLevel: render.reduce((m, t) => Math.max(m, t.z), 0),
      gpuMB: Math.round(this.gpuBytes / 2 ** 20),
      hits: this.terrainCache.hits + this.imageryCache.hits,
      downloads: this.terrainCache.downloads + this.imageryCache.downloads,
      wasted: this.wasted,
      aborted: this.aborted,
    };
  }

  /** Distance from the camera to the nearest part of the tile. */
  private distance(t: Tile): number {
    const [lon, lat, h] = this.nadir;
    if (t.contains(lon, lat)) return Math.max(1, h - t.maxH);
    let d = Infinity;
    for (const p of t.top) d = Math.min(d, length(sub(p, this.cam)));
    for (const p of t.bottom) d = Math.min(d, length(sub(p, this.cam)));
    return Math.max(1, d);
  }

  private culled(t: Tile): boolean {
    const cam = this.cam;
    this.sphere.center.set(t.center[0] - cam[0], t.center[1] - cam[1], t.center[2] - cam[2]);
    this.sphere.radius = t.radius;
    if (!this.frustum.intersectsSphere(this.sphere)) return true;
    if (t.z < 2 || t.contains(this.nadir[0], this.nadir[1])) return false;
    // Beyond the horizon: the Earth hides every probe at the tile's highest
    // point. The Earth is a sphere just inside the ellipsoid, so this never
    // hides anything visible.
    return t.top.every((p) => occluded(cam, p));
  }

  private request(t: Tile): void {
    if (t.state === "empty") this.queue.set(t.key, t);
  }

  /** Lower is more urgent: near the camera and near the view centre. */
  private priority(t: Tile): number {
    const rel = sub(t.center, this.cam);
    const d = length(rel);
    const off = 1 - dot(rel, this.view) / Math.max(d, 1); // 0 at the centre, 2 behind
    return this.distance(t) * (1 + 2 * off) * (t.z < 3 ? 1e-6 : 1);
  }

  private pump(): void {
    if (this.loading.size >= MAX_LOADS || this.queue.size === 0) return;
    const wanted = [...this.queue.values()]
      .filter((t) => t.state === "empty" && t.lastUsed === this.frame)
      .map((t) => [this.priority(t), t] as const)
      .sort((a, b) => a[0] - b[0]);
    this.queue.clear();
    for (const [, t] of wanted.slice(0, MAX_LOADS - this.loading.size)) {
      t.state = "loading";
      t.abort = new AbortController();
      this.loading.add(t);
      this.load(t, t.abort.signal)
        .then(() => {
          t.state = "ready";
          this.loaded++;
        })
        .catch((err) => {
          if (t.abort?.signal.aborted) {
            t.state = "empty";
          } else {
            console.warn(`tile ${t.key}`, err);
            t.state = "failed";
          }
        })
        .finally(() => {
          this.loading.delete(t);
          t.abort = undefined;
        });
    }
  }

  /** Abort loads for tiles that left the view or are no longer needed. */
  private cancelStale(): void {
    for (const t of this.loading) {
      if (t.lastUsed < this.frame - ABORT_AFTER) {
        t.abort?.abort();
        this.aborted++;
      }
    }
  }

  private evict(): void {
    if (this.gpuBytes <= GPU_BUDGET) return;
    const old = [...this.tiles.values()]
      .filter((t) => t.z > 0 && t.mesh && t.lastUsed < this.frame - 2)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old) {
      if (this.gpuBytes <= GPU_BUDGET * 0.9) break;
      this.dispose(t);
    }
    // Forget tiles that were never loaded and are long out of use.
    if (this.tiles.size > 4000) {
      for (const t of this.tiles.values()) {
        if (!t.mesh && t.state !== "loading" && t.z > 0 && t.lastUsed < this.frame - 600) this.forget(t);
      }
    }
  }

  private dispose(t: Tile): void {
    if (t.mesh) {
      if (!t.drawn) this.wasted++;
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      const mat = t.mesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.gpuBytes -= t.bytes;
    }
    this.forget(t);
  }

  private forget(t: Tile): void {
    this.tiles.delete(t.key);
    // Drop the link from the parent so it is recreated when needed.
    const parent = this.tiles.get(`${t.z - 1}/${t.x >> 1}/${t.y >> 1}`);
    if (parent) parent.kids = undefined;
  }

  private async load(t: Tile, signal: AbortSignal): Promise<void> {
    const [heights, image] = await Promise.all([
      this.heights(t, signal),
      this.imagery(t, signal).catch((err) => {
        if (signal.aborted) throw err;
        console.warn(`imagery ${t.key}`, err);
        return createImageBitmap(new ImageData(new Uint8ClampedArray([90, 90, 90, 255]), 1, 1));
      }),
    ]);
    if (signal.aborted) {
      image.close();
      throw new Error("aborted");
    }
    // Real heights tighten the bounds used for culling and distance.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of heights) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    t.minH = lo;
    t.maxH = hi;
    t.bounds();

    const geometry = this.geometry(t, heights);
    const map = new THREE.Texture(image);
    map.flipY = false;
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    map.generateMipmaps = true;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.needsUpdate = true;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide }));
    mesh.visible = false;
    this.group.add(mesh);
    t.mesh = mesh;
    const verts = geometry.getAttribute("position").count;
    t.bytes = verts * 20 + (geometry.index?.count ?? 0) * 2 + Math.round(image.width * image.height * 4 * 1.34);
    this.gpuBytes += t.bytes;
  }

  private async heights(t: Tile, signal: AbortSignal): Promise<Float32Array> {
    const buf = await this.terrainCache.get(`${TERRAIN_URL}/${t.key}.png`, signal);
    const bmp = await createImageBitmap(new Blob([buf], { type: "image/png" }), { colorSpaceConversion: "none" });
    const n = this.regions.samples;
    this.canvas.width = n;
    this.canvas.height = n;
    this.ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const px = this.ctx.getImageData(0, 0, n, n).data;
    const h = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) {
      h[i] = (px[4 * i] * 65536 + px[4 * i + 1] * 256 + px[4 * i + 2]) / 10 - 10000;
    }
    return h;
  }

  private async imagery(t: Tile, signal: AbortSignal): Promise<ImageBitmap> {
    const region = this.imageryRegion(t);
    let url: string;
    if (region) {
      const p = new URLSearchParams({
        SERVICE: "WMS", REQUEST: "GetMap", VERSION: "1.3.0", LAYERS: "by_dop40c", STYLES: "",
        CRS: "EPSG:4326", BBOX: `${t.s},${t.w},${t.n},${t.e}`, WIDTH: "512", HEIGHT: "512",
        FORMAT: "image/jpeg",
      });
      url = `${DOP40_URL}?${p}`;
    } else {
      // EOX serves 18 levels; deeper tiles reuse an ancestor's image.
      const z = Math.min(t.z, 17);
      const d = t.z - z;
      url = `${EOX_URL}/${z}/${t.y >> d}/${t.x >> d}.jpg`;
    }
    const buf = await this.imageryCache.get(url, signal);
    // The Bavarian WMS labels its JPEGs text/html, so set the type ourselves.
    return createImageBitmap(new Blob([buf], { type: "image/jpeg" }));
  }

  private geometry(t: Tile, h: Float32Array): THREE.BufferGeometry {
    const n = this.regions.samples;
    const count = n * n + 4 * n;
    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const [cx, cy, cz] = t.center;
    const put = (i: number, lon: number, lat: number, height: number, u: number, v: number) => {
      const p = ecef(lon, lat, height);
      pos[3 * i] = p[0] - cx;
      pos[3 * i + 1] = p[1] - cy;
      pos[3 * i + 2] = p[2] - cz;
      uv[2 * i] = u;
      uv[2 * i + 1] = v;
    };
    for (let r = 0; r < n; r++) {
      const lat = t.n - ((t.n - t.s) * r) / (n - 1);
      for (let c = 0; c < n; c++) {
        const lon = t.w + ((t.e - t.w) * c) / (n - 1);
        put(r * n + c, lon, lat, h[r * n + c], c / (n - 1), r / (n - 1));
      }
    }
    // Skirts hide cracks between tiles of different levels.
    const skirt = Math.max(30, t.error * 4);
    const edges = [
      (i: number) => i,                         // north row
      (i: number) => (n - 1) * n + i,           // south row
      (i: number) => i * n,                     // west column
      (i: number) => i * n + n - 1,             // east column
    ];
    const index: number[] = [];
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = r * n + c;
        index.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    }
    edges.forEach((edge, e) => {
      for (let i = 0; i < n; i++) {
        const src = edge(i);
        const r = Math.floor(src / n);
        const c = src % n;
        const lat = t.n - ((t.n - t.s) * r) / (n - 1);
        const lon = t.w + ((t.e - t.w) * c) / (n - 1);
        const dst = n * n + e * n + i;
        put(dst, lon, lat, h[src] - skirt, c / (n - 1), r / (n - 1));
        if (i < n - 1) {
          const a = edge(i);
          const b = edge(i + 1);
          const a2 = dst;
          const b2 = dst + 1;
          index.push(a, a2, b, b, a2, b2);
        }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(index);
    g.computeBoundingSphere();
    return g;
  }
}

const OCCLUDER_R = 6356000; // below the polar radius and the lowest sea floor near land

/** Whether the line from the camera to p passes through the occluder sphere. */
function occluded(cam: Vec3, p: Vec3): boolean {
  const horizonSq = dot(cam, cam) - OCCLUDER_R * OCCLUDER_R; // squared distance to the horizon
  if (horizonSq <= 0) return false;
  const v = sub(p, cam);
  const along = -dot(v, cam);
  return along > horizonSq && (along * along) / dot(v, v) > horizonSq;
}
