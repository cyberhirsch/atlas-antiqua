// Globe camera: orbits a target point on the ground. Left drag pans,
// right drag (or shift + left drag) turns and tilts, the wheel zooms
// towards the target. State is kept in double precision.

import * as THREE from "three";
import { Vec3, add, ecef, enu, scale, WGS84_A } from "./geo";

export interface View {
  lon: number;
  lat: number;
  range: number;
  heading: number; // radians, 0 = looking north
  pitch: number;   // radians, -PI/2 = straight down
}

export class GlobeControls {
  lon = 12;
  lat = 40;
  h = 0;           // ground height under the target (ellipsoidal)
  range = 2.2e7;
  heading = 0;
  pitch = -Math.PI / 2;
  private flight?: { from: View; to: View; t0: number; ms: number };
  private drag?: { x: number; y: number; rotate: boolean; moved: number };
  onClick?: (x: number, y: number) => void;

  constructor(private el: HTMLElement, private camera: THREE.PerspectiveCamera) {
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, rotate: e.button === 2 || e.shiftKey, moved: 0 };
      this.flight = undefined;
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      if (this.drag.rotate) {
        this.heading -= dx * 0.005;
        this.pitch = Math.min(-0.05, Math.max(-Math.PI / 2, this.pitch - dy * 0.005));
      } else {
        this.pan(dx, dy);
      }
    });
    el.addEventListener("pointerup", (e) => {
      if (this.drag && this.drag.moved < 4) this.onClick?.(e.clientX, e.clientY);
      this.drag = undefined;
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.flight = undefined;
        this.range = Math.min(4e7, Math.max(30, this.range * Math.exp(e.deltaY * 0.0012)));
      },
      { passive: false },
    );
  }

  private pan(dx: number, dy: number): void {
    const mpp = (2 * this.range * Math.tan((this.camera.fov * Math.PI) / 360)) / this.el.clientHeight;
    const k = Math.min(mpp, 2e5) / WGS84_A * (180 / Math.PI);
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    // The ground follows the pointer, so the target moves against the drag.
    // Screen right is (east, north) = (cos h, -sin h), screen up is (sin h, cos h).
    const east = -dx * ch + dy * sh;
    const north = dx * sh + dy * ch;
    this.lat = Math.max(-89, Math.min(89, this.lat + north * k));
    this.lon += (east * k) / Math.max(Math.cos((this.lat * Math.PI) / 180), 0.05);
    this.lon = ((this.lon + 540) % 360) - 180;
  }

  flyTo(to: View, ms = 2500): void {
    this.flight = { from: this.view(), to, t0: performance.now(), ms };
  }

  view(): View {
    return { lon: this.lon, lat: this.lat, range: this.range, heading: this.heading, pitch: this.pitch };
  }

  target(): Vec3 {
    return ecef(this.lon, this.lat, this.h);
  }

  /** Camera position in ECEF. */
  update(now: number): Vec3 {
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (now - f.t0) / f.ms);
      const s = t * t * (3 - 2 * t);
      // Rise and fall in log space, so long flights pass through orbit.
      const peak = Math.max(f.from.range, f.to.range, Math.min(1.5e7, 40 * dist(f.from, f.to)));
      const logR = (1 - s) * Math.log(f.from.range) + s * Math.log(f.to.range);
      const bump = Math.sin(Math.PI * s) * Math.max(0, Math.log(peak) - Math.max(Math.log(f.from.range), Math.log(f.to.range)));
      let dLon = f.to.lon - f.from.lon;
      if (dLon > 180) dLon -= 360;
      if (dLon < -180) dLon += 360;
      this.lon = f.from.lon + dLon * s;
      this.lat = f.from.lat + (f.to.lat - f.from.lat) * s;
      this.range = Math.exp(logR + bump);
      this.heading = f.from.heading + (f.to.heading - f.from.heading) * s;
      this.pitch = f.from.pitch + (f.to.pitch - f.from.pitch) * s;
      if (t >= 1) this.flight = undefined;
    }
    const [e, n, u] = enu(this.lon, this.lat);
    const cp = Math.cos(this.pitch);
    const look: Vec3 = add(add(scale(e, cp * Math.sin(this.heading)), scale(n, cp * Math.cos(this.heading))), scale(u, Math.sin(this.pitch)));
    return add(this.target(), scale(look, -this.range));
  }
}

function dist(a: View, b: View): number {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.hypot(x, y) * WGS84_A;
}
