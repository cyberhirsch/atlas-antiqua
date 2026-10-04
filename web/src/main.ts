import * as THREE from "three";
import { Assets } from "./assets";
import { GlobeControls, View } from "./controls";
import { Vec3, add, dot, enu, geodetic, length, sub, yearLabel } from "./geo";
import { Map2D } from "./map2d";
import { AdaptiveQuality, Device, Profile, detectDevice, pickProfile } from "./quality";
import { Search } from "./search";
import { Shapes } from "./shapes";
import { CATEGORY_COLORS, Filters, Site, Sites } from "./sites";
import { Terrain } from "./terrain";
import { Timeline } from "./timeline";
import { Tools } from "./tools";
import * as Url from "./urlstate";
import { Xr, XrMode } from "./xr";

const PLACES: { name: string; note: string; view: View }[] = [
  { name: "Traunstein – Ruhpolding", note: "LiDAR 1 m", view: { lon: 12.645, lat: 47.80, range: 9000, heading: 0.3, pitch: -0.55 } },
  { name: "Chiemsee", note: "GLO-30", view: { lon: 12.43, lat: 47.87, range: 30000, heading: 0, pitch: -0.7 } },
  { name: "Rome", note: "GLO-30", view: { lon: 12.4853, lat: 41.8925, range: 6000, heading: 0, pitch: -0.8 } },
  { name: "Athens", note: "GLO-30", view: { lon: 23.7257, lat: 37.9715, range: 5000, heading: 0.5, pitch: -0.7 } },
  { name: "Knossos, Crete", note: "GLO-30", view: { lon: 25.1631, lat: 35.298, range: 6000, heading: 0, pitch: -0.6 } },
  { name: "Crete", note: "GLO-30", view: { lon: 24.9, lat: 35.0, range: 160000, heading: 0, pitch: -0.9 } },
  { name: "Giza", note: "GLO-30", view: { lon: 31.1342, lat: 29.9792, range: 6000, heading: 0.8, pitch: -0.6 } },
  { name: "Skaptopara (3D scan)", note: "GLO-30", view: { lon: 23.0525, lat: 41.9957, range: 400, heading: 0.4, pitch: -0.6 } },
  { name: "Whole Earth", note: "", view: { lon: 15, lat: 38, range: 2.2e7, heading: 0, pitch: -Math.PI / 2 } },
];

const BASE = import.meta.env.BASE_URL;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const el = $("#view");
// Development only: ?emulate=quest installs Meta's WebXR emulator (IWER) as
// a Quest 3 with controllers, so the XR modes can be tested without a headset
// (tests/xr-emulation.mjs).
let xrDevice: unknown;
if (import.meta.env.DEV && new URLSearchParams(location.search).has("emulate")) {
  const iwer = await import("iwer");
  const dev = new iwer.XRDevice(iwer.metaQuest3);
  dev.installRuntime({ forceInstall: true }); // desktop Chrome has a native navigator.xr
  xrDevice = dev;
}

// The renderer is created after device detection, which picks antialiasing
// and resolution (quality.ts).
const device: Device = await detectDevice();
const profile: Profile = pickProfile(device);
const adaptive = new AdaptiveQuality(profile);
const renderer = new THREE.WebGLRenderer({ antialias: profile.antialias, logarithmicDepthBuffer: true });
const basePixelRatio = Math.min(window.devicePixelRatio, profile.maxPixelRatio);
renderer.setPixelRatio(basePixelRatio);
renderer.setClearColor(0x050608);
el.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const world = new THREE.Group(); // everything placed on the Earth; scaled in XR table modes
scene.add(world);
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 2e8);
const controls = new GlobeControls(renderer.domElement, camera);
const terrain = new Terrain();
const sites = new Sites();
const shapes = new Shapes();
const assets = new Assets(renderer, scene, (lon, lat) => terrain.heightAt(lon, lat));
world.add(terrain.group, shapes.group, sites.group, assets.group);

function resize(): void {
  const w = el.clientWidth;
  const h = el.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// --- picking ---------------------------------------------------------------

let lastCam: Vec3 = [0, 0, 0];
let lastOrigin: Vec3 = [0, 0, 0];
const ray = new THREE.Raycaster();

/** Ground point under a screen position: lon, lat, height (ellipsoidal). */
function pickGround(x: number, y: number): [number, number, number] | undefined {
  const w = el.clientWidth;
  const h = el.clientHeight;
  ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, 1 - (y / h) * 2), camera);
  ray.far = Infinity;
  const hit = ray.intersectObjects(terrain.gpuDisplace ? [] : terrain.meshes(), false)[0];
  if (hit) return geodetic(add(lastOrigin, [hit.point.x, hit.point.y, hit.point.z]));
  return marchGround(ray.ray.origin, ray.ray.direction);
}

/**
 * Ground along a ray (camera-relative) from the loaded heights: steps that
 * grow with distance, then bisection. Used where meshes cannot be raycast
 * (GPU-displaced tiles).
 */
function marchGround(o: THREE.Vector3, d: THREE.Vector3): [number, number, number] | undefined {
  const at = (t: number) => geodetic(add(lastOrigin, [o.x + d.x * t, o.y + d.y * t, o.z + d.z * t]));
  const above = (t: number) => {
    const [lon, lat, h] = at(t);
    const g = terrain.heightAt(lon, lat);
    return g === undefined ? true : h > g;
  };
  let prev = 0;
  let t = 1;
  while (t < 5e6) {
    if (!above(t)) {
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (above(mid)) lo = mid;
        else hi = mid;
      }
      return at(hi);
    }
    prev = t;
    t = t * 1.05 + 1;
  }
  return undefined;
}

function project(s: Site): [number, number] | undefined {
  if (!sites.shown(s, lastCam)) return undefined;
  const rel = sub(s.pos, lastCam);
  const v = new THREE.Vector3(rel[0], rel[1], rel[2]).project(camera);
  if (v.z > 1) return undefined;
  return [((v.x + 1) / 2) * el.clientWidth, ((1 - v.y) / 2) * el.clientHeight];
}

// --- UI --------------------------------------------------------------------

const info = $("#info");
const infoBody = $("#info-body");
$("#info-close").onclick = () => {
  info.hidden = true;
  urlSite = undefined;
  saveUrl();
};
let urlSite: string | undefined;

function flyToSite(s: Site): void {
  controls.flyTo({ lon: s.lon, lat: s.lat, range: s.viewKm === null ? 8000 : Math.min(s.viewKm * 400, 8000), heading: controls.heading, pitch: -0.7 });
  showSite(s);
}

function showSite(s: Site): void {
  urlSite = s.id;
  saveUrl();
  const dates = s.start === null ? "not entered" : `${s.start} – ${s.end} HE<br><small>${yearLabel(s.start)} – ${yearLabel(s.end!)}</small>`;
  const axes = ["identity", "position", "elevation", "time"];
  const scans = assets.forSite(s.id);
  infoBody.innerHTML = `
    <h3></h3>
    <p class="hint names"></p>
    <dl>
      <dt>Category</dt><dd>${s.category}</dd>
      <dt>Country</dt><dd>${s.country}</dd>
      <dt>Dates</dt><dd>${dates}</dd>
      <dt>Elevation</dt><dd>${s.h ? `${s.h.toFixed(0)} m (ellipsoid)` : "unknown"}</dd>
      <dt>Confidence</dt><dd>${s.confidence} of 5 overall<br><small>${axes.map((a, i) => `${a} ${s.conf[i]}`).join(" · ")}</small></dd>
      <dt>Precision</dt><dd>${s.precision ? `${s.precision} m` : "unknown"}${s.degraded ? "<br><small>Public position reduced to this precision (sensitive or unknown accuracy).</small>" : ""}</dd>
      <dt>Shown from</dt><dd>${s.viewKm === null ? "any distance" : `${s.viewKm} km`}</dd>
    </dl>
    ${scans.length ? `<h4>3D scans</h4><ul class="scans"></ul>` : ""}
    <p class="records">${[
      s.source === "pleiades" ? `<a href="https://pleiades.stoa.org/places/${s.id}" target="_blank" rel="noopener">Pleiades ↗</a>` : "",
      s.qid ? `<a href="https://www.wikidata.org/wiki/${s.qid}" target="_blank" rel="noopener">Wikidata ↗</a>` : "",
      s.wikipedia ? `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(s.wikipedia)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : "",
    ].filter(Boolean).join(" · ")}</p>
    <p class="hint">Source: ${s.source === "pleiades" ? "Pleiades (CC BY)" : "Wikidata only (CC0), not yet reviewed against Pleiades"}${s.qid && s.source === "pleiades" ? "; linked to Wikidata" : ""}.</p>`;
  infoBody.querySelector("h3")!.textContent = s.name;
  infoBody.querySelector(".names")!.textContent = s.names.split("|").filter(Boolean).slice(0, 8).join(", ");
  const ul = infoBody.querySelector(".scans");
  for (const a of scans) {
    const li = document.createElement("li");
    li.innerHTML = `<label class="check"><input type="checkbox"> <span></span></label><small></small>
      <div class="row"><button data-a="go">Go there</button><button data-a="place">Place…</button></div>`;
    li.querySelector("span")!.textContent = a.name;
    li.querySelector("small")!.textContent = assets.describe(a) + (a.note ? ` — ${a.note}` : "");
    const box = li.querySelector("input")!;
    box.checked = !assets.isHidden(a.id);
    // Phase toggle (A5): switch scans of the same site on and off.
    box.onchange = () => assets.setHidden(a.id, !box.checked);
    li.querySelector<HTMLButtonElement>('[data-a="go"]')!.onclick = () =>
      controls.flyTo({ lon: a.lon, lat: a.lat, range: 250, heading: controls.heading, pitch: -0.6 });
    li.querySelector<HTMLButtonElement>('[data-a="place"]')!.onclick = () => li.appendChild(assets.placementPanel(a.id));
    ul!.appendChild(li);
  }
  info.hidden = false;
}

controls.onClick = (x, y) => {
  if (tools.active !== "none") return;
  const r = renderer.domElement.getBoundingClientRect();
  const s = sites.pick(x - r.left, y - r.top, camera, lastCam, r.width, r.height);
  if (s) showSite(s);
};

const placeList = $("#place-list");
for (const p of PLACES) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.innerHTML = `${p.name}${p.note ? `<small>${p.note}</small>` : ""}`;
  b.onclick = () => controls.flyTo(p.view);
  li.appendChild(b);
  placeList.appendChild(li);
}

// Filters (S2, D8).
const filters: Filters = { hiddenCategories: new Set(), country: null, minConf: [0, 0, 0, 0], onlyShapes: false, onlyAssets: false };
function applyFilters(): void {
  filterVersion++;
  sites.setFilters(filters);
  map2d.refresh();
  saveUrl();
}

const tools = new Tools(document.body, renderer.domElement, sites, pickGround, (lon, lat) => terrain.heightAt(lon, lat), project);
world.add(tools.group);

// Hover: the point under the mouse grows and shows its name.
const hoverLabel = document.createElement("div");
hoverLabel.className = "hover-label";
hoverLabel.hidden = true;
document.body.appendChild(hoverLabel);
let hoverPending = false;
renderer.domElement.addEventListener("pointermove", (e) => {
  if (e.buttons || tools.active !== "none" || hoverPending) return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    const r = renderer.domElement.getBoundingClientRect();
    const s = sites.pick(e.clientX - r.left, e.clientY - r.top, camera, lastCam, r.width, r.height, 10);
    sites.setHover(s);
    renderer.domElement.style.cursor = s ? "pointer" : "";
    hoverLabel.hidden = !s;
    if (s) {
      hoverLabel.textContent = s.name;
      hoverLabel.style.transform = `translate(${e.clientX + 14}px, ${e.clientY - 10}px)`;
    }
  });
});
renderer.domElement.addEventListener("pointerleave", () => {
  sites.setHover(undefined);
  hoverLabel.hidden = true;
});
const map2d = new Map2D($("#map2d"), sites);
map2d.onPick = (s) => showSite(s);

let timeline: Timeline;
function saveUrl(): void {
  if (!timeline) return;
  Url.write({ view: controls.view(), time: timeline.state, filters, site: urlSite });
}

// --- XR (X1-X6) --------------------------------------------------------------

const xrOverlay = $("#xr-overlay");
const xr = new Xr(renderer, world, xrOverlay);
xr.heightAt = (lon, lat) => terrain.heightAt(lon, lat);
xr.scene = scene;
scene.add(xr.rig);
// Teleport target from the finest loaded heights, not from the drawn meshes:
// right after entering VR only coarse tiles are drawn, and their surface lies
// below the true ground, so a ray aimed a few metres ahead would pass over it.
xr.pickGround = (r) => marchGround(r.origin, r.direction);
xr.onEnd = () => {
  xr.rig.remove(camera); // back to the globe camera
  terrain.visible = true;
  resize();
};

function showXr(d: Device): void {
  const box = $("#xr");
  const modes: [XrMode, string][] = [];
  if (d.vr) modes.push(["vr", "Enter VR"], ["vr-table", "VR table"]);
  if (d.ar) modes.push(["ar", "AR on site"], ["ar-table", "AR tabletop"]);
  if (!modes.length) return;
  box.hidden = false;
  for (const [mode, label] of modes) {
    const b = document.createElement("button");
    b.textContent = label;
    // XR sessions can only start from a user tap.
    b.onclick = () => {
      const h = terrain.heightAt(controls.lon, controls.lat) ?? controls.h;
      xr.enter(mode, { lon: controls.lon, lat: controls.lat, h, heading: controls.heading })
        .catch((err) => alert(`Could not start ${label}: ${(err as Error).message}`));
    };
    box.appendChild(b);
  }
}

// --- main loop ---------------------------------------------------------------

const stats = $("#stats");
let viewSig = "";
let stillFrames = 0;
let filterVersion = 0; // bumped when time or filters change, to refresh the period list
// Technical status line only with ?debug.
stats.hidden = !new URLSearchParams(location.search).has("debug");
let frame = 0;

function placeCamera(cam: Vec3): void {
  const target = controls.target();
  const [east, north, up] = enu(controls.lon, controls.lat);
  camera.position.set(0, 0, 0);
  // Camera up lies in the vertical plane of the heading, at right angles to
  // the view. Straight down this is the heading direction (north at load);
  // using the local vertical there would leave the roll undefined.
  const sh = Math.sin(controls.heading);
  const ch = Math.cos(controls.heading);
  const sp = Math.sin(controls.pitch);
  const cp = Math.cos(controls.pitch);
  camera.up.set(
    -sp * (east[0] * sh + north[0] * ch) + cp * up[0],
    -sp * (east[1] * sh + north[1] * ch) + cp * up[1],
    -sp * (east[2] * sh + north[2] * ch) + cp * up[2],
  );
  const t = sub(target, cam);
  camera.lookAt(t[0], t[1], t[2]);
  // Near plane follows the height above ground so close views stay sharp.
  const camHeight = geodetic(cam)[2] - controls.h;
  camera.near = Math.max(0.1, Math.min(camHeight, controls.range) * 0.05);
  camera.far = Math.max(1e5, length(cam) * 2);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

function tick(now: number, xrFrame?: XRFrame): void {
  adaptive.frame(now);
  terrain.quality.sse = adaptive.sse;
  timeline?.tick(now);
  if (map2d.active) return;

  let cam: Vec3;
  let origin: Vec3;
  let view: THREE.PerspectiveCamera = camera;
  if (xr.mode) {
    xr.poll(now);
    // The camera rides in the rig; three.js applies the rig to the head pose.
    if (camera.parent !== xr.rig) {
      xr.rig.add(camera);
      camera.position.set(0, 0, 0);
      camera.quaternion.identity();
    }
    const xrCam = renderer.xr.getCamera();
    const f = xr.frame(xrCam, xrFrame);
    cam = f.cam;
    origin = f.origin;
    terrain.visible = f.showTerrain;
    view = xrCam;
  } else {
    const ratio = basePixelRatio * adaptive.scale;
    if (Math.abs(renderer.getPixelRatio() - ratio) > 0.01) {
      renderer.setPixelRatio(ratio);
      resize();
    }
    cam = controls.update(now);
    origin = cam;
    placeCamera(cam);
  }
  lastCam = cam;
  lastOrigin = origin;

  terrain.update(view, cam, xr.mode ? 1000 : el.clientHeight, origin);
  sites.update(origin);
  // Sites' near-side and distance tests use the true camera position.
  sites.material.uniforms.uCam.value.set(origin[0], origin[1], origin[2]);
  shapes.update(origin, controls.lon, controls.lat, xr.mode ? 1000 : controls.range);
  assets.update(origin);
  tools.update(origin, now);
  renderer.render(scene, camera); // in XR, three.js renders through the XR camera

  if (++frame % 10 === 0 && !xr.mode) {
    // Ground height under the target, and keep the camera above the ground.
    const g = terrain.heightAt(controls.lon, controls.lat);
    if (g !== undefined) controls.h += (g - controls.h) * 0.5;
    const [clon, clat, hc] = geodetic(cam);
    const gc = terrain.heightAt(clon, clat);
    if (gc !== undefined && hc < gc + 5 && dot(sub(cam, controls.target()), enu(controls.lon, controls.lat)[2]) < controls.range) {
      controls.range *= 1.15;
    }
    saveUrl();
    const s = terrain.stats;
    stats.textContent = `${profile.name} · ${Math.round(adaptive.fps)} fps · detail ${adaptive.sse.toFixed(1)} px · scale ${adaptive.scale.toFixed(2)} · tiles ${s.rendered} drawn · level ${s.maxLevel} · ${s.loading} loading · ${s.gpuMB} MB · ${s.downloads} downloaded · ${s.hits} from cache · ${s.wasted} unused · ${s.aborted} aborted · ${controls.lat.toFixed(4)}, ${controls.lon.toFixed(4)} · ${Math.round(controls.range)} m`;
  }
  // The period list scans all sites (about 50 ms with Wikidata),
  // so they update only once the view has come to rest after a change.
  const sig = `${controls.lon.toFixed(5)},${controls.lat.toFixed(5)},${controls.range.toFixed(0)},${controls.heading.toFixed(3)},${controls.pitch.toFixed(3)},${el.clientWidth}x${el.clientHeight},${filterVersion}`;
  if (sig !== viewSig) {
    viewSig = sig;
    stillFrames = 0;
  } else if (++stillFrames === 8 && !xr.mode && timeline) {
    // Period picker: periods attested within about 300 km of the view (T5).
    const local = new Set<number>();
    const r = 300 / 111;
    for (const s of sites.sites) {
      if (Math.abs(s.lat - controls.lat) < r && Math.abs(s.lon - controls.lon) < r / Math.max(Math.cos((controls.lat * Math.PI) / 180), 0.2)) {
        for (const p of s.periods) local.add(p);
      }
    }
    timeline.setLocalPeriods(local);
  }
}

async function main(): Promise<void> {
  terrain.quality = {
    sse: profile.sse, imagePx: profile.imagePx, budgetBytes: profile.budgetMB * 2 ** 20, meshStep: profile.meshStep,
  };
  showXr(device);
  await Promise.all([terrain.init(), sites.load(`${BASE}data/sites.json`), shapes.init(), assets.init()]);
  sites.assetSites = assets.sitesWithAssets();

  // Time (T1-T6).
  timeline = new Timeline($("#time"), sites.periods);
  timeline.onChange = (t) => {
    filterVersion++;
    sites.setTime(t);
    shapes.setTime(t);
    assets.setTime(t);
    map2d.refresh();
    saveUrl();
  };

  // Legend and category filter.
  const legend = $("#legend");
  for (const c of sites.categories) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" checked><span class="dot" style="background:${CATEGORY_COLORS[c] ?? "#fff"}"></span>${c}`;
    const box = label.querySelector("input")!;
    box.dataset.cat = c;
    box.onchange = () => {
      if (box.checked) filters.hiddenCategories.delete(c);
      else filters.hiddenCategories.add(c);
      applyFilters();
    };
    legend.appendChild(label);
  }
  legend.insertAdjacentHTML("beforeend", `<span class="conf-key"><span class="mk solid"></span>confidence 3+ <span class="mk ring"></span>2 <span class="mk dashed"></span>0–1</span>`);

  // Country and confidence filters.
  const country = $<HTMLSelectElement>("#f-country");
  for (const c of [...sites.countries].sort()) country.add(new Option(c, c));
  country.onchange = () => {
    filters.country = country.value || null;
    applyFilters();
  };
  document.querySelectorAll<HTMLSelectElement>("select[data-axis]").forEach((sel) => {
    for (let v = 0; v <= 5; v++) sel.add(new Option(v === 0 ? "any" : `${v}+`, String(v)));
    sel.onchange = () => {
      filters.minConf[Number(sel.dataset.axis)] = Number(sel.value);
      applyFilters();
    };
  });
  const onlyShapes = $<HTMLInputElement>("#f-shapes");
  const onlyAssets = $<HTMLInputElement>("#f-assets");
  onlyShapes.onchange = () => {
    filters.onlyShapes = onlyShapes.checked;
    applyFilters();
  };
  onlyAssets.onchange = () => {
    filters.onlyAssets = onlyAssets.checked;
    applyFilters();
  };

  // Layers.
  const shapesBox = $<HTMLInputElement>("#l-shapes");
  shapesBox.onchange = () => (shapes.visible = shapesBox.checked);
  const seaBox = $<HTMLInputElement>("#l-sea");
  const seaLevel = $<HTMLInputElement>("#l-sealevel");
  const seaOut = $<HTMLOutputElement>("#l-sealevel-out");
  seaBox.onchange = async () => {
    $(".sea-level").hidden = !seaBox.checked;
    await terrain.setSeaFloor(seaBox.checked);
  };
  seaLevel.oninput = () => {
    terrain.sea.uSeaLevel.value = Number(seaLevel.value);
    seaOut.textContent = `${seaLevel.value} m`;
  };
  const box2d = $<HTMLInputElement>("#l-2d");
  box2d.onchange = async () => {
    if (box2d.checked) {
      el.hidden = true;
      await map2d.show(controls.lon, controls.lat, controls.range);
    } else {
      const v = map2d.hide();
      el.hidden = false;
      if (v) Object.assign(controls, { lon: v.lon, lat: v.lat, range: v.range });
    }
  };

  // Search (S1) and share (S4).
  const search = new Search($<HTMLInputElement>("#search"), sites.sites);
  search.onPick = flyToSite;
  $("#share").onclick = async () => {
    Url.write({ view: controls.view(), time: timeline.state, filters, site: urlSite });
    await new Promise((r) => setTimeout(r, 450));
    try {
      await navigator.clipboard.writeText(location.href);
      $("#share").textContent = "Link copied";
    } catch {
      prompt("Link to this view", location.href);
    }
    setTimeout(() => ($("#share").textContent = "Copy link to this view"), 2000);
  };

  // Restore a shared view.
  const u = Url.decode(location.hash);
  if (u.view) Object.assign(controls, u.view);
  if (u.time) timeline.set(u.time);
  if (u.filters) {
    Object.assign(filters, u.filters);
    country.value = filters.country ?? "";
    onlyShapes.checked = filters.onlyShapes;
    onlyAssets.checked = filters.onlyAssets;
    document.querySelectorAll<HTMLSelectElement>("select[data-axis]").forEach((sel) => (sel.value = String(filters.minConf[Number(sel.dataset.axis)])));
    legend.querySelectorAll<HTMLInputElement>("input[data-cat]").forEach((b) => (b.checked = !filters.hiddenCategories.has(b.dataset.cat!)));
    applyFilters();
  }
  if (u.site && sites.byId.has(u.site)) showSite(sites.byId.get(u.site)!);
  timeline.onChange(timeline.state);

  renderer.setAnimationLoop(tick);
}

main();

// Installable app (PWA / TWA packaging, PRD §4.1); not in development, where
// a cached shell would hide changes.
if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register(`${BASE}sw.js`).catch(() => undefined);
}

if (import.meta.env.DEV) {
  Object.assign(window, { atlas: { terrain, sites, shapes, assets, tools, controls, camera, renderer, scene, device, profile, adaptive, xr, world, tick, xrDevice } });
}
