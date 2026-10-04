// 3D assets at their true position and scale (PRD A1, A2): photogrammetry
// meshes (GLB, meshopt-compressed) and Gaussian splats (Spark), listed in
// assets/assets.json by scripts/add_asset.py. Shown near the camera and
// within the time selection, so the slider switches between phases of a
// site (A5); the asset panel also toggles phases by hand. A placement tool
// moves, turns and scales an asset and copies the manifest entry (A4).

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { Vec3, ecef, enu, sub, yearLabel } from "./geo";
import type { TimeSelection } from "./sites";

const BASE = import.meta.env.BASE_URL;
const SHOW_WITHIN = 30000; // metres from the camera
const DEG = Math.PI / 180;

export interface AssetInfo {
  id: string;
  name: string;
  kind: "mesh" | "splat" | "points";
  url: string;
  lon: number;
  lat: number;
  h: number | null; // ellipsoidal; null = on the terrain
  heading: number;  // degrees clockwise from north
  scale: number;
  up: "y" | "z";
  site: string | null;
  start: number | null;
  end: number | null;
  captured: string | null;
  creator: string;
  licence: string;
  source: string | null;
  note: string | null;
}

interface Loaded {
  info: AssetInfo;
  root: THREE.Group;      // placed in ECEF, floating origin
  inner?: THREE.Object3D; // the loaded model
  state: "loading" | "ready" | "failed";
  hidden: boolean;        // switched off by hand (phase toggle)
}

export class Assets {
  readonly group = new THREE.Group();
  list: AssetInfo[] = [];
  private loaded = new Map<string, Loaded>();
  private gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private spark?: Promise<typeof import("@sparkjsdev/spark")>;
  private time: TimeSelection = { all: true, start: 0, end: 0 };
  private placing?: Loaded;
  onChange?: () => void;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private heightAt: (lon: number, lat: number) => number | undefined) {}

  async init(): Promise<void> {
    try {
      const res = await fetch(`${BASE}assets/assets.json`);
      this.list = res.ok ? await res.json() : [];
    } catch {
      this.list = [];
    }
  }

  sitesWithAssets(): Set<string> {
    return new Set(this.list.map((a) => a.site).filter(Boolean) as string[]);
  }

  forSite(site: string): AssetInfo[] {
    return this.list.filter((a) => a.site === site).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  }

  setTime(t: TimeSelection): void {
    this.time = t;
  }

  private inTime(a: AssetInfo): boolean {
    if (this.time.all || a.start === null || a.end === null) return true;
    return a.start <= this.time.end && a.end >= this.time.start;
  }

  setHidden(id: string, hidden: boolean): void {
    const l = this.loaded.get(id);
    if (l) l.hidden = hidden;
    else if (!hidden) this.ensure(this.list.find((a) => a.id === id)!).hidden = false;
  }

  isHidden(id: string): boolean {
    return this.loaded.get(id)?.hidden ?? false;
  }

  update(cam: Vec3): void {
    for (const a of this.list) {
      const at = ecef(a.lon, a.lat, a.h ?? 0);
      const near = Math.hypot(...sub(at, cam)) < SHOW_WITHIN;
      if (near && !this.loaded.has(a.id)) this.ensure(a);
      const l = this.loaded.get(a.id);
      if (!l) continue;
      l.root.visible = near && !l.hidden && this.inTime(a) && l.state === "ready";
      if (l.root.visible) this.place(l, cam);
    }
  }

  private ensure(a: AssetInfo): Loaded {
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    const l: Loaded = { info: a, root, state: "loading", hidden: false };
    this.loaded.set(a.id, l);
    this.group.add(root);
    this.load(l).then(
      () => (l.state = "ready"),
      (err) => {
        console.warn(`asset ${a.id}`, err);
        l.state = "failed";
      },
    );
    return l;
  }

  private async load(l: Loaded): Promise<void> {
    const url = `${BASE}assets/${l.info.url}`;
    if (l.info.kind === "splat") {
      this.spark ??= import("@sparkjsdev/spark").then((m) => {
        // One Spark renderer draws all splats in the scene.
        this.scene.add(new m.SparkRenderer({ renderer: this.renderer }));
        return m;
      });
      const { SplatMesh } = await this.spark;
      const mesh = new SplatMesh({ url });
      await mesh.initialized;
      l.inner = mesh;
    } else {
      const g = await this.gltf.loadAsync(url);
      l.inner = g.scene;
    }
    // Z-up scans are turned to glTF's Y-up first. Scans come with arbitrary
    // local origins, so the model is centred on its footprint and set down
    // on its lowest point: the georeference names that point.
    const turn = new THREE.Group();
    if (l.info.up === "z") turn.rotation.x = -Math.PI / 2;
    turn.add(l.inner);
    turn.updateMatrixWorld(true);
    const box = "getBoundingBox" in l.inner
      ? (l.inner as unknown as { getBoundingBox(c?: boolean): THREE.Box3 }).getBoundingBox(true).clone().applyMatrix4(turn.matrix)
      : new THREE.Box3().setFromObject(turn);
    const centre = box.getCenter(new THREE.Vector3());
    turn.position.set(-centre.x, -box.min.y, -centre.z);
    l.root.add(turn);
  }

  /** Local frame at the asset: x east, y up, z south (three.js Y-up). */
  private place(l: Loaded, cam: Vec3): void {
    const a = l.info;
    const h = a.h ?? this.heightAt(a.lon, a.lat) ?? 0;
    const origin = ecef(a.lon, a.lat, h);
    const [e, n, u] = enu(a.lon, a.lat);
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...e), new THREE.Vector3(...u), new THREE.Vector3(-n[0], -n[1], -n[2]));
    const turn = new THREE.Matrix4().makeRotationY(-a.heading * DEG);
    const s = new THREE.Matrix4().makeScale(a.scale, a.scale, a.scale);
    const rel = sub(origin, cam);
    l.root.matrix.copy(basis).multiply(turn).multiply(s).setPosition(rel[0], rel[1], rel[2]);
    l.root.matrixWorldNeedsUpdate = true;
  }

  // --- placement tool (A4) -------------------------------------------------

  /** Panel to move, turn and scale an asset; returns the panel element. */
  placementPanel(id: string): HTMLElement {
    const l = this.loaded.get(id) ?? this.ensure(this.list.find((a) => a.id === id)!);
    this.placing = l;
    const a = l.info;
    const el = document.createElement("div");
    el.className = "placement";
    const field = (k: keyof AssetInfo, label: string, step: string) =>
      `<label>${label} <input data-k="${k}" type="number" step="${step}" value="${a[k] ?? ""}"></label>`;
    el.innerHTML = `
      <h4>Place “${a.name}”</h4>
      ${field("lon", "Longitude", "0.00001")}${field("lat", "Latitude", "0.00001")}
      ${field("h", "Height (m, ellipsoid; empty = on terrain)", "0.1")}
      ${field("heading", "Heading (°)", "0.5")}${field("scale", "Scale", "0.01")}
      <p class="hint">Keys while this panel is open: arrows move 1 m (Shift 10 m), , and . turn 1°, - and + scale 1%.</p>
      <div class="row"><button data-a="copy">Copy manifest entry</button><button data-a="done">Done</button></div>`;
    const sync = () => {
      for (const input of el.querySelectorAll<HTMLInputElement>("input[data-k]")) {
        const v = a[input.dataset.k as keyof AssetInfo];
        input.value = v === null || v === undefined ? "" : String(Number((v as number).toFixed(7)));
      }
    };
    el.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((input) => {
      input.addEventListener("keydown", (e) => e.stopPropagation());
      input.addEventListener("change", () => {
        const k = input.dataset.k as "lon" | "lat" | "h" | "heading" | "scale";
        (a as unknown as Record<string, number | null>)[k] = input.value === "" ? null : Number(input.value);
        this.onChange?.();
      });
    });
    const keys = (e: KeyboardEvent) => {
      if (this.placing !== l || (e.target instanceof HTMLInputElement)) return;
      const step = e.shiftKey ? 10 : 1;
      const dLat = step / 111320;
      const dLon = step / (111320 * Math.cos(a.lat * DEG));
      const k = e.key;
      if (k === "ArrowUp") a.lat += dLat;
      else if (k === "ArrowDown") a.lat -= dLat;
      else if (k === "ArrowRight") a.lon += dLon;
      else if (k === "ArrowLeft") a.lon -= dLon;
      else if (k === ",") a.heading -= 1;
      else if (k === ".") a.heading += 1;
      else if (k === "-") a.scale *= 0.99;
      else if (k === "+" || k === "=") a.scale *= 1.01;
      else return;
      e.preventDefault();
      sync();
    };
    window.addEventListener("keydown", keys);
    el.querySelector('[data-a="copy"]')!.addEventListener("click", async () => {
      const entry = JSON.stringify({ ...a }, null, 1);
      try {
        await navigator.clipboard.writeText(entry);
      } catch {
        prompt("Manifest entry", entry);
      }
    });
    el.querySelector('[data-a="done"]')!.addEventListener("click", () => {
      window.removeEventListener("keydown", keys);
      this.placing = undefined;
      el.remove();
    });
    return el;
  }

  describe(a: AssetInfo): string {
    const dates = a.start !== null && a.end !== null ? `${yearLabel(a.start)} – ${yearLabel(a.end)}` : "undated";
    return `${a.kind} · ${dates} · ${a.creator} · ${a.licence}`;
  }
}
