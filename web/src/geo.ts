// WGS84 ellipsoid maths in double precision. Positions are ECEF metres,
// used directly as three.js world axes; the renderer keeps the camera at the
// origin (floating origin), so float32 precision is only needed near it.

export type Vec3 = [number, number, number];

export const WGS84_A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

export function ecef(lon: number, lat: number, h: number): Vec3 {
  const l = lon * DEG;
  const p = lat * DEG;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const n = WGS84_A / Math.sqrt(1 - E2 * sp * sp);
  return [(n + h) * cp * Math.cos(l), (n + h) * cp * Math.sin(l), (n * (1 - E2) + h) * sp];
}

/** Geodetic lon/lat/h from ECEF (Bowring's method, sub-millimetre). */
export function geodetic(v: Vec3): [number, number, number] {
  const [x, y, z] = v;
  const b = WGS84_A * (1 - F);
  const ep2 = (WGS84_A * WGS84_A - b * b) / (b * b);
  const p = Math.hypot(x, y);
  const th = Math.atan2(z * WGS84_A, p * b);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - E2 * WGS84_A * Math.cos(th) ** 3);
  const n = WGS84_A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  const h = p / Math.cos(lat) - n;
  return [Math.atan2(y, x) / DEG, lat / DEG, h];
}

/** East, north and up unit vectors at lon/lat. */
export function enu(lon: number, lat: number): [Vec3, Vec3, Vec3] {
  const l = lon * DEG;
  const p = lat * DEG;
  const east: Vec3 = [-Math.sin(l), Math.cos(l), 0];
  const north: Vec3 = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const up: Vec3 = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  return [east, north, up];
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Holocene year to a readable BCE/CE label. */
export function yearLabel(he: number): string {
  const astro = he - 10000;
  return astro <= 0 ? `${1 - astro} BCE` : `${astro} CE`;
}
