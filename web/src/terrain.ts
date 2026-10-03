// Terrain quadtree: height tiles from scripts/build_terrain.py, imagery from
// Sentinel-2 cloudless (EOX) or, in the Bavarian LiDAR area, DOP40 aerial
// photos. Tiles are refined by screen-space error, but only where the
// regions file says deeper data exists; elsewhere the globe stays coarse.

import * as THREE from "three";
import { Vec3, dot, ecef, length, sub } from "./geo";

const BASE = import.meta.env.BASE_URL;
const TERRAIN_URL = `${BASE}tiles/terrain`;
const EOX_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless/default/WGS84";
const DOP40_URL = "https://geoservices.bayern.de/od/wms/dop/v1/dop40";

const MAX_SSE = 2.5;        // refine while a height sample spans more pixels
const MAX_LOADS = 8;        // concurrent tile loads
const MAX_CACHED = 700;     // tiles kept in memory
const MAX_HEIGHT = 9000;    // for bounding spheres and horizon culling

interface Region {
  name: string;
  bbox: [number, number, number, number];
  maxLevel: number;
  imagery?: string;
}

interface RegionsFile {
  samples: number;
  maxGlobal: number;
  regions: Region[];
}

type State = "empty" | "loading" | "ready" | "failed";

class Tile {
  readonly w: number;
  readonly s: number;
  readonly e: number;
  readonly n: number;
  readonly center: Vec3;
  readonly radius: number;
  readonly probes: Vec3[];
  readonly error: number;
  state: State = "empty";
  mesh?: THREE.Mesh;
  kids?: Tile[];
  lastUsed = 0;

  constructor(readonly z: number, readonly x: number, readonly y: number, samples: number) {
    const span = 180 / 2 ** z;
    this.w = -180 + x * span;
    this.n = 90 - y * span;
    this.e = this.w + span;
    this.s = this.n - span;
    const lonC = (this.w + this.e) / 2;
    const latC = (this.s + this.n) / 2;
    this.center = ecef(lonC, latC, 0);
    this.probes = [];
    for (const lon of [this.w, lonC, this.e]) {
      for (const lat of [this.s, latC, this.n]) {
        this.probes.push(ecef(lon, lat, 0));
      }
    }
    let r = 0;
    for (const p of this.probes) {
      r = Math.max(r, length(sub(p, this.center)));
    }
    this.radius = r + MAX_HEIGHT;
    const cosLat = Math.max(Math.cos((Math.max(Math.abs(this.s), Math.abs(this.n)) * Math.PI) / 180), 0.05);
    const widthM = Math.max(span * 111320 * cosLat, span * 111320 * 0.5);
    this.error = widthM / (samples - 1);
  }

  get key(): string {
    return `${this.z}/${this.x}/${this.y}`;
  }
}

export class Terrain {
  readonly group = new THREE.Group();
  private regions!: RegionsFile;
  private roots: Tile[] = [];
  private tiles = new Map<string, Tile>();
  private queue = new Map<string, Tile>();
  private loading = 0;
  private frame = 0;
  private rendered: Tile[] = [];
  private frustum = new THREE.Frustum();
  private sphere = new THREE.Sphere();
  private matrix = new THREE.Matrix4();
  private canvas = new OffscreenCanvas(1, 1);
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  stats = { rendered: 0, cached: 0, loading: 0, maxLevel: 0 };

  async init(): Promise<void> {
    this.regions = await (await fetch(`${TERRAIN_URL}/regions.json`)).json();
    this.roots = [this.tile(0, 0, 0), this.tile(0, 1, 0)];
  }

  regionsList(): Region[] {
    return this.regions.regions;
  }

  /** Meshes currently drawn, for ground picking. */
  meshes(): THREE.Mesh[] {
    return this.rendered.map((t) => t.mesh!).filter(Boolean);
  }

  private tile(z: number, x: number, y: number): Tile {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = new Tile(z, x, y, this.regions.samples);
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
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    const k = screenHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));

    const render: Tile[] = [];
    const visit = (t: Tile): void => {
      if (this.culled(t, cam)) return;
      t.lastUsed = this.frame;
      if (t.state !== "ready") {
        this.request(t);
        return;
      }
      const dist = Math.max(1, length(sub(t.center, cam)) - t.radius + MAX_HEIGHT);
      const sse = (t.error * k) / dist;
      if (sse > MAX_SSE && this.canRefine(t)) {
        t.kids ??= [0, 1].flatMap((j) => [0, 1].map((i) => this.tile(t.z + 1, 2 * t.x + i, 2 * t.y + j)));
        const live = t.kids.filter((c) => !this.culled(c, cam));
        for (const c of live) {
          c.lastUsed = this.frame;
          if (c.state === "empty") this.request(c);
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
      m.position.set(t.center[0] - cam[0], t.center[1] - cam[1], t.center[2] - cam[2]);
    }
    this.rendered = render;
    this.pump(cam);
    this.evict();
    this.stats = {
      rendered: render.length,
      cached: this.tiles.size,
      loading: this.loading,
      maxLevel: render.reduce((m, t) => Math.max(m, t.z), 0),
    };
  }

  private culled(t: Tile, cam: Vec3): boolean {
    this.sphere.center.set(t.center[0] - cam[0], t.center[1] - cam[1], t.center[2] - cam[2]);
    this.sphere.radius = t.radius;
    if (!this.frustum.intersectsSphere(this.sphere)) return true;
    if (t.z < 2) return false;
    // Beyond the horizon: every probe faces away from the camera.
    return t.probes.every((p) => {
      const lp = length(p);
      return dot(p, sub(cam, p)) / lp < -t.radius;
    });
  }

  private request(t: Tile): void {
    if (t.state === "empty") this.queue.set(t.key, t);
  }

  private pump(cam: Vec3): void {
    if (this.loading >= MAX_LOADS || this.queue.size === 0) return;
    const wanted = [...this.queue.values()]
      .filter((t) => t.lastUsed >= this.frame - 1)
      .sort((a, b) => a.z - b.z || length(sub(a.center, cam)) - length(sub(b.center, cam)));
    this.queue.clear();
    for (const t of wanted.slice(0, MAX_LOADS - this.loading)) {
      t.state = "loading";
      this.loading++;
      this.load(t)
        .then(() => (t.state = "ready"))
        .catch((err) => {
          console.warn(`tile ${t.key}`, err);
          t.state = "failed";
        })
        .finally(() => this.loading--);
    }
  }

  private evict(): void {
    if (this.tiles.size <= MAX_CACHED) return;
    const old = [...this.tiles.values()]
      .filter((t) => t.z > 0 && t.lastUsed < this.frame - 2 && t.state !== "loading")
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old.slice(0, this.tiles.size - MAX_CACHED)) {
      if (t.mesh) {
        this.group.remove(t.mesh);
        t.mesh.geometry.dispose();
        const mat = t.mesh.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
      this.tiles.delete(t.key);
      // Drop the link from the parent so it is recreated when needed.
      const parent = this.tiles.get(`${t.z - 1}/${t.x >> 1}/${t.y >> 1}`);
      if (parent) parent.kids = undefined;
    }
  }

  private async load(t: Tile): Promise<void> {
    const [heights, image] = await Promise.all([
      this.heights(t),
      this.imagery(t).catch((err) => {
        console.warn(`imagery ${t.key}`, err);
        return createImageBitmap(new ImageData(new Uint8ClampedArray([90, 90, 90, 255]), 1, 1));
      }),
    ]);
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
    mesh.matrixAutoUpdate = true;
    this.group.add(mesh);
    t.mesh = mesh;
  }

  private async heights(t: Tile): Promise<Float32Array> {
    const res = await fetch(`${TERRAIN_URL}/${t.key}.png`);
    if (!res.ok) throw new Error(`terrain ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
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

  private async imagery(t: Tile): Promise<ImageBitmap> {
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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`imagery ${res.status}`);
    // The Bavarian WMS labels its JPEGs text/html, so set the type ourselves.
    const blob = new Blob([await res.arrayBuffer()], { type: "image/jpeg" });
    return createImageBitmap(blob);
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
          index.push(a, a2, b, b, a2, b2, a, b, a2, b, b2, a2); // both windings
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
