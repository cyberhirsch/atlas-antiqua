// Clustering at low zoom (PRD G4): sites that pass the filters but are too
// far away to be drawn individually are counted per screen cell and shown
// as numbered bubbles; zooming in replaces them by single sites.

import * as THREE from "three";
import { Vec3, dot, length, sub } from "./geo";
import type { Site, Sites } from "./sites";

const CELL_PX = 70;
const MIN_COUNT = 3;

export class Clusters {
  private layer: HTMLDivElement;
  private pool: HTMLButtonElement[] = [];
  onPick?: (lon: number, lat: number, range: number) => void;
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.layer = document.createElement("div");
    this.layer.className = "clusters";
    parent.appendChild(this.layer);
  }

  update(sites: Sites, camera: THREE.PerspectiveCamera, cam: Vec3, w: number, h: number, range: number): void {
    const cells = new Map<string, { n: number; x: number; y: number; lon: number; lat: number }>();
    for (const s of sites.sites) {
      if (!this.candidate(s, sites, cam)) continue;
      const rel = sub(s.pos, cam);
      this.v.set(rel[0], rel[1], rel[2]).project(camera);
      if (this.v.z > 1 || Math.abs(this.v.x) > 1 || Math.abs(this.v.y) > 1) continue;
      const x = ((this.v.x + 1) / 2) * w;
      const y = ((1 - this.v.y) / 2) * h;
      const key = `${Math.floor(x / CELL_PX)},${Math.floor(y / CELL_PX)}`;
      const c = cells.get(key) ?? { n: 0, x: 0, y: 0, lon: 0, lat: 0 };
      c.n++;
      c.x += x;
      c.y += y;
      c.lon += s.lon;
      c.lat += s.lat;
      cells.set(key, c);
    }
    let i = 0;
    for (const c of cells.values()) {
      if (c.n < MIN_COUNT) continue;
      const b = this.pool[i] ?? this.make();
      b.hidden = false;
      b.textContent = c.n >= 1000 ? `${(c.n / 1000).toFixed(1)}k` : String(c.n);
      const size = Math.min(16 + Math.log2(c.n) * 5, 52);
      b.style.width = b.style.height = `${size}px`;
      b.style.transform = `translate(${c.x / c.n - size / 2}px, ${c.y / c.n - size / 2}px)`;
      const lon = c.lon / c.n;
      const lat = c.lat / c.n;
      b.onclick = () => this.onPick?.(lon, lat, Math.max(range / 4, 5000));
      i++;
    }
    for (; i < this.pool.length; i++) this.pool[i].hidden = true;
  }

  /** Passes filters and time, faces the camera, but is beyond its view distance. */
  private candidate(s: Site, sites: Sites, cam: Vec3): boolean {
    if (s.viewKm === null || !sites.visible(s)) return false;
    const rel = sub(s.pos, cam);
    if (dot(rel, s.pos) > 0) return false;
    return length(rel) > s.viewKm * 1000;
  }

  private make(): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "cluster";
    b.title = "Sites here; click to zoom in";
    this.layer.appendChild(b);
    this.pool.push(b);
    return b;
  }

  clear(): void {
    for (const b of this.pool) b.hidden = true;
  }
}
