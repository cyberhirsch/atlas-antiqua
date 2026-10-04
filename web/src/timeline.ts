// Time selection UI: one year or a range, a non-linear slider scale (deep
// prehistory compressed, the historical millennia expanded, PRD T6), a
// period picker that lists the periods attested near the view (T5), and
// animation through time (T4).

import { yearLabel } from "./geo";
import { Period, TimeSelection } from "./sites";

export const PRESENT = new Date().getFullYear() + 10000;

/** Slider position (0..1) to year (HE) and back: piecewise linear knots. */
const KNOTS: [number, number][] = [[0, 0], [0.12, 8000], [0.88, 11500], [1, PRESENT]];

export function toYear(u: number): number {
  for (let i = 1; i < KNOTS.length; i++) {
    const [u0, y0] = KNOTS[i - 1];
    const [u1, y1] = KNOTS[i];
    if (u <= u1) return Math.round(y0 + ((u - u0) / (u1 - u0)) * (y1 - y0));
  }
  return PRESENT;
}

export function toPos(y: number): number {
  for (let i = 1; i < KNOTS.length; i++) {
    const [u0, y0] = KNOTS[i - 1];
    const [u1, y1] = KNOTS[i];
    if (y <= y1) return u0 + ((y - y0) / (y1 - y0)) * (u1 - u0);
  }
  return 1;
}

export interface TimeState extends TimeSelection {
  period: string | null; // period id when chosen from the picker
}

export class Timeline {
  state: TimeState = { all: true, start: 10100, end: 10100, period: null };
  onChange?: (s: TimeState) => void;
  private playing = false;
  private speed = 50; // years per second
  private lastTick = 0;
  private el: HTMLElement;
  private slider: HTMLInputElement;
  private label: HTMLOutputElement;
  private allBox: HTMLInputElement;
  private periodSel: HTMLSelectElement;
  private play: HTMLButtonElement;
  private speedSel: HTMLSelectElement;

  constructor(root: HTMLElement, private periods: Period[]) {
    this.el = root;
    root.innerHTML = `
      <label class="all"><input type="checkbox" id="all-dates" checked> All dates</label>
      <div class="slider-wrap">
        <input type="range" id="year" min="0" max="1000" step="1" aria-label="Year">
        <div class="ticks"></div>
      </div>
      <output id="year-label"></output>
      <div class="time-tools">
        <button id="play" title="Animate through time">▶</button>
        <select id="speed" title="Animation speed">
          <option value="10">10 years/s</option><option value="50" selected>50 years/s</option>
          <option value="200">200 years/s</option><option value="1000">1000 years/s</option>
        </select>
        <select id="period" title="Periods attested near the view"><option value="">Any period</option></select>
      </div>`;
    this.slider = root.querySelector("#year")!;
    this.label = root.querySelector("#year-label")!;
    this.allBox = root.querySelector("#all-dates")!;
    this.periodSel = root.querySelector("#period")!;
    this.play = root.querySelector("#play")!;
    this.speedSel = root.querySelector("#speed")!;
    const ticks = root.querySelector(".ticks")!;
    // Round BCE/CE years (HE = year + 10000 for CE, 10001 - year for BCE).
    const marks: [number, string][] = [[8001, "2000 BCE"], [9001, "1000 BCE"], [10001, "1 CE"], [10500, "500"],
      [11000, "1000"], [11500, "1500"], [12000, "2000"]];
    for (const [y, label] of marks) {
      const t = document.createElement("span");
      t.style.left = `${toPos(y) * 100}%`;
      t.textContent = label;
      t.title = `${y} HE · ${yearLabel(y)}`;
      ticks.appendChild(t);
    }
    this.slider.addEventListener("input", () => {
      const y = toYear(Number(this.slider.value) / 1000);
      this.set({ all: false, start: y, end: y, period: null });
    });
    this.allBox.addEventListener("change", () => this.set({ ...this.state, all: this.allBox.checked }));
    this.periodSel.addEventListener("change", () => {
      const p = this.periods.find((x) => x.id === this.periodSel.value);
      if (p) this.set({ all: false, start: p.start, end: p.end, period: p.id });
      else this.set({ ...this.state, end: this.state.start, period: null });
    });
    this.play.addEventListener("click", () => this.toggle());
    this.speedSel.addEventListener("change", () => (this.speed = Number(this.speedSel.value)));
    this.render();
  }

  set(s: TimeState): void {
    this.state = s;
    this.render();
    this.onChange?.(s);
  }

  /** Fill the period picker with periods attested by sites near the view. */
  setLocalPeriods(ids: Set<number>): void {
    const keep = this.periodSel.value;
    const list = this.periods
      .map((p, i) => ({ p, i }))
      .filter(({ i, p }) => ids.has(i) || p.id === keep)
      .sort((a, b) => a.p.start - b.p.start || a.p.end - b.p.end);
    const html = ['<option value="">Any period</option>'];
    for (const { p } of list) {
      html.push(`<option value="${p.id}">${p.label} (${yearLabel(p.start)} – ${yearLabel(p.end)})</option>`);
    }
    const joined = html.join("");
    if (this.periodSel.dataset.html !== joined) {
      this.periodSel.innerHTML = joined;
      this.periodSel.dataset.html = joined;
      this.periodSel.value = keep;
    }
  }

  private toggle(): void {
    this.playing = !this.playing;
    this.play.textContent = this.playing ? "❚❚" : "▶";
    this.lastTick = 0;
    if (this.playing && this.state.all) this.set({ all: false, start: 9000, end: 9000, period: null });
  }

  /** Advance the animation; call every frame. */
  tick(now: number): void {
    if (!this.playing) return;
    const dt = this.lastTick ? Math.min((now - this.lastTick) / 1000, 0.1) : 0;
    this.lastTick = now;
    const span = this.state.end - this.state.start;
    let start = this.state.start + this.speed * dt;
    if (start > PRESENT) start = 0;
    this.set({ all: false, start: Math.round(start * 10) / 10, end: Math.round((start + span) * 10) / 10, period: this.state.period });
  }

  private render(): void {
    const s = this.state;
    this.allBox.checked = s.all;
    this.slider.disabled = s.all;
    this.slider.value = String(Math.round(toPos(s.start) * 1000));
    const y0 = Math.round(s.start);
    const y1 = Math.round(s.end);
    this.label.textContent = s.all
      ? "all dates"
      : y0 === y1
        ? `${y0} HE · ${yearLabel(y0)}`
        : `${y0}–${y1} HE · ${yearLabel(y0)} – ${yearLabel(y1)}`;
    if (!s.period) this.periodSel.value = "";
    this.el.classList.toggle("is-all", s.all);
  }
}
