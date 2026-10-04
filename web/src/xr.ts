// WebXR (PRD X1-X6):
// - VR at 1:1: stand at the view's target point; controllers teleport
//   (trigger on the ground) and snap-turn (thumbstick left/right) (X1, X5)
// - VR table: the landscape as a miniature in front of the user (X2)
// - AR on site: sites, shapes and assets around the user, placed by GPS and
//   compass, with buttons to nudge the overlay into line (X3, X6)
// - AR tabletop: the same miniature on a real table, placed by tapping a
//   detected surface (X4)
//
// The XR reference space is rotated so that poses come out in Earth-fixed
// (ECEF) axes. The rest of the viewer then works unchanged: it only needs
// the camera position in ECEF and the floating origin.

import * as THREE from "three";
import { Vec3, add, ecef, enu, geodetic, scale } from "./geo";

export type XrMode = "vr" | "vr-table" | "ar" | "ar-table";

const TABLE_SCALE = 1 / 2000;
const SNAP = Math.PI / 6;

export interface XrFrame {
  cam: Vec3;    // camera position in ECEF (for level of detail)
  origin: Vec3; // floating origin in ECEF (positions are relative to it)
  scale: number;
  showTerrain: boolean;
}

export class Xr {
  mode: XrMode | null = null;
  private anchor = { lon: 0, lat: 0, h: 0, heading: 0 };
  private world: THREE.Group;
  private base?: XRReferenceSpace;
  private session?: XRSession;
  private hitSource?: XRHitTestSource;
  private tablePos = new THREE.Vector3(0, 0.9, -1.2);
  private placed = false;
  private lastStick = 0;
  private overlay: HTMLElement;
  onEnd?: () => void;
  /** Ground pick in world space for teleporting: ray origin/direction -> lon/lat/h. */
  pickGround?: (ray: THREE.Ray) => [number, number, number] | undefined;
  heightAt?: (lon: number, lat: number) => number | undefined;

  constructor(private renderer: THREE.WebGLRenderer, world: THREE.Group, overlay: HTMLElement) {
    this.world = world;
    this.overlay = overlay;
  }

  async enter(mode: XrMode, at: { lon: number; lat: number; h: number; heading: number }): Promise<void> {
    const xr = navigator.xr!;
    const ar = mode.startsWith("ar");
    const opts: XRSessionInit = ar
      ? { requiredFeatures: mode === "ar-table" ? ["hit-test"] : [], optionalFeatures: ["dom-overlay", "local-floor"], domOverlay: { root: this.overlay } }
      : { optionalFeatures: ["local-floor", "bounded-floor"] };
    const session = await xr.requestSession(ar ? "immersive-ar" : "immersive-vr", opts);
    this.session = session;
    this.mode = mode;
    this.placed = mode !== "ar-table";
    this.anchor = { ...at };
    if (mode === "ar") await this.locate();
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType(ar ? "local" : "local-floor");
    await this.renderer.xr.setSession(session);
    this.base = this.renderer.xr.getReferenceSpace()!;
    if (mode === "ar-table") {
      const viewer = await session.requestReferenceSpace("viewer");
      this.hitSource = await session.requestHitTestSource!({ space: viewer });
      session.addEventListener("select", () => (this.placed = true));
    }
    this.applyReference();
    this.controllers();
    this.overlay.hidden = !ar;
    if (ar) this.alignmentUi();
    session.addEventListener("end", () => {
      this.mode = null;
      this.session = undefined;
      this.hitSource = undefined;
      this.renderer.xr.enabled = false;
      this.world.matrix.identity();
      this.world.matrixAutoUpdate = true;
      this.overlay.hidden = true;
      this.onEnd?.();
    });
  }

  exit(): void {
    this.session?.end();
  }

  /** GPS position and compass heading for AR on site (X3). */
  private async locate(): Promise<void> {
    const pos = await new Promise<GeolocationPosition>((ok, fail) =>
      navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: true, timeout: 15000 }));
    this.anchor.lon = pos.coords.longitude;
    this.anchor.lat = pos.coords.latitude;
    // The device is about 1.4 m above the ground at session start.
    this.anchor.h = (this.heightAt?.(this.anchor.lon, this.anchor.lat) ?? pos.coords.altitude ?? 0) + 1.4;
    const heading = await new Promise<number | null>((ok) => {
      const on = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
        window.removeEventListener("deviceorientationabsolute", on as EventListener);
        ok(e.webkitCompassHeading ?? (e.alpha !== null ? (360 - e.alpha) % 360 : null));
      };
      window.addEventListener("deviceorientationabsolute", on as EventListener);
      setTimeout(() => ok(null), 3000);
    });
    // Heading of the device's forward direction at session start.
    this.anchor.heading = ((heading ?? 0) * Math.PI) / 180;
  }

  /**
   * Rotate the reference space so poses are in ECEF axes, turned by the
   * anchor heading (the user's forward direction at the start).
   */
  private applyReference(): void {
    if (!this.base) return;
    const [e, n, u] = enu(this.anchor.lon, this.anchor.lat);
    // Local XR frame: x right, y up, -z forward (= heading on the ground).
    const ch = Math.cos(this.anchor.heading);
    const sh = Math.sin(this.anchor.heading);
    const fwd = add(scale(n, ch), scale(e, sh));
    const right = add(scale(e, ch), scale(n, -sh));
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...right), new THREE.Vector3(...u), new THREE.Vector3(-fwd[0], -fwd[1], -fwd[2]));
    const q = new THREE.Quaternion().setFromRotationMatrix(m).invert();
    const space = this.base.getOffsetReferenceSpace(new XRRigidTransform({ x: 0, y: 0, z: 0, w: 1 }, { x: q.x, y: q.y, z: q.z, w: q.w }));
    this.renderer.xr.setReferenceSpace(space);
    this.worldBasis = m;
  }

  private worldBasis = new THREE.Matrix4();

  /** Per frame: where the viewer is in ECEF, and how the world is placed. */
  frame(xrCamera: THREE.Camera, frame?: XRFrame): XrFrame {
    const origin = ecef(this.anchor.lon, this.anchor.lat, this.anchor.h);
    const p = new THREE.Vector3().setFromMatrixPosition(xrCamera.matrixWorld);
    const table = this.mode === "vr-table" || this.mode === "ar-table";
    if (this.mode === "ar-table" && !this.placed && frame && this.hitSource) {
      const hit = frame.getHitTestResults(this.hitSource)[0];
      const pose = hit?.getPose(this.renderer.xr.getReferenceSpace()!);
      if (pose) this.tablePos.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
    }
    if (table) {
      // Table position is given in the local frame; convert to ECEF axes.
      const t = this.tablePos.clone().applyMatrix4(this.worldBasis);
      this.world.matrixAutoUpdate = false;
      this.world.matrix.makeScale(TABLE_SCALE, TABLE_SCALE, TABLE_SCALE).setPosition(t);
      this.world.matrixWorldNeedsUpdate = true;
      const rel = p.clone().sub(t).divideScalar(TABLE_SCALE);
      return { cam: add(origin, [rel.x, rel.y, rel.z]), origin, scale: TABLE_SCALE, showTerrain: this.mode === "vr-table" || this.placed };
    }
    this.world.matrixAutoUpdate = true;
    this.world.matrix.identity();
    return { cam: add(origin, [p.x, p.y, p.z]), origin, scale: 1, showTerrain: this.mode === "vr" };
  }

  // --- controllers: teleport and snap turn (X5) ---------------------------

  private controllers(): void {
    for (const i of [0, 1]) {
      const c = this.renderer.xr.getController(i);
      c.addEventListener("selectstart", () => this.teleport(c));
    }
  }

  private teleport(controller: THREE.Object3D): void {
    if (this.mode !== "vr") return;
    const ray = new THREE.Ray();
    ray.origin.setFromMatrixPosition(controller.matrixWorld);
    ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    const hit = this.pickGround?.(ray);
    if (!hit) return;
    this.anchor.lon = hit[0];
    this.anchor.lat = hit[1];
    this.anchor.h = hit[2];
    this.applyReference();
  }

  /** Thumbstick snap turning; call every frame. */
  poll(now: number): void {
    if (!this.session || this.mode !== "vr") return;
    for (const src of this.session.inputSources) {
      const x = src.gamepad?.axes[2] ?? 0;
      if (Math.abs(x) > 0.7 && now - this.lastStick > 350) {
        this.lastStick = now;
        this.anchor.heading += Math.sign(x) * SNAP;
        this.applyReference();
      }
    }
  }

  // --- AR alignment (X6) --------------------------------------------------

  private alignmentUi(): void {
    this.overlay.innerHTML = `
      <div class="xr-align">
        <p>Overlay placed by GPS and compass. Nudge it until it lines up with the ruins.</p>
        <div class="grid">
          <button data-m="turn-left">↺ 2°</button><button data-m="north">↑ 1 m</button><button data-m="turn-right">↻ 2°</button>
          <button data-m="west">← 1 m</button><button data-m="down">▼ 0.5 m</button><button data-m="east">→ 1 m</button>
          <button data-m="up">▲ 0.5 m</button><button data-m="south">↓ 1 m</button><button data-m="exit">Exit AR</button>
        </div>
      </div>`;
    this.overlay.querySelectorAll<HTMLButtonElement>("button[data-m]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const m = b.dataset.m!;
        const dLat = 1 / 111320;
        const dLon = 1 / (111320 * Math.cos((this.anchor.lat * Math.PI) / 180));
        if (m === "turn-left") this.anchor.heading -= (2 * Math.PI) / 180;
        if (m === "turn-right") this.anchor.heading += (2 * Math.PI) / 180;
        // Moving the overlay north means moving the anchor south, and so on.
        if (m === "north") this.anchor.lat -= dLat;
        if (m === "south") this.anchor.lat += dLat;
        if (m === "east") this.anchor.lon -= dLon;
        if (m === "west") this.anchor.lon += dLon;
        if (m === "up") this.anchor.h -= 0.5;
        if (m === "down") this.anchor.h += 0.5;
        if (m === "exit") return this.exit();
        this.applyReference();
      }));
  }

  /** Current anchor as lon/lat, e.g. to continue on the map after XR. */
  where(): { lon: number; lat: number } {
    const [lon, lat] = geodetic(ecef(this.anchor.lon, this.anchor.lat, this.anchor.h));
    return { lon, lat };
  }
}
