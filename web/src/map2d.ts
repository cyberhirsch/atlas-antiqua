// 2D map mode for low-end devices (PRD G2): a flat Leaflet map with the
// same imagery, sites, time selection and filters as the globe, but no 3D
// terrain. Sites appear by importance as the map zooms in, like on the globe.

import type * as L from "leaflet";
import { CATEGORY_COLORS, Site, Sites } from "./sites";

const EOX_3857 = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg";

export class Map2D {
  private map?: L.Map;
  private layer?: L.LayerGroup;
  private leaflet?: typeof L;
  onPick?: (s: Site) => void;
  active = false;

  constructor(private el: HTMLElement, private sites: Sites) {}

  async show(lon: number, lat: number, range: number): Promise<void> {
    this.active = true;
    this.el.hidden = false;
    if (!this.leaflet) {
      this.leaflet = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
    }
    const Lf = this.leaflet;
    const zoom = Math.max(2, Math.min(17, Math.round(Math.log2(4e7 / Math.max(range, 100)))));
    if (!this.map) {
      this.map = Lf.map(this.el, { preferCanvas: true, worldCopyJump: true }).setView([lat, lon], zoom);
      Lf.tileLayer(EOX_3857, {
        maxZoom: 17,
        attribution: 'Sentinel-2 cloudless 2016 by <a href="https://s2maps.eu">EOX</a> (CC BY 4.0)',
      }).addTo(this.map);
      this.layer = Lf.layerGroup().addTo(this.map);
      this.map.on("moveend zoomend", () => this.refresh());
    } else {
      this.map.setView([lat, lon], zoom);
      this.map.invalidateSize();
    }
    this.refresh();
  }

  hide(): { lon: number; lat: number; range: number } | undefined {
    this.active = false;
    this.el.hidden = true;
    if (!this.map) return undefined;
    const c = this.map.getCenter();
    return { lon: c.lng, lat: c.lat, range: 4e7 / 2 ** this.map.getZoom() };
  }

  /** Redraw the sites in view; call after time or filter changes. */
  refresh(): void {
    if (!this.map || !this.layer || !this.leaflet || !this.active) return;
    const Lf = this.leaflet;
    this.layer.clearLayers();
    const b = this.map.getBounds().pad(0.1);
    // Ground size of the view, compared with each site's view distance.
    const viewKm = this.map.distance(b.getSouthWest(), b.getNorthEast()) / 1000;
    let n = 0;
    for (const s of this.sites.sites) {
      if (!b.contains([s.lat, s.lon]) || !this.sites.visible(s)) continue;
      if (s.viewKm !== null && s.viewKm < viewKm / 2) continue;
      const alpha = this.sites.timeAlpha(s);
      Lf.circleMarker([s.lat, s.lon], {
        radius: 5, weight: s.confidence >= 3 ? 1 : 2, color: "#000",
        fillColor: CATEGORY_COLORS[s.category] ?? "#fff",
        fillOpacity: (s.confidence >= 3 ? 0.95 : s.confidence === 2 ? 0.35 : 0.1) * alpha,
        opacity: alpha, dashArray: s.confidence <= 1 ? "2 2" : undefined,
      }).on("click", () => this.onPick?.(s)).addTo(this.layer);
      if (++n > 5000) break;
    }
  }
}
