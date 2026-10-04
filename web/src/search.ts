// Search by name, including alternative and historical names (PRD S1).
// Accent- and case-insensitive; prefix matches rank first, then major sites.

import type { Site } from "./sites";

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ*?]/g, "").toLowerCase();

export class Search {
  private index: { site: Site; main: string; all: string }[] = [];
  onPick?: (s: Site) => void;
  private list: HTMLUListElement;

  constructor(private input: HTMLInputElement, sites: Site[]) {
    this.index = sites.map((site) => ({ site, main: fold(site.name), all: fold(`${site.name}|${site.names}`) }));
    this.list = document.createElement("ul");
    this.list.className = "search-results";
    this.list.hidden = true;
    input.after(this.list);
    input.addEventListener("input", () => this.run());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.list.querySelector("button")?.click();
      if (e.key === "Escape") this.close();
      e.stopPropagation(); // keep W/A/S/D for typing
    });
  }

  find(q: string, limit = 12): Site[] {
    const f = fold(q.trim());
    if (f.length < 2) return [];
    const hits: { site: Site; score: number }[] = [];
    for (const e of this.index) {
      const at = e.all.indexOf(f);
      if (at < 0) continue;
      let score = e.main.startsWith(f) ? 0 : e.main.includes(f) ? 1 : e.all.includes(`|${f}`) ? 2 : 3;
      score -= (e.site.viewKm === null ? 0.6 : e.site.viewKm >= 1000 ? 0.4 : 0) + e.site.confidence * 0.05;
      hits.push({ site: e.site, score });
    }
    return hits.sort((a, b) => a.score - b.score || a.site.name.localeCompare(b.site.name)).slice(0, limit).map((h) => h.site);
  }

  private run(): void {
    const hits = this.find(this.input.value);
    this.list.innerHTML = "";
    for (const s of hits) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      const other = s.names.split("|").filter(Boolean).slice(0, 3).join(", ");
      b.innerHTML = `<span></span><small></small>`;
      b.querySelector("span")!.textContent = s.name;
      b.querySelector("small")!.textContent = [s.category, s.country, other].filter(Boolean).join(" · ");
      b.onclick = () => {
        this.close();
        this.onPick?.(s);
      };
      li.appendChild(b);
      this.list.appendChild(li);
    }
    this.list.hidden = hits.length === 0;
  }

  close(): void {
    this.list.hidden = true;
  }
}
