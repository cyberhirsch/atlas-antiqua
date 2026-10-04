// Outline shapes (LOD 0): Pleiades location geometries as lines and
// polygons, loaded per 1° cell when the camera is close, filtered by the
// same time selection as the sites (T2), with fading by date certainty.
// Heights come with the data (sampled from the terrain tiles), lifted a
// little so lines are not hidden by the surface.

import * as THREE from "three";
import { Vec3, ecef, sub } from "./geo";
import { FADE_YEARS, TimeSelection } from "./sites";

const BASE = import.meta.env.BASE_URL;
const SHOW_WITHIN = 60000; // camera range (m) below which shapes load
const LIFT = 3;            // metres above the terrain

interface Shape {
  site: string;
  kind: "L" | "P";
  start: number | null;
  end: number | null;
  modern: boolean;
  conf: number;
  parts: number[][][] | number[][][][]; // lines: [line][pt], polygons: [poly][ring][pt]
}

interface Cell {
  key: string;
  state: "loading" | "ready" | "failed";
  group?: THREE.Group;
  origin?: Vec3;
}

const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aStart;
  attribute float aEnd;
  attribute float aFade;
  uniform float uStart;
  uniform float uEnd;
  uniform float uAll;
  varying float vAlpha;
  void main() {
    float alpha = 1.0;
    if (uAll < 0.5) {
      float gap = aStart < -1e8 ? 1e9 : max(max(aStart - uEnd, uStart - aEnd), 0.0);
      alpha = 1.0 - smoothstep(0.0, aFade, gap);
    }
    vAlpha = alpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;

const FRAGMENT = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    #include <logdepthbuf_fragment>
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(uColor, uOpacity * vAlpha);
  }`;

export class Shapes {
  readonly group = new THREE.Group();
  private index = new Set<string>();
  private cells = new Map<string, Cell>();
  private uniforms = { uStart: { value: 10100 }, uEnd: { value: 10100 }, uAll: { value: 1 } };
  private lineMat = this.material(0xffe08a, 0.95);
  private fillMat = this.material(0xf2c14e, 0.18);
  visible = true;

  private material(color: number, opacity: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { ...this.uniforms, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  async init(): Promise<void> {
    const keys: string[] = await (await fetch(`${BASE}data/shapes/index.json`)).json();
    this.index = new Set(keys);
  }

  setTime(t: TimeSelection): void {
    this.uniforms.uStart.value = t.start;
    this.uniforms.uEnd.value = t.end;
    this.uniforms.uAll.value = t.all ? 1 : 0;
  }

  update(cam: Vec3, lon: number, lat: number, range: number): void {
    const near = this.visible && range < SHOW_WITHIN;
    if (near) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const key = `${Math.floor(lat) + dy}_${Math.floor(lon) + dx}`;
          if (this.index.has(key) && !this.cells.has(key)) this.load(key);
        }
      }
    }
    for (const c of this.cells.values()) {
      if (!c.group || !c.origin) continue;
      const [la, lo] = c.key.split("_").map(Number);
      c.group.visible = near && Math.abs(la + 0.5 - lat) < 2 && Math.abs(lo + 0.5 - lon) < 2.5;
      c.group.position.set(c.origin[0] - cam[0], c.origin[1] - cam[1], c.origin[2] - cam[2]);
    }
  }

  private async load(key: string): Promise<void> {
    const cell: Cell = { key, state: "loading" };
    this.cells.set(key, cell);
    try {
      const shapes: Shape[] = await (await fetch(`${BASE}data/shapes/${key}.json`)).json();
      const [la, lo] = key.split("_").map(Number);
      cell.origin = ecef(lo + 0.5, la + 0.5, 0);
      cell.group = this.build(shapes, cell.origin);
      cell.state = "ready";
      this.group.add(cell.group);
    } catch (err) {
      console.warn(`shapes ${key}`, err);
      cell.state = "failed";
    }
  }

  private build(shapes: Shape[], origin: Vec3): THREE.Group {
    const line: number[] = [];
    const lineT: number[] = [];
    const fill: number[] = [];
    const fillT: number[] = [];
    const point = (p: number[]) => sub(ecef(p[0], p[1], p[2] + LIFT), origin);
    for (const s of shapes) {
      const t = [s.start ?? -1e9, s.end ?? -1e9, FADE_YEARS[s.conf] ?? 100];
      const segs = (pts: number[][], closed: boolean) => {
        const v = pts.map(point);
        for (let i = 0; i + 1 < v.length; i++) {
          line.push(...v[i], ...v[i + 1]);
          lineT.push(...t, ...t);
        }
        if (closed && v.length > 2) {
          line.push(...v[v.length - 1], ...v[0]);
          lineT.push(...t, ...t);
        }
      };
      if (s.kind === "L") {
        for (const l of s.parts as number[][][]) segs(l, false);
      } else {
        for (const poly of s.parts as number[][][][]) {
          for (const ring of poly) segs(ring, true);
          // Fill: triangulate in lon/lat, place vertices at their own heights.
          const outer = poly[0].map((p) => new THREE.Vector2(p[0], p[1]));
          const holes = poly.slice(1).map((r) => r.map((p) => new THREE.Vector2(p[0], p[1])));
          const all = [...poly[0], ...poly.slice(1).flat()];
          for (const tri of THREE.ShapeUtils.triangulateShape(outer, holes)) {
            for (const i of tri) {
              fill.push(...point(all[i]));
              fillT.push(...t);
            }
          }
        }
      }
    }
    const group = new THREE.Group();
    const make = (pos: number[], times: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const t = new Float32Array(times);
      const n = t.length / 3;
      const a = (k: number) => new THREE.BufferAttribute(Float32Array.from({ length: n }, (_, i) => t[3 * i + k]), 1);
      g.setAttribute("aStart", a(0));
      g.setAttribute("aEnd", a(1));
      g.setAttribute("aFade", a(2));
      return g;
    };
    if (fill.length) {
      const m = new THREE.Mesh(make(fill, fillT), this.fillMat);
      m.frustumCulled = false;
      m.renderOrder = 5;
      group.add(m);
    }
    if (line.length) {
      const l = new THREE.LineSegments(make(line, lineT), this.lineMat);
      l.frustumCulled = false;
      l.renderOrder = 6;
      group.add(l);
    }
    return group;
  }
}
