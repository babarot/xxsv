// Histograms and the top values of a column, drawn in SVG or as bars.
import { NULL_MARK } from "./constants.ts";
import { abbr, binLabel, fmt } from "./format.ts";
import type { Hist, Stats } from "./types.ts";
import { el } from "./dom.ts";

export const SVG_NS = "http://www.w3.org/2000/svg";

export function svg(w: number, h: number, cls?: string) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s.setAttribute("preserveAspectRatio", "none");
  if (cls) s.setAttribute("class", cls);
  return s;
}

// histOf picks the histogram the Histogram setting asks for; log falls back
// to linear for columns that have no log histogram (negative values, dates).
export function histOf(s: Stats, scale: "linear" | "log"): { h: Hist; log: boolean } | null {
  if (scale === "log" && s.histogramLog) return { h: s.histogramLog, log: true };
  return s.histogram ? { h: s.histogram, log: false } : null;
}

export function histogram(s: Stats, scale: "linear" | "log", w: number, h: number, cls?: string): SVGElement | null {
  const hh = histOf(s, scale);
  if (!hh) return null;
  const counts = hh.h.counts;
  const max = Math.max(...counts, 1);
  const g = svg(w, h, cls);
  const bw = w / counts.length;
  const gap = counts.length > 40 ? 0 : Math.min(1, bw * 0.15);
  counts.forEach((c, i) => {
    const r = document.createElementNS(SVG_NS, "rect");
    const bh = c === 0 ? 0 : Math.max(1, (c / max) * h);
    r.setAttribute("x", String(i * bw + gap / 2));
    r.setAttribute("y", String(h - bh));
    r.setAttribute("width", String(Math.max(0.5, bw - gap)));
    r.setAttribute("height", String(bh));
    r.setAttribute("rx", String(Math.min(1, bw / 4)));
    r.setAttribute("fill", "var(--chart-bar)");
    const t = document.createElementNS(SVG_NS, "title");
    t.textContent = `${binLabel(s, hh.h, i)}: ${fmt(c)}`;
    r.appendChild(t);
    g.appendChild(r);
  });
  return g;
}

// barsMax is the count a full bar stands for in the popover: the most
// common value, or the missing cells when there are more of them.
export const barsMax = (s: Stats) => Math.max(s.top?.[0]?.count ?? 0, s.nulls, 1);

export function topBars(s: Stats, limit: number) {
  const box = el("div", "bars");
  const top = s.top ?? [];
  const max = barsMax(s);
  for (const t of top.slice(0, limit)) {
    const line = el("div");
    line.title = `${t.value === "" ? "(empty)" : t.value}: ${fmt(t.count)}`;
    const bar = el("em");
    const fill = el("i");
    fill.style.width = (t.count / max) * 100 + "%";
    bar.appendChild(fill);
    line.append(el("span", "", t.value === "" ? "(empty)" : t.value), bar, el("b", "", abbr(t.count)));
    box.appendChild(line);
  }
  return box;
}

// missingTitle describes the missing cells of a column.
// rowsOf is the number of rows a column's stats cover: values, missing
// and invalid cells.
export const rowsOf = (s: Stats) => s.count + s.nulls + s.invalid;

const missingTitle = (s: Stats) => `${NULL_MARK} missing: ${fmt(s.nulls)} of ${fmt(rowsOf(s))} rows (${Math.round((s.nulls / rowsOf(s)) * 100)}%)`;

// topSegments draws the share of the top values, and of the missing cells
// (hatched), in all the rows as one bar of shades.
export function topSegments(s: Stats, column: number) {
  const bar = el("div", "seg");
  const all = rowsOf(s) || 1;
  const shades = [100, 70, 45, 28];
  (s.top ?? []).slice(0, 4).forEach((t, i) => {
    const seg = el("i");
    seg.style.width = (t.count / all) * 100 + "%";
    seg.style.background = `color-mix(in srgb, var(--chart-bar) ${shades[i]}%, var(--surface))`;
    seg.title = `${t.value === "" ? "(empty)" : t.value}: ${fmt(t.count)}`;
    bar.appendChild(seg);
  });
  if (s.nulls > 0) {
    const miss = el("i", "miss");
    miss.style.width = (s.nulls / all) * 100 + "%";
    miss.style.marginLeft = "auto";
    miss.dataset.missing = String(column);
    miss.title = missingTitle(s) + ". Click to filter";
    bar.appendChild(miss);
  }
  return bar;
}

// missingColumn is a hatched column next to a histogram, as tall as the
// share of missing cells in all the rows; null when there are none.
export function missingColumn(s: Stats, column: number): HTMLElement | null {
  if (s.nulls === 0) return null;
  const col = el("div", "miss-col");
  col.dataset.missing = String(column);
  col.title = missingTitle(s) + ". Click to filter";
  const fill = el("i");
  fill.style.height = (s.nulls / rowsOf(s)) * 100 + "%";
  col.appendChild(fill);
  return col;
}

// missingLine is a hatched bar for the popover with the count of missing
// cells, on the scale of max (barsMax under the top values, all the rows
// under a histogram); null when there are none.
export function missingLine(s: Stats, on: boolean, max: number): HTMLElement | null {
  if (s.nulls === 0) return null;
  const box = el("div", "bars missing");
  const line = el("button", on ? "on" : "") as HTMLButtonElement;
  line.title = missingTitle(s) + (on ? ". Click to remove the filter" : ". Click to filter");
  const bar = el("em");
  const fill = el("i");
  fill.style.width = (s.nulls / max) * 100 + "%";
  bar.appendChild(fill);
  line.append(el("span", "", `${NULL_MARK} missing`), bar, el("b", "", abbr(s.nulls)));
  box.appendChild(line);
  return box;
}
