// Map tools:
// - area selection: drag a rectangle, list the sites in it, download them
//   as CSV or GeoJSON (PRD S3)
// - drawing and editing lines and areas on the terrain, each with a time
//   interval and a precision, kept in the browser with an edit history
//   (E1, E2, E4)
// - import GeoJSON, KML and zipped Shapefiles; export everything drawn or
//   imported as GeoJSON (E3)

import * as THREE from "three";
import { Vec3, ecef, sub, yearLabel } from "./geo";
import type { Site, Sites } from "./sites";

export type GroundPick = (x: number, y: number) => [number, number, number] | undefined;
export type HeightAt = (lon: number, lat: number) => number | undefined;

interface Version {
  at: string; // ISO time
  note: string;
  geometry: GeoJSON.Geometry;
  props: FeatureProps;
}

interface FeatureProps {
  name: string;
  start: number | null; // HE
  end: number | null;
  precision_m: number | null;
  source: string; // "drawn" or the imported file name
}

interface UserFeature {
  id: string;
  geometry: GeoJSON.Geometry;
  props: FeatureProps;
  history: Version[];
  object?: THREE.Object3D;
  origin?: Vec3;
}

const STORE = "atlas-features-v1";
const LIFT = 2;

function download(name: string, text: string, type: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export class Tools {
  readonly group = new THREE.Group();
  features: UserFeature[] = [];
  /** True while a tool takes over left clicks and drags. */
  active: "none" | "select" | "line" | "area" = "none";
  private draft: [number, number, number][] = [];
  private draftObj?: THREE.Line;
  private rect?: { x0: number; y0: number; el: HTMLDivElement };
  private panel: HTMLElement;
  private lineMat = new THREE.LineBasicMaterial({ color: 0x7fc7ff, depthTest: false, transparent: true });
  private fillMat = new THREE.MeshBasicMaterial({ color: 0x7fc7ff, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false });
  private draftMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
  private editing?: UserFeature;
  private lastDrape = 0;

  constructor(
    private root: HTMLElement,
    private canvas: HTMLCanvasElement,
    private sites: Sites,
    private ground: GroundPick,
    private heightAt: HeightAt,
    private project: (s: Site) => [number, number] | undefined,
  ) {
    this.panel = root.querySelector("#tool-panel")!;
    root.querySelector("#tool-select")!.addEventListener("click", () => this.start("select"));
    root.querySelector("#tool-line")!.addEventListener("click", () => this.start("line"));
    root.querySelector("#tool-area")!.addEventListener("click", () => this.start("area"));
    root.querySelector("#tool-list")!.addEventListener("click", () => this.showList());
    root.querySelector("#tool-export")!.addEventListener("click", () => this.exportAll());
    const file = root.querySelector<HTMLInputElement>("#tool-import")!;
    file.addEventListener("change", () => file.files && this.importFiles([...file.files]));
    // Drop files anywhere on the map.
    canvas.addEventListener("dragover", (e) => e.preventDefault());
    canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files.length) this.importFiles([...e.dataTransfer.files]);
    });
    canvas.addEventListener("pointerdown", (e) => this.down(e), true);
    canvas.addEventListener("pointermove", (e) => this.move(e), true);
    canvas.addEventListener("pointerup", (e) => this.up(e), true);
    canvas.addEventListener("dblclick", (e) => {
      if (this.active === "line" || this.active === "area") {
        e.preventDefault();
        this.finishDraft();
      }
    });
    window.addEventListener("keydown", (e) => {
      if (this.active === "none") return;
      if (e.key === "Escape") this.stop();
      if (e.key === "Enter") this.finishDraft();
      if (e.key === "Backspace" && this.draft.length) {
        this.draft.pop();
        this.redrawDraft();
      }
    });
    this.load();
  }

  // --- tool state -----------------------------------------------------------

  private start(tool: Tools["active"]): void {
    this.stop();
    this.active = tool;
    this.canvas.classList.add("tool-active");
    this.hint(
      tool === "select" ? "Drag a rectangle to select sites. Esc cancels."
        : `Click to add points on the terrain; double-click or Enter finishes, Backspace removes the last point, Esc cancels.`,
    );
  }

  private stop(): void {
    this.active = "none";
    this.draft = [];
    this.redrawDraft();
    this.rect?.el.remove();
    this.rect = undefined;
    this.canvas.classList.remove("tool-active");
    this.root.querySelector(".tool-hint")?.remove();
  }

  private hint(text: string): void {
    this.root.querySelector(".tool-hint")?.remove();
    const p = document.createElement("p");
    p.className = "tool-hint";
    p.textContent = text;
    this.root.appendChild(p);
  }

  // --- pointer handling (capture phase, before the camera controls) --------

  private down(e: PointerEvent): void {
    if (this.active === "none" || e.button !== 0) return;
    e.stopImmediatePropagation();
    if (this.active === "select") {
      const el = document.createElement("div");
      el.className = "select-rect";
      document.body.appendChild(el);
      this.rect = { x0: e.clientX, y0: e.clientY, el };
      this.move(e);
    }
  }

  private move(e: PointerEvent): void {
    if (this.active === "none") return;
    e.stopImmediatePropagation();
    if (this.rect) {
      const { x0, y0, el } = this.rect;
      Object.assign(el.style, {
        left: `${Math.min(x0, e.clientX)}px`, top: `${Math.min(y0, e.clientY)}px`,
        width: `${Math.abs(e.clientX - x0)}px`, height: `${Math.abs(e.clientY - y0)}px`,
      });
    }
  }

  private up(e: PointerEvent): void {
    if (this.active === "none" || e.button !== 0) return;
    e.stopImmediatePropagation();
    const r = this.canvas.getBoundingClientRect();
    if (this.active === "select" && this.rect) {
      const { x0, y0 } = this.rect;
      const box = [Math.min(x0, e.clientX) - r.left, Math.min(y0, e.clientY) - r.top,
        Math.max(x0, e.clientX) - r.left, Math.max(y0, e.clientY) - r.top];
      this.stop();
      this.showSelection(box);
    } else if (this.active === "line" || this.active === "area") {
      const p = this.ground(e.clientX - r.left, e.clientY - r.top);
      if (p) {
        this.draft.push(p);
        this.redrawDraft();
      }
    }
  }

  // --- area selection (S3) ------------------------------------------------

  private showSelection(box: number[]): void {
    const hits = this.sites.sites.filter((s) => {
      const p = this.project(s);
      return p && p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];
    });
    this.panel.hidden = false;
    this.panel.innerHTML = `<button class="close" aria-label="Close">×</button>
      <h3>${hits.length} sites in the area</h3>
      <p class="hint">Sites shown on the map (time, filters and distance apply).</p>
      <div class="row"><button data-f="csv">Download CSV</button><button data-f="geojson">Download GeoJSON</button></div>
      <ol class="site-list"></ol>`;
    const ol = this.panel.querySelector("ol")!;
    for (const s of hits.slice(0, 300)) {
      const li = document.createElement("li");
      li.textContent = `${s.name} · ${s.category}${s.start !== null ? ` · ${yearLabel(s.start)} – ${yearLabel(s.end!)}` : ""}`;
      ol.appendChild(li);
    }
    if (hits.length > 300) ol.insertAdjacentHTML("beforeend", `<li>… and ${hits.length - 300} more (all are in the download)</li>`);
    this.panel.querySelector(".close")!.addEventListener("click", () => (this.panel.hidden = true));
    this.panel.querySelector('[data-f="csv"]')!.addEventListener("click", () => {
      const cols = ["id", "name", "category", "lon", "lat", "h", "start", "end", "confidence", "precision", "country"] as const;
      const lines = [["pleiades_id", ...cols.slice(1)].join(",")];
      for (const s of hits) lines.push(cols.map((c) => csvCell((s as unknown as Record<string, unknown>)[c])).join(","));
      download("atlas-antiqua-selection.csv", lines.join("\n"), "text/csv");
    });
    this.panel.querySelector('[data-f="geojson"]')!.addEventListener("click", () => {
      const fc = {
        type: "FeatureCollection",
        features: hits.map((s) => ({
          type: "Feature", id: `pleiades:${s.id}`,
          geometry: { type: "Point", coordinates: [s.lon, s.lat, s.h] },
          properties: { name: s.name, category: s.category, start_he: s.start, end_he: s.end, confidence: s.confidence,
            publication_precision_m: s.precision, source: `https://pleiades.stoa.org/places/${s.id}` },
        })),
        metadata: { licence: "Pleiades CC BY 3.0; see downloads/ATTRIBUTION.md", calendar: "Holocene (HE)" },
      };
      download("atlas-antiqua-selection.geojson", JSON.stringify(fc), "application/geo+json");
    });
  }

  // --- drawing (E1, E2) ---------------------------------------------------

  private redrawDraft(): void {
    if (this.draftObj) {
      this.group.remove(this.draftObj);
      this.draftObj.geometry.dispose();
      this.draftObj = undefined;
    }
    if (this.draft.length < 1) return;
    const pts = this.active === "area" && this.draft.length > 2 ? [...this.draft, this.draft[0]] : this.draft;
    const origin = ecef(pts[0][0], pts[0][1], pts[0][2]);
    const g = new THREE.BufferGeometry().setFromPoints(
      this.densify(pts).map((p) => new THREE.Vector3(...sub(ecef(p[0], p[1], p[2] + LIFT), origin))));
    this.draftObj = new THREE.Line(g, this.draftMat);
    this.draftObj.userData.origin = origin;
    this.draftObj.frustumCulled = false;
    this.draftObj.renderOrder = 20;
    this.group.add(this.draftObj);
  }

  private finishDraft(): void {
    const kind = this.active;
    const pts = this.draft.map((p) => [Number(p[0].toFixed(7)), Number(p[1].toFixed(7))]);
    if ((kind === "line" && pts.length < 2) || (kind === "area" && pts.length < 3)) return this.stop();
    const geometry: GeoJSON.Geometry = kind === "line"
      ? { type: "LineString", coordinates: pts }
      : { type: "Polygon", coordinates: [[...pts, pts[0]]] };
    const editing = this.editing;
    this.stop();
    if (editing) {
      this.commit(editing, { geometry, props: editing.props }, "geometry redrawn");
      this.editing = undefined;
      this.showFeature(editing);
      return;
    }
    const f: UserFeature = {
      id: crypto.randomUUID(),
      geometry,
      props: { name: kind === "line" ? "New line" : "New area", start: null, end: null, precision_m: null, source: "drawn" },
      history: [],
    };
    this.commit(f, { geometry, props: f.props }, "created");
    this.features.push(f);
    this.render(f);
    this.save();
    this.showFeature(f);
  }

  /** Record a version (E4) and apply it. */
  private commit(f: UserFeature, v: { geometry: GeoJSON.Geometry; props: FeatureProps }, note: string): void {
    f.geometry = v.geometry;
    f.props = { ...v.props };
    f.history.push({ at: new Date().toISOString(), note, geometry: v.geometry, props: { ...v.props } });
    this.render(f);
    this.save();
  }

  private showFeature(f: UserFeature): void {
    const p = f.props;
    this.panel.hidden = false;
    this.panel.innerHTML = `<button class="close" aria-label="Close">×</button>
      <h3>${f.geometry.type === "LineString" || f.geometry.type === "MultiLineString" ? "Line" : "Area"}</h3>
      <form class="feature-form">
        <label>Name <input name="name"></label>
        <label>Start (HE) <input name="start" type="number" step="1" placeholder="e.g. 9971"></label>
        <label>End (HE) <input name="end" type="number" step="1" placeholder="e.g. 10640"></label>
        <label>Precision (m) <input name="precision" type="number" min="0" step="1"></label>
        <p class="hint">Source: <span class="src"></span>. 1 CE = 10001 HE.</p>
        <div class="row"><button type="submit">Save</button><button type="button" data-a="redraw">Redraw</button>
          <button type="button" data-a="delete">Delete</button></div>
      </form>
      <h4>History</h4><ol class="history"></ol>`;
    const form = this.panel.querySelector("form")!;
    (form.elements.namedItem("name") as HTMLInputElement).value = p.name;
    (form.elements.namedItem("start") as HTMLInputElement).value = p.start?.toString() ?? "";
    (form.elements.namedItem("end") as HTMLInputElement).value = p.end?.toString() ?? "";
    (form.elements.namedItem("precision") as HTMLInputElement).value = p.precision_m?.toString() ?? "";
    this.panel.querySelector(".src")!.textContent = p.source;
    form.addEventListener("keydown", (e) => e.stopPropagation());
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
      const num = (n: string) => (val(n) === "" ? null : Number(val(n)));
      this.commit(f, { geometry: f.geometry, props: { ...p, name: val("name") || p.name, start: num("start"), end: num("end"), precision_m: num("precision") } }, "properties edited");
      this.showFeature(f);
    });
    this.panel.querySelector('[data-a="redraw"]')!.addEventListener("click", () => {
      this.editing = f;
      this.start(f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon" ? "area" : "line");
    });
    this.panel.querySelector('[data-a="delete"]')!.addEventListener("click", () => {
      if (!confirm(`Delete "${f.props.name}"? This cannot be undone.`)) return;
      this.remove(f);
      this.panel.hidden = true;
    });
    const ol = this.panel.querySelector(".history")!;
    f.history.forEach((v, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span></span> <button>Restore</button>`;
      li.querySelector("span")!.textContent = `${v.at.replace("T", " ").slice(0, 16)} · ${v.note}`;
      const b = li.querySelector("button")!;
      if (i === f.history.length - 1) b.remove();
      else b.addEventListener("click", () => {
        this.commit(f, { geometry: v.geometry, props: v.props }, `restored version ${i + 1}`);
        this.showFeature(f);
      });
      ol.appendChild(li);
    });
    this.panel.querySelector(".close")!.addEventListener("click", () => (this.panel.hidden = true));
  }

  private showList(): void {
    this.panel.hidden = false;
    this.panel.innerHTML = `<button class="close" aria-label="Close">×</button>
      <h3>Drawn and imported (${this.features.length})</h3>
      <p class="hint">Kept in this browser. Export saves them as GeoJSON.</p><ol class="site-list"></ol>`;
    const ol = this.panel.querySelector("ol")!;
    for (const f of this.features) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.className = "link";
      b.textContent = `${f.props.name} · ${f.geometry.type} · ${f.props.source}`;
      b.onclick = () => this.showFeature(f);
      li.appendChild(b);
      ol.appendChild(li);
    }
    this.panel.querySelector(".close")!.addEventListener("click", () => (this.panel.hidden = true));
  }

  private remove(f: UserFeature): void {
    if (f.object) {
      this.group.remove(f.object);
      f.object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    this.features = this.features.filter((x) => x !== f);
    this.save();
  }

  // --- import / export (E3) -----------------------------------------------

  private async importFiles(files: File[]): Promise<void> {
    let added = 0;
    for (const file of files) {
      try {
        const fc = await this.parse(file);
        for (const ft of fc.features) {
          if (!ft.geometry) continue;
          const pr = (ft.properties ?? {}) as Record<string, unknown>;
          const n = (k: string) => (typeof pr[k] === "number" ? (pr[k] as number) : pr[k] ? Number(pr[k]) || null : null);
          const props: FeatureProps = {
            name: String(pr.name ?? pr.Name ?? pr.NAME ?? pr.title ?? file.name),
            start: n("start_he") ?? n("start"),
            end: n("end_he") ?? n("end"),
            precision_m: n("precision_m"),
            source: file.name,
          };
          const f: UserFeature = { id: crypto.randomUUID(), geometry: ft.geometry, props, history: [] };
          this.commit(f, { geometry: ft.geometry, props }, `imported from ${file.name}`);
          this.features.push(f);
          added++;
        }
      } catch (err) {
        alert(`Could not read ${file.name}: ${(err as Error).message}`);
      }
    }
    this.save();
    if (added) this.showList();
  }

  private async parse(file: File): Promise<GeoJSON.FeatureCollection> {
    const name = file.name.toLowerCase();
    if (name.endsWith(".geojson") || name.endsWith(".json")) {
      const j = JSON.parse(await file.text());
      return j.type === "FeatureCollection" ? j : { type: "FeatureCollection", features: j.type === "Feature" ? [j] : [{ type: "Feature", geometry: j, properties: {} }] };
    }
    if (name.endsWith(".kml")) {
      const { kml } = await import("@tmcw/togeojson");
      return kml(new DOMParser().parseFromString(await file.text(), "text/xml")) as GeoJSON.FeatureCollection;
    }
    if (name.endsWith(".zip") || name.endsWith(".shp")) {
      // shpjs reads zipped Shapefiles (with .prj reprojection to WGS84).
      const shp = (await import("shpjs")).default as (b: ArrayBuffer) => Promise<GeoJSON.FeatureCollection | GeoJSON.FeatureCollection[]>;
      const out = await shp(await file.arrayBuffer());
      return Array.isArray(out) ? { type: "FeatureCollection", features: out.flatMap((c) => c.features) } : out;
    }
    throw new Error("unsupported file type (GeoJSON, KML or zipped Shapefile)");
  }

  private exportAll(): void {
    const fc = {
      type: "FeatureCollection",
      metadata: { calendar: "Holocene (HE = astronomical year + 10000)", exported: new Date().toISOString() },
      features: this.features.map((f) => ({
        type: "Feature", id: f.id, geometry: f.geometry,
        properties: { name: f.props.name, start_he: f.props.start, end_he: f.props.end, precision_m: f.props.precision_m,
          source: f.props.source, versions: f.history.length, edited: f.history.at(-1)?.at },
      })),
    };
    download("atlas-antiqua-features.geojson", JSON.stringify(fc, null, 1), "application/geo+json");
  }

  // --- storage --------------------------------------------------------------

  private save(): void {
    try {
      const data = this.features.map(({ id, geometry, props, history }) => ({ id, geometry, props, history }));
      localStorage.setItem(STORE, JSON.stringify(data));
    } catch {
      // Storage full or blocked: features stay for this session; Export keeps them.
    }
  }

  private load(): void {
    try {
      const data = JSON.parse(localStorage.getItem(STORE) ?? "[]") as UserFeature[];
      this.features = data;
      for (const f of this.features) this.render(f);
    } catch {
      this.features = [];
    }
  }

  // --- rendering ------------------------------------------------------------

  /** Insert points so lines follow the terrain between clicks. */
  private densify(pts: number[][]): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
      out.push(pts[i]);
      if (i + 1 < pts.length) {
        const [a, b] = [pts[i], pts[i + 1]];
        const dist = Math.hypot((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 111320;
        const n = Math.min(Math.floor(dist / 25), 400);
        for (let k = 1; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
      }
    }
    return out.map((p) => [p[0], p[1], this.heightAt(p[0], p[1]) ?? p[2] ?? 0]);
  }

  private render(f: UserFeature): void {
    if (f.object) {
      this.group.remove(f.object);
      f.object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    const lines: number[][][] = [];
    const polys: number[][][][] = [];
    const g = f.geometry;
    if (g.type === "LineString") lines.push(g.coordinates);
    if (g.type === "MultiLineString") lines.push(...g.coordinates);
    if (g.type === "Polygon") polys.push(g.coordinates);
    if (g.type === "MultiPolygon") polys.push(...g.coordinates);
    if (g.type === "Point") lines.push([g.coordinates, g.coordinates]);
    if (g.type === "MultiPoint") for (const c of g.coordinates) lines.push([c, c]);
    const first = lines[0]?.[0] ?? polys[0]?.[0]?.[0];
    if (!first) return;
    const origin = ecef(first[0], first[1], 0);
    const obj = new THREE.Group();
    const toV = (p: number[]) => new THREE.Vector3(...sub(ecef(p[0], p[1], p[2] + LIFT), origin));
    for (const l of [...lines, ...polys.flat()]) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.densify(l).map(toV)), this.lineMat);
      line.frustumCulled = false;
      line.renderOrder = 15;
      obj.add(line);
    }
    for (const poly of polys) {
      const outer = poly[0].map((p) => new THREE.Vector2(p[0], p[1]));
      const holes = poly.slice(1).map((r) => r.map((p) => new THREE.Vector2(p[0], p[1])));
      const all = [...poly[0], ...poly.slice(1).flat()].map((p) => [p[0], p[1], this.heightAt(p[0], p[1]) ?? 0]);
      const pos: number[] = [];
      for (const tri of THREE.ShapeUtils.triangulateShape(outer, holes)) for (const i of tri) pos.push(...toV(all[i]).toArray());
      const m = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)), this.fillMat);
      m.frustumCulled = false;
      m.renderOrder = 14;
      obj.add(m);
    }
    obj.userData.origin = origin;
    f.object = obj;
    f.origin = origin;
    this.group.add(obj);
  }

  update(cam: Vec3, now: number): void {
    for (const o of this.group.children) {
      const origin = o.userData.origin as Vec3 | undefined;
      if (origin) o.position.set(origin[0] - cam[0], origin[1] - cam[1], origin[2] - cam[2]);
    }
    // Re-drape on finer terrain as it loads.
    if (now - this.lastDrape > 3000 && this.features.length) {
      this.lastDrape = now;
      for (const f of this.features) this.render(f);
    }
  }
}
