import * as THREE from "three";
import { GlobeControls, View } from "./controls";
import { Vec3, dot, ecef, enu, geodetic, length, sub, yearLabel } from "./geo";
import { CATEGORY_COLORS, Site, Sites } from "./sites";
import { Terrain } from "./terrain";

const PLACES: { name: string; note: string; view: View }[] = [
  { name: "Traunstein – Ruhpolding", note: "LiDAR 1 m", view: { lon: 12.645, lat: 47.80, range: 9000, heading: 0.3, pitch: -0.55 } },
  { name: "Chiemsee", note: "GLO-30", view: { lon: 12.43, lat: 47.87, range: 30000, heading: 0, pitch: -0.7 } },
  { name: "Rome", note: "GLO-30", view: { lon: 12.4853, lat: 41.8925, range: 6000, heading: 0, pitch: -0.8 } },
  { name: "Athens", note: "GLO-30", view: { lon: 23.7257, lat: 37.9715, range: 5000, heading: 0.5, pitch: -0.7 } },
  { name: "Knossos, Crete", note: "GLO-30", view: { lon: 25.1631, lat: 35.298, range: 6000, heading: 0, pitch: -0.6 } },
  { name: "Crete", note: "GLO-30", view: { lon: 24.9, lat: 35.0, range: 160000, heading: 0, pitch: -0.9 } },
  { name: "Giza", note: "GLO-30", view: { lon: 31.1342, lat: 29.9792, range: 6000, heading: 0.8, pitch: -0.6 } },
  { name: "Whole Earth", note: "", view: { lon: 15, lat: 38, range: 2.2e7, heading: 0, pitch: -Math.PI / 2 } },
];

const el = document.getElementById("view")!;
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x050608);
el.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 2e8);
const controls = new GlobeControls(renderer.domElement, camera);
const terrain = new Terrain();
const sites = new Sites();
scene.add(terrain.group, sites.group);

function resize(): void {
  const w = el.clientWidth;
  const h = el.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// --- ground height under the target and under the camera -------------------

const ray = new THREE.Raycaster();
function groundHeight(lon: number, lat: number, cam: Vec3): number | undefined {
  const up = enu(lon, lat)[2];
  const top = ecef(lon, lat, 12000);
  const origin = sub(top, cam);
  ray.set(new THREE.Vector3(...origin), new THREE.Vector3(-up[0], -up[1], -up[2]));
  ray.far = 25000;
  const hit = ray.intersectObjects(terrain.meshes(), false)[0];
  if (!hit) return undefined;
  return 12000 - hit.distance;
}

// --- UI ------------------------------------------------------------------------

const list = document.getElementById("place-list")!;
for (const p of PLACES) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.innerHTML = `${p.name}${p.note ? `<small>${p.note}</small>` : ""}`;
  b.onclick = () => controls.flyTo(p.view);
  li.appendChild(b);
  list.appendChild(li);
}

const yearInput = document.getElementById("year") as HTMLInputElement;
const allInput = document.getElementById("all-dates") as HTMLInputElement;
const yearOut = document.getElementById("year-label")!;
function updateTime(): void {
  const y = Number(yearInput.value);
  yearOut.textContent = allInput.checked ? "all dates" : `${y} HE · ${yearLabel(y)}`;
  yearInput.disabled = allInput.checked;
  sites.setTime(y, allInput.checked);
}
yearInput.addEventListener("input", updateTime);
allInput.addEventListener("change", updateTime);

const info = document.getElementById("info")!;
const infoBody = document.getElementById("info-body")!;
document.getElementById("info-close")!.onclick = () => (info.hidden = true);

function showSite(s: Site): void {
  const dates = s.start === null ? "not entered" : `${s.start} – ${s.end} HE<br><small>${yearLabel(s.start)} – ${yearLabel(s.end!)}</small>`;
  infoBody.innerHTML = `
    <h3></h3>
    <dl>
      <dt>Category</dt><dd>${s.category}</dd>
      <dt>Dates</dt><dd>${dates}</dd>
      <dt>Elevation</dt><dd>${s.h ? `${s.h.toFixed(0)} m (ellipsoid)` : "unknown"}</dd>
      <dt>Confidence</dt><dd>${s.confidence} of 5</dd>
      <dt>Precision</dt><dd>${s.precision ? `${s.precision} m` : "unknown"}</dd>
      <dt>Shown from</dt><dd>${s.viewKm === null ? "any distance" : `${s.viewKm} km`}</dd>
    </dl>
    <a href="https://pleiades.stoa.org/places/${s.id}" target="_blank" rel="noopener">Pleiades record ↗</a>`;
  infoBody.querySelector("h3")!.textContent = s.name;
  info.hidden = false;
}

controls.onClick = (x, y) => {
  const r = renderer.domElement.getBoundingClientRect();
  const s = sites.pick(x - r.left, y - r.top, camera, lastCam, r.width, r.height);
  if (s) showSite(s);
};

// --- main loop ---------------------------------------------------------------

let lastCam: Vec3 = [0, 0, 0];
const stats = document.getElementById("stats")!;
let frame = 0;

function tick(now: number): void {
  const cam = controls.update(now);
  lastCam = cam;
  const target = controls.target();
  const [, , up] = enu(controls.lon, controls.lat);
  camera.position.set(0, 0, 0);
  camera.up.set(up[0], up[1], up[2]);
  const t = sub(target, cam);
  camera.lookAt(t[0], t[1], t[2]);
  // Near plane follows the height above ground so close views stay sharp.
  const camHeight = geodetic(cam)[2] - controls.h;
  camera.near = Math.max(0.5, Math.min(camHeight, controls.range) * 0.05);
  camera.far = Math.max(1e5, length(cam) * 2);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  terrain.update(camera, cam, el.clientHeight);
  sites.update(cam);
  renderer.render(scene, camera);

  if (++frame % 10 === 0) {
    const g = groundHeight(controls.lon, controls.lat, cam);
    if (g !== undefined) controls.h += (g - controls.h) * 0.5;
    // Keep the camera above the ground.
    const [clon, clat] = geodetic(cam);
    const gc = groundHeight(clon, clat, cam);
    const [, , hc] = geodetic(cam);
    if (gc !== undefined && hc < gc + 20 && dot(sub(cam, target), up) < controls.range) {
      controls.range *= 1.15;
    }
    const s = terrain.stats;
    stats.textContent = `tiles ${s.rendered} drawn · ${s.cached} cached · ${s.loading} loading · level ${s.maxLevel} · ${controls.lat.toFixed(4)}, ${controls.lon.toFixed(4)} · ${Math.round(controls.range)} m`;
  }
  requestAnimationFrame(tick);
}

async function main(): Promise<void> {
  await terrain.init();
  await sites.load(`${import.meta.env.BASE_URL}data/sites.json`);
  const legend = document.getElementById("legend")!;
  const hidden = new Set<string>();
  for (const c of sites.categories) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" checked><span class="dot" style="background:${CATEGORY_COLORS[c] ?? "#fff"}"></span>${c}`;
    const box = label.querySelector("input")!;
    box.onchange = () => {
      if (box.checked) hidden.delete(c);
      else hidden.add(c);
      sites.setHidden(hidden);
    };
    legend.appendChild(label);
  }
  updateTime();
  requestAnimationFrame(tick);
}

main();

if (import.meta.env.DEV) {
  Object.assign(window, { atlas: { terrain, sites, controls, camera, renderer, scene } });
}
