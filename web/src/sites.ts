// Pleiades sites as points, filtered by the time slider. Points are grouped
// in 10° cells, each with its own origin, so float32 positions stay precise.

import * as THREE from "three";
import { Vec3, dot, ecef, sub } from "./geo";

export interface Site {
  id: string;
  name: string;
  lon: number;
  lat: number;
  h: number;
  start: number | null;
  end: number | null;
  category: string;
  confidence: number;
  precision: number | null;
  pos: Vec3;
}

export const CATEGORY_COLORS: Record<string, string> = {
  settlement: "#f2c14e",
  fortification: "#e4572e",
  religious: "#a06cd5",
  funerary: "#8d99ae",
  rural: "#76b041",
  building: "#f78e69",
  infrastructure: "#4cc9f0",
  production: "#c08552",
  site: "#ffffff",
  other: "#bbbbbb",
};

const UNDATED = -1e9;

interface Chunk {
  origin: Vec3;
  points: THREE.Points;
  sites: Site[];
}

export class Sites {
  readonly group = new THREE.Group();
  sites: Site[] = [];
  categories: string[] = [];
  private chunks: Chunk[] = [];
  readonly material: THREE.ShaderMaterial;
  year = 10100;
  allDates = true;
  hidden = new Set<string>();

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uYear: { value: this.year },
        uAll: { value: 1 },
        uSize: { value: 5 * window.devicePixelRatio },
        uCam: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */ `
        attribute float aStart;
        attribute float aEnd;
        attribute vec3 aColor;
        attribute float aShow;
        uniform float uYear;
        uniform float uAll;
        uniform float uSize;
        uniform vec3 uCam;
        varying vec3 vColor;
        void main() {
          bool undated = aStart < ${UNDATED / 2}.0;
          bool inTime = uAll > 0.5 || (!undated && aStart <= uYear && aEnd >= uYear);
          vColor = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vec3 rel = (modelMatrix * vec4(position, 1.0)).xyz;
          bool front = dot(rel, normalize(rel + uCam)) < 0.0;
          gl_PointSize = (inTime && front && aShow > 0.5) ? uSize : 0.0;
          if (gl_PointSize == 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          if (r > 0.5) discard;
          float edge = smoothstep(0.5, 0.35, r);
          gl_FragColor = vec4(mix(vec3(0.0), vColor, smoothstep(0.5, 0.42, r)), edge);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
  }

  async load(url: string): Promise<void> {
    const data = await (await fetch(url)).json();
    this.categories = data.categories;
    this.sites = data.rows.map((r: (string | number | null)[]) => {
      const [id, name, lon, lat, h, start, end, cat, conf, precision] = r as [
        string, string, number, number, number | null, number | null, number | null, number, number, number | null,
      ];
      return {
        id, name, lon, lat, h: h ?? 0, start, end,
        category: data.categories[cat], confidence: conf, precision,
        pos: ecef(lon, lat, (h ?? 0) + 2),
      };
    });
    const cells = new Map<string, Site[]>();
    for (const s of this.sites) {
      const key = `${Math.floor(s.lon / 10)},${Math.floor(s.lat / 10)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key)!.push(s);
    }
    for (const sites of cells.values()) {
      const origin = sites[0].pos;
      const pos = new Float32Array(sites.length * 3);
      const start = new Float32Array(sites.length);
      const end = new Float32Array(sites.length);
      const color = new Float32Array(sites.length * 3);
      const show = new Float32Array(sites.length).fill(1);
      const c = new THREE.Color();
      sites.forEach((s, i) => {
        const d = sub(s.pos, origin);
        pos.set(d, 3 * i);
        start[i] = s.start ?? UNDATED;
        end[i] = s.end ?? UNDATED;
        c.set(CATEGORY_COLORS[s.category] ?? "#ffffff");
        color.set([c.r, c.g, c.b], 3 * i);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aStart", new THREE.BufferAttribute(start, 1));
      g.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
      g.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
      g.setAttribute("aShow", new THREE.BufferAttribute(show, 1));
      const points = new THREE.Points(g, this.material);
      points.frustumCulled = false;
      points.renderOrder = 10;
      this.group.add(points);
      this.chunks.push({ origin, points, sites });
    }
  }

  setTime(year: number, all: boolean): void {
    this.year = year;
    this.allDates = all;
    this.material.uniforms.uYear.value = year;
    this.material.uniforms.uAll.value = all ? 1 : 0;
  }

  setHidden(hidden: Set<string>): void {
    this.hidden = hidden;
    for (const ch of this.chunks) {
      const attr = ch.points.geometry.getAttribute("aShow") as THREE.BufferAttribute;
      ch.sites.forEach((s, i) => attr.setX(i, hidden.has(s.category) ? 0 : 1));
      attr.needsUpdate = true;
    }
  }

  visible(s: Site): boolean {
    if (this.hidden.has(s.category)) return false;
    if (this.allDates) return true;
    return s.start !== null && s.end !== null && s.start <= this.year && s.end >= this.year;
  }

  update(cam: Vec3): void {
    this.material.uniforms.uCam.value.set(cam[0], cam[1], cam[2]);
    for (const ch of this.chunks) {
      ch.points.position.set(ch.origin[0] - cam[0], ch.origin[1] - cam[1], ch.origin[2] - cam[2]);
    }
  }

  /** Nearest visible site to a screen position, within maxPx. */
  pick(x: number, y: number, camera: THREE.PerspectiveCamera, cam: Vec3, w: number, h: number, maxPx = 8): Site | undefined {
    const v = new THREE.Vector3();
    let best: Site | undefined;
    let bestD = maxPx;
    for (const s of this.sites) {
      if (!this.visible(s)) continue;
      const rel = sub(s.pos, cam);
      if (dot(rel, s.pos) > 0) continue; // far side of the globe
      v.set(rel[0], rel[1], rel[2]).project(camera);
      if (v.z > 1) continue;
      const sx = ((v.x + 1) / 2) * w;
      const sy = ((1 - v.y) / 2) * h;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
}
