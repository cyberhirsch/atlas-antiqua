// Shareable URL (PRD S4): camera, time and filters live in the location
// hash, so any view can be linked to. Updated while moving (throttled).

import type { View } from "./controls";
import type { Filters } from "./sites";
import type { TimeState } from "./timeline";

export interface UrlState {
  view?: View;
  time?: TimeState;
  filters?: Partial<Filters>;
  site?: string;
}

const f = (v: number, d: number) => Number(v.toFixed(d)).toString();

export function encode(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.view) {
    const v = s.view;
    p.set("v", [f(v.lat, 5), f(v.lon, 5), f(v.range, 0), f(v.heading, 3), f(v.pitch, 3)].join(","));
  }
  if (s.time && !s.time.all) p.set("t", s.time.start === s.time.end ? f(s.time.start, 0) : `${f(s.time.start, 0)}-${f(s.time.end, 0)}`);
  if (s.time?.period) p.set("p", s.time.period);
  const fl = s.filters;
  if (fl?.hiddenCategories?.size) p.set("hide", [...fl.hiddenCategories].join(","));
  if (fl?.country) p.set("country", fl.country);
  if (fl?.minConf?.some((x) => x > 0)) p.set("conf", fl.minConf.join(""));
  if (fl?.onlyShapes) p.set("shapes", "1");
  if (fl?.onlyAssets) p.set("assets", "1");
  if (s.site) p.set("site", s.site);
  return p.toString();
}

export function decode(hash: string): UrlState {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const s: UrlState = {};
  const v = p.get("v")?.split(",").map(Number);
  if (v && v.length === 5 && v.every(Number.isFinite)) {
    s.view = { lat: v[0], lon: v[1], range: v[2], heading: v[3], pitch: v[4] };
  }
  const t = p.get("t");
  if (t) {
    const [a, b] = t.split("-").map(Number);
    if (Number.isFinite(a)) s.time = { all: false, start: a, end: Number.isFinite(b) ? b : a, period: p.get("p") };
  }
  const filters: Partial<Filters> = {};
  if (p.get("hide")) filters.hiddenCategories = new Set(p.get("hide")!.split(","));
  if (p.get("country")) filters.country = p.get("country");
  const conf = p.get("conf");
  if (conf && /^\d{4}$/.test(conf)) filters.minConf = conf.split("").map(Number) as Filters["minConf"];
  if (p.get("shapes") === "1") filters.onlyShapes = true;
  if (p.get("assets") === "1") filters.onlyAssets = true;
  s.filters = filters;
  if (p.get("site")) s.site = p.get("site")!;
  return s;
}

let timer = 0;
export function write(s: UrlState): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    const hash = `#${encode(s)}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }, 400);
}
