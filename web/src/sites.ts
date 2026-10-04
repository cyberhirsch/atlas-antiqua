// Pleiades sites as points. Points are grouped in 10° cells, each with its
// own origin, so float32 positions stay precise.
//
// Shown when: inside the time selection (fading out over a margin that grows
// as the date gets less certain, PRD T3), within the site's view distance,
// on the near side of the globe, and passing the filters (category, country,
// minimum confidence per axis, shapes or 3D assets). Marker style encodes the
// overall confidence (D8): filled 3+, ring 2, dashed ring 0-1. Points behind
// terrain are drawn faintly, so sites under coarse distant terrain stay visible.

import * as THREE from "three";
import { Vec3, dot, ecef, length, sub } from "./geo";

export interface Site {
  id: string;
  name: string;
  names: string;
  lon: number;
  lat: number;
  h: number;
  start: number | null;
  end: number | null;
  category: string;
  confidence: number;
  conf: [number, number, number, number]; // identity, position, elevation, time
  precision: number | null;
  viewKm: number | null; // null: shown from any distance
  periods: number[];
  country: string;
  hasShapes: boolean;
  degraded: boolean;
  source: "pleiades" | "wikidata";
  qid: string;       // Wikidata item, if linked
  wikipedia: string; // English Wikipedia article title, if any
  pos: Vec3;
}

export interface Period {
  id: string;
  label: string;
  start: number;
  end: number;
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

export interface Filters {
  hiddenCategories: Set<string>;
  country: string | null;
  minConf: [number, number, number, number];
  onlyShapes: boolean;
  onlyAssets: boolean;
}

export interface TimeSelection {
  all: boolean;
  start: number; // HE
  end: number;   // HE; equal to start for a single year
}

const UNDATED = -1e9;
const ALWAYS = 1e12; // metres
/** Fade margin in years by time confidence level 0..5 (T3). */
export const FADE_YEARS = [400, 250, 100, 25, 10, 5];

interface Chunk {
  origin: Vec3;
  points: THREE.Points;
  ghost: THREE.Points;
  sites: Site[];
}

const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aStart;
  attribute float aEnd;
  attribute float aFade;
  attribute vec3 aColor;
  attribute float aShow;
  attribute float aView;
  attribute vec4 aConf;
  attribute float aOverall;
  uniform float uStart;
  uniform float uEnd;
  uniform float uAll;
  uniform float uSize;
  uniform vec3 uCam;
  uniform vec4 uMinConf;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vOverall;
  void main() {
    bool undated = aStart < ${UNDATED / 2}.0;
    float alpha = 1.0;
    if (uAll < 0.5) {
      float gap = undated ? 1e9 : max(max(aStart - uEnd, uStart - aEnd), 0.0);
      alpha = 1.0 - smoothstep(0.0, aFade, gap);
    }
    bool conf = all(greaterThanEqual(aConf, uMinConf));
    vColor = aColor;
    vOverall = aOverall;
    vAlpha = alpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
    vec3 rel = (modelMatrix * vec4(position, 1.0)).xyz;
    bool front = dot(rel, normalize(rel + uCam)) < 0.0;
    bool near = length(rel) <= aView;
    bool show = alpha > 0.01 && front && near && conf && aShow > 0.5;
    gl_PointSize = show ? uSize : 0.0;
    if (!show) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }`;

const FRAGMENT = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uGhost;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vOverall;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    // Confidence: filled (3+), ring (2), dashed ring (0-1).
    if (vOverall < 2.5 && r < 0.27) discard;
    if (vOverall < 1.5 && mod(atan(d.y, d.x) + 3.1416, 1.0472) < 0.45) discard;
    float edge = smoothstep(0.5, 0.38, r);
    vec3 col = mix(vec3(0.0), vColor, smoothstep(0.5, 0.42, r));
    gl_FragColor = vec4(col, edge * vAlpha * (uGhost > 0.5 ? 0.3 : 1.0));
  }`;

export class Sites {
  readonly group = new THREE.Group();
  sites: Site[] = [];
  byId = new Map<string, Site>();
  categories: string[] = [];
  countries: string[] = [];
  periods: Period[] = [];
  private chunks: Chunk[] = [];
  readonly material: THREE.ShaderMaterial;
  readonly ghost: THREE.ShaderMaterial;
  time: TimeSelection = { all: true, start: 10100, end: 10100 };
  filters: Filters = {
    hiddenCategories: new Set(), country: null, minConf: [0, 0, 0, 0], onlyShapes: false, onlyAssets: false,
  };
  assetSites = new Set<string>();

  constructor() {
    const uniforms = {
      uStart: { value: 10100 },
      uEnd: { value: 10100 },
      uAll: { value: 1 },
      uSize: { value: 6 * Math.min(window.devicePixelRatio, 2) },
      uCam: { value: new THREE.Vector3() },
      uMinConf: { value: new THREE.Vector4() },
      uGhost: { value: 0 },
    };
    const base = { vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false };
    this.material = new THREE.ShaderMaterial({ ...base, uniforms, depthTest: true });
    // Same uniforms, drawn first without depth test and faint.
    this.ghost = new THREE.ShaderMaterial({ ...base, uniforms: { ...uniforms, uGhost: { value: 1 } }, depthTest: false });
  }

  async load(url: string): Promise<void> {
    const data = await (await fetch(url)).json();
    this.categories = data.categories;
    this.countries = data.countries;
    this.periods = data.periods;
    const F = Object.fromEntries((data.fields as string[]).map((f, i) => [f, i]));
    this.sites = data.rows.map((r: unknown[]) => {
      const h = (r[F.h] as number | null) ?? 0;
      return {
        id: r[F.id] as string,
        name: r[F.name] as string,
        names: r[F.names] as string,
        lon: r[F.lon] as number,
        lat: r[F.lat] as number,
        h,
        start: r[F.start] as number | null,
        end: r[F.end] as number | null,
        category: data.categories[r[F.category] as number],
        confidence: r[F.confidence] as number,
        conf: [r[F.conf_identity], r[F.conf_position], r[F.conf_elevation], r[F.conf_time]] as Site["conf"],
        precision: r[F.precision] as number | null,
        viewKm: r[F.view_km] as number | null,
        periods: r[F.periods] as number[],
        country: data.countries[r[F.country] as number],
        hasShapes: r[F.has_shapes] === 1,
        degraded: r[F.degraded] === 1,
        source: (r[F.source] as Site["source"]) ?? "pleiades",
        qid: (r[F.qid] as string) ?? "",
        wikipedia: (r[F.wikipedia] as string) ?? "",
        pos: ecef(r[F.lon] as number, r[F.lat] as number, h + 2),
      } satisfies Site;
    });
    for (const s of this.sites) this.byId.set(s.id, s);
    const cells = new Map<string, Site[]>();
    for (const s of this.sites) {
      const key = `${Math.floor(s.lon / 10)},${Math.floor(s.lat / 10)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key)!.push(s);
    }
    for (const sites of cells.values()) {
      const origin = sites[0].pos;
      const n = sites.length;
      const pos = new Float32Array(n * 3);
      const start = new Float32Array(n);
      const end = new Float32Array(n);
      const fade = new Float32Array(n);
      const color = new Float32Array(n * 3);
      const show = new Float32Array(n).fill(1);
      const view = new Float32Array(n);
      const conf = new Float32Array(n * 4);
      const overall = new Float32Array(n);
      const c = new THREE.Color();
      sites.forEach((s, i) => {
        pos.set(sub(s.pos, origin), 3 * i);
        start[i] = s.start ?? UNDATED;
        end[i] = s.end ?? UNDATED;
        fade[i] = FADE_YEARS[s.conf[3]] ?? 100;
        view[i] = s.viewKm === null ? ALWAYS : s.viewKm * 1000;
        c.set(CATEGORY_COLORS[s.category] ?? "#ffffff");
        color.set([c.r, c.g, c.b], 3 * i);
        conf.set(s.conf, 4 * i);
        overall[i] = s.confidence;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aStart", new THREE.BufferAttribute(start, 1));
      g.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
      g.setAttribute("aFade", new THREE.BufferAttribute(fade, 1));
      g.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
      g.setAttribute("aShow", new THREE.BufferAttribute(show, 1));
      g.setAttribute("aView", new THREE.BufferAttribute(view, 1));
      g.setAttribute("aConf", new THREE.BufferAttribute(conf, 4));
      g.setAttribute("aOverall", new THREE.BufferAttribute(overall, 1));
      const points = new THREE.Points(g, this.material);
      const ghost = new THREE.Points(g, this.ghost);
      for (const p of [points, ghost]) p.frustumCulled = false;
      ghost.renderOrder = 9;
      points.renderOrder = 10;
      this.group.add(ghost, points);
      this.chunks.push({ origin, points, ghost, sites });
    }
  }

  setTime(t: TimeSelection): void {
    this.time = t;
    const u = this.material.uniforms;
    u.uStart.value = t.start;
    u.uEnd.value = t.end;
    u.uAll.value = t.all ? 1 : 0;
  }

  setFilters(f: Filters): void {
    this.filters = f;
    this.material.uniforms.uMinConf.value.set(...f.minConf);
    for (const ch of this.chunks) {
      const attr = ch.points.geometry.getAttribute("aShow") as THREE.BufferAttribute;
      ch.sites.forEach((s, i) => attr.setX(i, this.passes(s) ? 1 : 0));
      attr.needsUpdate = true;
    }
  }

  /** Filters other than time and distance. */
  private passes(s: Site): boolean {
    const f = this.filters;
    if (f.hiddenCategories.has(s.category)) return false;
    if (f.country && s.country !== f.country) return false;
    if (f.onlyShapes && !s.hasShapes) return false;
    if (f.onlyAssets && !this.assetSites.has(s.id)) return false;
    return s.conf.every((v, i) => v >= f.minConf[i]);
  }

  /** Opacity 0..1 under the current time selection (T3 fading). */
  timeAlpha(s: Site): number {
    if (this.time.all) return 1;
    if (s.start === null || s.end === null) return 0;
    const gap = Math.max(s.start - this.time.end, this.time.start - s.end, 0);
    const m = FADE_YEARS[s.conf[3]] ?? 100;
    const x = Math.min(gap / m, 1);
    return 1 - x * x * (3 - 2 * x);
  }

  visible(s: Site): boolean {
    return this.passes(s) && this.timeAlpha(s) > 0.01;
  }

  update(cam: Vec3): void {
    this.material.uniforms.uCam.value.set(cam[0], cam[1], cam[2]);
    for (const ch of this.chunks) {
      const p = ch.origin;
      ch.points.position.set(p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]);
      ch.ghost.position.copy(ch.points.position);
    }
  }

  /** Whether a site is drawn from this camera (time, filters, distance, side). */
  shown(s: Site, cam: Vec3): boolean {
    if (!this.visible(s)) return false;
    const rel = sub(s.pos, cam);
    if (dot(rel, s.pos) > 0) return false;
    return s.viewKm === null || length(rel) <= s.viewKm * 1000;
  }

  /** Nearest shown site to a screen position, within maxPx. */
  pick(x: number, y: number, camera: THREE.PerspectiveCamera, cam: Vec3, w: number, h: number, maxPx = 8): Site | undefined {
    const v = new THREE.Vector3();
    let best: Site | undefined;
    let bestD = maxPx;
    for (const s of this.sites) {
      if (!this.shown(s, cam)) continue;
      const rel = sub(s.pos, cam);
      v.set(rel[0], rel[1], rel[2]).project(camera);
      if (v.z > 1) continue;
      const d = Math.hypot(((v.x + 1) / 2) * w - x, ((1 - v.y) / 2) * h - y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
}
