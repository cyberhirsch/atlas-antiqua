// Coverage report page (PRD D5): sites per country and per period.

import { yearLabel } from "./geo";

interface Coverage {
  sites: number;
  dated: number;
  with_elevation: number;
  with_shapes: number;
  by_country: Record<string, number>;
  by_period: { id: string; start: number; end: number; sites: number }[];
}

const data: Coverage = await (await fetch(`${import.meta.env.BASE_URL}data/coverage.json`)).json();

const totals = document.getElementById("totals")!;
for (const [label, n] of [["sites", data.sites], ["dated", data.dated], ["with elevation", data.with_elevation], ["with outline shapes", data.with_shapes]] as const) {
  const d = document.createElement("div");
  d.innerHTML = `<b>${n.toLocaleString("en")}</b>${label}`;
  totals.appendChild(d);
}

function bars(root: HTMLElement, rows: [string, number, string?][]): void {
  const max = Math.max(...rows.map((r) => r[1]));
  for (const [label, n, title] of rows) {
    const name = document.createElement("span");
    name.textContent = label;
    if (title) name.title = title;
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.style.width = `${Math.max((n / max) * 100, 0.5)}%`;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = n.toLocaleString("en");
    root.append(name, bar, num);
  }
}

bars(document.getElementById("countries")!, Object.entries(data.by_country));
bars(document.getElementById("periods")!, data.by_period.map((p) => [
  p.id.replace(/-/g, " "), p.sites, `${p.start}–${p.end} HE (${yearLabel(p.start)} – ${yearLabel(p.end)})`,
]));
