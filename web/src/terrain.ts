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
import { Vec3, dot, ecef, enu, geodetic, length, sub } from "./geo";

const BASE = import.meta.env.BASE_URL;
const TILES_URL = `${BASE}tiles`;
const EOX_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless/default/WGS84";
const DOP40_URL = "https://geoservices.bayern.de/od/wms/dop/v1/dop40";

const MAX_LOADS = 10;             // concurrent tile loads
const ABORT_AFTER = 30;           // frames a loading tile may go unused
const LOAD_TIMEOUT = 20000;       // ms before a hanging load is aborted and retried
const RETRY_AFTER = 10000;        // ms before a failed tile is tried again
const KEEP_MS = 5000;             // unused tiles stay at least this long
const KEEP_LEVEL = 6;             // levels up to this are never evicted
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
  usedAt = 0; // performance.now() of the last frame that needed it
  bytes = 0;
  drawn = false;
  heights?: Float32Array; // full-resolution samples, kept for height lookups
  refined = false; // replaced by its children in the last frame
  abort?: AbortController;
  failedAt = 0;

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
  private terrainCache = new TileCache();
  private imageryCache = new TileCache();
  private gpuBytes = 0;
  private loaded = 0;
  private wasted = 0;
  private aborted = 0;
  private cam: Vec3 = [0, 0, 0];
  private nadir: [number, number, number] = [0, 0, 0];
  private view: Vec3 = [0, 0, 1];
  /** Set from the device profile and adapted to the frame rate (quality.ts). */
  quality = { sse: 2.5, imagePx: 512, budgetBytes: 300 * 2 ** 20, meshStep: 1 };
  /**
   * GPU displacement (PRD §9.1, ?terrain=gpu): tiles from level 11 share one
   * grid mesh that the vertex shader raises from a height texture, in the
   * tile's local frame with second-order curvature terms (error against
   * exact positions: 2 cm at level 11, 0.3 mm at level 14). Coarser tiles and the sea-floor set use CPU meshes.
   */
  gpuDisplace = new URLSearchParams(location.search).get("terrain") === "gpu";
  private grids = new Map<number, THREE.BufferGeometry>();
  stats = { rendered: 0, loading: 0, maxLevel: 0, gpuMB: 0, hits: 0, downloads: 0, wasted: 0, aborted: 0 };

  /** Tile set: "terrain" (sea surface at 0) or "terrain-sea" (ETOPO sea floor, G6). */
  private set = "terrain";
  /** Water below this EGM2008 height is tinted (sea-floor set only). */
  readonly sea = { uSeaOn: { value: 0 }, uSeaLevel: { value: 0 } };
  private occlusion = new Map<Tile, { frame: number; hidden: boolean }>();
  /** Hide terrain (AR on site shows the camera image instead). */
  visible = true;

  async init(): Promise<void> {
    this.regions = await (await fetch(`${TILES_URL}/${this.set}/regions.json`, { cache: "no-cache" })).json();
    // A rebuilt tile set gets a new cache, so stale tiles are never shown.
    this.terrainCache.open(`atlas-${this.set}-${this.regions.built ?? "dev"}`);
    this.imageryCache.open("atlas-imagery-v1");
    this.roots = [this.tile(0, 0, 0), this.tile(0, 1, 0)];
  }

  /** Switch between the plain terrain and the sea-floor set (G6). */
  async setSeaFloor(on: boolean): Promise<void> {
    const set = on ? "terrain-sea" : "terrain";
    this.sea.uSeaOn.value = on ? 1 : 0;
    if (set === this.set) return;
    for (const t of this.loading) t.abort?.abort();
    for (const t of [...this.tiles.values()]) {
      if (t.mesh) this.dispose(t);
      else this.tiles.delete(t.key);
    }
    this.rendered = [];
    this.occlusion.clear();
    this.set = set;
    await this.init();
  }

  /**
   * Terrain height (m above the ellipsoid) at lon/lat from the finest loaded
   * tile, bilinear; undefined before the root tiles have loaded.
   */
  heightAt(lon: number, lat: number): number | undefined {
    const root = this.roots.find((r) => r.contains(lon, lat));
    if (!root?.heights) return undefined;
    let t: Tile = root;
    for (;;) {
      const kid: Tile | undefined = t.kids?.find((k) => k.heights !== undefined && k.contains(lon, lat));
      if (!kid) break;
      t = kid;
    }
    const n = this.regions.samples;
    const c = ((lon - t.w) / (t.e - t.w)) * (n - 1);
    const r = ((t.n - lat) / (t.n - t.s)) * (n - 1);
    const c0 = Math.min(Math.max(Math.floor(c), 0), n - 2);
    const r0 = Math.min(Math.max(Math.floor(r), 0), n - 2);
    const fc = c - c0;
    const fr = r - r0;
    const h = t.heights!;
    return h[r0 * n + c0] * (1 - fr) * (1 - fc) + h[r0 * n + c0 + 1] * (1 - fr) * fc
      + h[(r0 + 1) * n + c0] * fr * (1 - fc) + h[(r0 + 1) * n + c0 + 1] * fr * fc;
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

  /**
   * Choose and position tiles. cam: camera position (ECEF) for level of
   * detail and culling; origin: floating origin that meshes are placed
   * relative to (the camera, or the XR anchor).
   */
  update(camera: THREE.PerspectiveCamera, cam: Vec3, screenHeight: number, origin: Vec3 = cam): void {
    this.group.visible = this.visible;
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
    const now = performance.now();
    const visit = (t: Tile): void => {
      if (this.culled(t)) return;
      t.lastUsed = this.frame;
      t.usedAt = now;
      if (t.state !== "ready") {
        this.request(t);
        return;
      }
      const sse = (t.error * k) / this.distance(t);
      // Hysteresis: a refined tile stays refined until clearly coarse enough,
      // so tiles on the threshold do not flip between levels.
      const threshold = t.refined ? this.quality.sse * 0.7 : this.quality.sse;
      t.refined = false;
      if (sse > threshold && this.canRefine(t)) {
        t.kids ??= [0, 1].flatMap((j) => [0, 1].map((i) => this.tile(t.z + 1, 2 * t.x + i, 2 * t.y + j, t)));
        const live = t.kids.filter((c) => !this.culled(c));
        for (const c of live) {
          c.lastUsed = this.frame;
          c.usedAt = now;
          this.request(c);
        }
        // Replace this tile only when every visible child can be drawn;
        // otherwise parent and children would overlap.
        if (live.every((c) => c.state === "ready")) {
          t.refined = true;
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
      m.position.set(t.center[0] - origin[0], t.center[1] - origin[1], t.center[2] - origin[2]);
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
    if (t.top.every((p) => occluded(cam, p))) return true;
    return t.z >= 9 && this.hiddenByTerrain(t);
  }

  /**
   * Hidden behind terrain (a mountain in front of a valley): every probe at
   * the tile's top is blocked by loaded terrain along the line of sight.
   * Checked every 15 frames per tile; only when the camera is near the
   * ground, where it matters.
   */
  private hiddenByTerrain(t: Tile): boolean {
    const [lon, lat, h] = this.nadir;
    const ground = this.heightAt(lon, lat);
    if (ground === undefined || h - ground > 5000) return false;
    const cached = this.occlusion.get(t);
    if (cached && this.frame - cached.frame < 15) return cached.hidden;
    const cam = this.cam;
    const blocked = (p: Vec3) => {
      for (let i = 1; i < 12; i++) {
        const f = i / 12;
        const q: Vec3 = [cam[0] + (p[0] - cam[0]) * f, cam[1] + (p[1] - cam[1]) * f, cam[2] + (p[2] - cam[2]) * f];
        const [qlon, qlat, qh] = geodetic(q);
        const g = this.heightAt(qlon, qlat);
        if (g !== undefined && qh < g - 10) return true;
      }
      return false;
    };
    const hidden = t.top.every(blocked);
    this.occlusion.set(t, { frame: this.frame, hidden });
    return hidden;
  }

  private request(t: Tile): void {
    if (t.state === "failed" && performance.now() - t.failedAt > RETRY_AFTER) t.state = "empty";
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
      const abort = new AbortController();
      t.abort = abort;
      this.loading.add(t);
      // A step that never settles (e.g. image decoding started in a hidden
      // tab) would block the tile forever; abort it and let it retry.
      const timer = setTimeout(() => abort.abort(), LOAD_TIMEOUT);
      const aborted = new Promise<never>((_, reject) =>
        abort.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      Promise.race([this.load(t, abort.signal), aborted])
        .then(() => {
          t.state = "ready";
          this.loaded++;
        })
        .catch((err) => {
          if (abort.signal.aborted) {
            t.state = "empty";
          } else {
            console.warn(`tile ${t.key}`, err);
            t.state = "failed";
            t.failedAt = performance.now();
          }
        })
        .finally(() => {
          clearTimeout(timer);
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
    const budget = this.quality.budgetBytes;
    if (this.gpuBytes <= budget) return;
    // Tiles unused for a few seconds go first, finest and oldest first; only
    // when far over budget are recently used ones taken. Coarse levels stay
    // as a fallback, so turning the camera never shows holes.
    const now = performance.now();
    const over = this.gpuBytes > budget * 1.3;
    const old = [...this.tiles.values()]
      .filter((t) => t.z > KEEP_LEVEL && t.mesh && t.lastUsed < this.frame - 2 && (over || now - t.usedAt > KEEP_MS))
      .sort((a, b) => a.usedAt - b.usedAt || b.z - a.z);
    for (const t of old) {
      if (this.gpuBytes <= budget * 0.9) break;
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
      if (![...this.grids.values()].includes(t.mesh.geometry)) t.mesh.geometry.dispose();
      const mat = t.mesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      (mat.userData.heights as THREE.Texture | undefined)?.dispose();
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
    const [{ h: heights, geoid }, image] = await Promise.all([
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

    // Weak devices build meshes from every meshStep-th sample.
    const n = this.regions.samples;
    const step = this.quality.meshStep;
    const m = (n - 1) / step + 1;
    let grid = heights;
    if (step > 1) {
      grid = new Float32Array(m * m);
      for (let r = 0; r < m; r++) {
        for (let c = 0; c < m; c++) grid[r * m + c] = heights[r * step * n + c * step];
      }
    }
    const gpu = this.gpuDisplace && t.z >= 11 && !geoid;
    const geometry = gpu ? this.sharedGrid(m) : this.geometry(t, grid, m, geoid);
    t.heights = heights;
    const map = new THREE.Texture(image);
    map.flipY = false;
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    map.generateMipmaps = true;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.needsUpdate = true;
    const mesh = new THREE.Mesh(geometry, gpu ? this.gpuMaterial(map, t, grid, m) : this.material(map));
    mesh.frustumCulled = !gpu; // the shared grid's bounds say nothing; tiles are culled above
    mesh.visible = false;
    this.group.add(mesh);
    t.mesh = mesh;
    const verts = geometry.getAttribute("position").count;
    t.bytes = verts * 20 + (geometry.index?.count ?? 0) * 2 + Math.round(image.width * image.height * 4 * 1.34);
    this.gpuBytes += t.bytes;
  }

  private async heights(t: Tile, signal: AbortSignal): Promise<{ h: Float32Array; geoid?: Float32Array }> {
    // gzip of int32 decimetre deltas (scripts/build_terrain.py). Not an
    // image: browsers may alter image colours, which corrupts packed heights.
    // Sea-floor tiles append 9 x 9 geoid heights (absolute decimetres).
    const buf = await this.terrainCache.get(`${TILES_URL}/${this.set}/${t.key}.hgt`, signal);
    const raw = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const d = new Int32Array(raw);
    const n = this.regions.samples;
    if (d.length !== n * n && d.length !== n * n + 81) throw new Error(`terrain ${t.key}: ${d.length} samples`);
    const h = new Float32Array(n * n);
    let v = 0;
    for (let i = 0; i < n * n; i++) {
      v += d[i];
      h[i] = v / 10;
    }
    const geoid = d.length > n * n ? Float32Array.from(d.subarray(n * n), (x) => x / 10) : undefined;
    return { h, geoid };
  }

  /** Grid of m x m vertices plus skirts, shared by all GPU-displaced tiles. */
  private sharedGrid(m: number): THREE.BufferGeometry {
    let g = this.grids.get(m);
    if (g) return g;
    const count = m * m + 4 * m;
    const uv = new Float32Array(count * 2);
    const skirt = new Float32Array(count);
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) uv.set([c / (m - 1), r / (m - 1)], 2 * (r * m + c));
    }
    const edges = [(i: number) => i, (i: number) => (m - 1) * m + i, (i: number) => i * m, (i: number) => i * m + m - 1];
    const index: number[] = [];
    for (let r = 0; r < m - 1; r++) {
      for (let c = 0; c < m - 1; c++) {
        const a = r * m + c;
        index.push(a, a + m, a + 1, a + 1, a + m, a + m + 1);
      }
    }
    edges.forEach((edge, e) => {
      for (let i = 0; i < m; i++) {
        const src = edge(i);
        const dst = m * m + e * m + i;
        uv.set([uv[2 * src], uv[2 * src + 1]], 2 * dst);
        skirt[dst] = 1;
        if (i < m - 1) index.push(src, dst, edge(i + 1), edge(i + 1), dst, dst + 1);
      }
    });
    g = new THREE.BufferGeometry();
    // Positions are computed in the shader; three.js still needs the attribute.
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("aSkirt", new THREE.BufferAttribute(skirt, 1));
    g.setIndex(index);
    this.grids.set(m, g);
    return g;
  }

  /** Material for a GPU-displaced tile: heights as a float texture. */
  private gpuMaterial(map: THREE.Texture, t: Tile, grid: Float32Array, m: number): THREE.MeshBasicMaterial {
    const heights = new THREE.DataTexture(grid, m, m, THREE.RedFormat, THREE.FloatType);
    heights.minFilter = heights.magFilter = THREE.NearestFilter;
    heights.needsUpdate = true;
    const lonC = (t.w + t.e) / 2;
    const latC = (t.s + t.n) / 2;
    const [e, n, u] = enu(lonC, latC);
    const phi = (latC * Math.PI) / 180;
    const e2 = 0.00669437999014;
    const w = Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const rN = 6378137 / w;                   // prime vertical radius
    const rM = (6378137 * (1 - e2)) / w ** 3; // meridian radius
    const deg = Math.PI / 180;
    // Tile centre at height 0; the mesh is placed at t.center (mid height).
    const c0 = ecef(lonC, latC, 0);
    const off = sub(c0, t.center);
    const uniforms = {
      uHeights: { value: heights },
      uE: { value: new THREE.Vector3(...e) },
      uN: { value: new THREE.Vector3(...n) },
      uU: { value: new THREE.Vector3(...u) },
      uOff: { value: new THREE.Vector3(...off) },
      // metres per unit u (east, at the centre latitude) and per unit v (south)
      uSpan: { value: new THREE.Vector2((t.e - t.w) * deg * rN * Math.cos(phi), (t.n - t.s) * deg * rM) },
      uRadii: { value: new THREE.Vector2(rN, rM) },
      uTanLat: { value: Math.tan(phi) },
      uTexel: { value: m },
      uSkirtDepth: { value: Math.max(30, t.error * 4) },
    };
    const mat = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
          attribute float aSkirt;
          uniform sampler2D uHeights;
          uniform vec3 uE; uniform vec3 uN; uniform vec3 uU; uniform vec3 uOff;
          uniform vec2 uSpan; uniform vec2 uRadii; uniform float uTanLat;
          uniform float uTexel; uniform float uSkirtDepth;`)
        .replace("#include <begin_vertex>", `
          vec2 tc = uv * (uTexel - 1.0) / uTexel + 0.5 / uTexel;
          float h = texture2D(uHeights, tc).r - aSkirt * uSkirtDepth;
          // Ground distances at height 0 from the tile centre; east-west
          // spacing shrinks with latitude across the tile.
          float y0 = (0.5 - uv.y) * uSpan.y;
          float x0 = (uv.x - 0.5) * uSpan.x * (1.0 - uTanLat * y0 / uRadii.y);
          // Height spreads points apart; latitude circles bend towards the
          // pole; the surface drops away from the tangent plane. Error
          // against exact ECEF: 2 cm at level 11, 0.3 mm at level 14.
          float x = x0 * (1.0 + h / uRadii.x);
          float y = y0 * (1.0 + h / uRadii.y) + x0 * x0 * uTanLat / (2.0 * uRadii.x);
          float drop = x0 * x0 / (2.0 * uRadii.x) + y0 * y0 / (2.0 * uRadii.y);
          vec3 transformed = uOff + uE * x + uN * y + uU * (h - drop);`);
    };
    mat.customProgramCacheKey = () => "atlas-terrain-gpu";
    mat.userData.heights = heights;
    return mat;
  }

  /** Imagery material; with the sea-floor set, ground below sea level is tinted as water. */
  private material(map: THREE.Texture): THREE.MeshBasicMaterial {
    const mat = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.sea);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aOrtho;\nvarying float vOrtho;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvOrtho = aOrtho;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uSeaOn;\nuniform float uSeaLevel;\nvarying float vOrtho;")
        .replace("#include <map_fragment>", `#include <map_fragment>
          if (uSeaOn > 0.5 && vOrtho < uSeaLevel) {
            float depth = clamp((uSeaLevel - vOrtho) / 200.0, 0.0, 1.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.16, 0.42, 0.55), vec3(0.03, 0.12, 0.25), depth), 0.82);
          }`);
    };
    mat.customProgramCacheKey = () => "atlas-terrain-sea";
    return mat;
  }

  private async imagery(t: Tile, signal: AbortSignal): Promise<ImageBitmap> {
    const region = this.imageryRegion(t);
    let url: string;
    if (region) {
      const p = new URLSearchParams({
        SERVICE: "WMS", REQUEST: "GetMap", VERSION: "1.3.0", LAYERS: "by_dop40c", STYLES: "",
        CRS: "EPSG:4326", BBOX: `${t.s},${t.w},${t.n},${t.e}`, WIDTH: String(this.quality.imagePx), HEIGHT: String(this.quality.imagePx),
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

  private geometry(t: Tile, h: Float32Array, n: number, geoid?: Float32Array): THREE.BufferGeometry {
    const count = n * n + 4 * n;
    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    // Height above sea level (EGM2008) per vertex, for the water tint.
    const ortho = new Float32Array(count).fill(1e4);
    const geoidAt = (u: number, v: number) => {
      if (!geoid) return 0;
      const c = Math.min(u * 8, 7.999);
      const r = Math.min(v * 8, 7.999);
      const c0 = Math.floor(c);
      const r0 = Math.floor(r);
      const fc = c - c0;
      const fr = r - r0;
      return geoid[r0 * 9 + c0] * (1 - fr) * (1 - fc) + geoid[r0 * 9 + c0 + 1] * (1 - fr) * fc
        + geoid[(r0 + 1) * 9 + c0] * fr * (1 - fc) + geoid[(r0 + 1) * 9 + c0 + 1] * fr * fc;
    };
    const [cx, cy, cz] = t.center;
    const put = (i: number, lon: number, lat: number, height: number, u: number, v: number) => {
      const p = ecef(lon, lat, height);
      pos[3 * i] = p[0] - cx;
      pos[3 * i + 1] = p[1] - cy;
      pos[3 * i + 2] = p[2] - cz;
      uv[2 * i] = u;
      uv[2 * i + 1] = v;
      if (geoid) ortho[i] = height - geoidAt(u, v);
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
    g.setAttribute("aOrtho", new THREE.BufferAttribute(ortho, 1));
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
