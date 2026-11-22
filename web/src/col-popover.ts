// The distribution popover of a column: chart, statistics and filters.
import { NULL_MARK } from "./constants.ts";
import { abbr, edgeLabel, fmt, histStep, invalidText, isRange, round } from "./format.ts";
import { icon } from "./icons.ts";
import type { Column, Filter, Stats } from "./types.ts";
import { S, setFilter, showColumns, toggleColPop, toggleMissing } from "./app.ts";
import { positionPopovers } from "./cell-popover.ts";
import { barsMax, histOf, histogram, missingLine, rowsOf, topBars } from "./charts.ts";
import { $, el } from "./dom.ts";

export function renderColPop() {
  const pop = $("colpop");
  if (S.colPop === null || !S.meta) {
    pop.hidden = true;
    return;
  }
  const c = S.cols[S.colPop];
  const s = S.stats[S.colPop];
  pop.replaceChildren();
  const title = el("div", "col-title");
  title.append(el("b", "", c.name), el("span", "typ", c.type));
  const close = el("button", "btn-icon") as HTMLButtonElement;
  close.style.marginLeft = "auto";
  close.title = "Close (Esc)";
  close.appendChild(icon("x", 13));
  close.addEventListener("click", () => toggleColPop(S.colPop!));
  title.appendChild(close);
  pop.appendChild(title);
  const hh = s && histOf(s, S.histScale);
  const h = s && histogram(s, S.histScale, 290, 64, "big");
  if (h && hh) {
    pop.appendChild(h);
    const bins = hh.h.bins;
    const axis = el("div", "axis");
    const mid = hh.log ? Math.pow(10, (Math.log10(bins[0] + 1) + Math.log10(bins[bins.length - 1] + 1)) / 2) - 1 : (bins[0] + bins[bins.length - 1]) / 2;
    axis.append(el("span", "", edgeLabel(s, bins[0])), el("span", "", edgeLabel(s, mid) + (hh.log ? " (log)" : "")), el("span", "", edgeLabel(s, bins[bins.length - 1] - (hh.h.discrete ? histStep(s.type) : 0))));
    pop.appendChild(axis);
  } else if (s?.top?.length) {
    pop.appendChild(topBars(s, 8));
  } else {
    pop.appendChild(el("div", "dim", c.type === "json" ? "Nested JSON values have no chart." : "No values."));
  }
  const missOn = S.view.filters.some((f) => f.column === c.name && f.op === "null");
  const miss = s && missingLine(s, missOn, h ? rowsOf(s) : barsMax(s));
  if (miss) {
    miss.querySelector("button")!.addEventListener("click", () => toggleMissing(c.name));
    pop.appendChild(miss);
  }
  if (s) {
    const kv = el("div", "kv");
    const add = (k: string, v: string | undefined) => {
      if (v === undefined) return;
      const d = el("div");
      d.append(el("span", "", k), el("b", "", v));
      d.title = `${k}: ${v}`;
      kv.appendChild(d);
    };
    add("count", fmt(s.count));
    add("missing", fmt(s.nulls));
    if (s.invalid) add("invalid", fmt(s.invalid));
    add("unique", (s.uniqueApprox ? "> " : "") + fmt(s.unique));
    if (s.mean !== undefined) add("mean", round(s.mean));
    if (s.median !== undefined) add("median", round(s.median));
    if (s.minLabel) {
      add("min", s.minLabel);
      add("max", s.maxLabel);
    } else if (s.max !== undefined) add("max", round(s.max));
    pop.appendChild(kv);
  }
  pop.appendChild(filterForm(c, s));
  pop.appendChild(hideButton(c));
  pop.hidden = false;
  positionPopovers();
}

export function filterForm(c: Column, s?: Stats) {
  const current = S.view.filters.find((f) => f.column === c.name);
  const box = el("div", "ff");
  box.appendChild(el("div", "lbl", "Filter"));
  const row = el("div", "ffrow");
  const field = (value: string, placeholder: string) => {
    const i = el("input") as HTMLInputElement;
    i.value = value;
    i.placeholder = placeholder;
    return i;
  };
  // Missing cells are filtered from a row of their own, under a label and
  // with dashed borders, so they do not read as values of the column, after
  // the value filters. Only columns with missing cells get it.
  const missing = (): HTMLElement[] => {
    if (!s || (s.nulls === 0 && s.invalid === 0)) return [];
    const opt = (op: "null" | "notnull" | "invalid", label: string, count: number) => {
      const on = current?.op === op;
      const b = el("button", on ? "on" : "") as HTMLButtonElement;
      b.dataset.op = op;
      b.title = `${label} (${fmt(count)})`;
      b.append(el("em", "", label), el("span", "", abbr(count)));
      b.addEventListener("click", () => setFilter(c.name, on ? null : { column: c.name, op }));
      return b;
    };
    const pick = el("div", "pick missing");
    if (s.nulls > 0) pick.append(opt("null", `${NULL_MARK} only`, s.nulls), opt("notnull", `exclude ${NULL_MARK}`, s.count + s.invalid));
    // Cells whose text is not a value of the type ("pending" in numbers).
    if (s.invalid > 0) pick.append(opt("invalid", invalidText(c.type), s.invalid));
    return [el("div", "lbl", "Missing"), pick];
  };
  const actions = el("div", "actions");
  const apply = el("button", "btn-primary") as HTMLButtonElement;
  apply.append(icon("filter", 13), el("span", "btn-label", "Apply"));
  actions.appendChild(apply);
  if (current) {
    const clear = el("button", "btn-ghost") as HTMLButtonElement;
    clear.append(el("span", "btn-label", "Clear"));
    clear.addEventListener("click", () => setFilter(c.name, null));
    actions.appendChild(clear);
  }
  if (isRange(c.type)) {
    const ph = c.type === "date" ? "YYYY-MM-DD" : c.type === "datetime" ? "YYYY-MM-DD hh:mm" : "";
    const lo = field(current?.op === "range" ? current.min ?? "" : "", ("min " + ph).trim());
    const hi = field(current?.op === "range" ? current.max ?? "" : "", ("max " + ph).trim());
    row.append(lo, el("span", "dim", "–"), hi);
    box.appendChild(row);
    box.append(...missing());
    const go = () => {
      const f: Filter = { column: c.name, op: "range" };
      if (lo.value.trim()) f.min = lo.value.trim();
      if (hi.value.trim()) f.max = hi.value.trim();
      setFilter(c.name, f.min || f.max ? f : null);
    };
    apply.addEventListener("click", go);
    for (const i of [lo, hi]) i.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  } else {
    const pick = el("div", "pick");
    if (s?.top?.length && c.type !== "json") {
      for (const t of s.top.slice(0, 8)) {
        const on = current?.op === "equals" && current.value === t.value;
        const b = el("button", on ? "on" : "") as HTMLButtonElement;
        b.title = `${t.value === "" ? "(empty)" : t.value} (${fmt(t.count)})`;
        b.append(el("em", "", t.value === "" ? "(empty)" : t.value), el("span", "", abbr(t.count)));
        b.addEventListener("click", () => setFilter(c.name, on ? null : { column: c.name, op: "equals", value: t.value }));
        pick.appendChild(b);
      }
    }
    if (pick.childElementCount) box.appendChild(pick);
    const q = field(current?.op === "contains" ? current.value ?? "" : "", "contains…");
    row.appendChild(q);
    box.appendChild(row);
    box.append(...missing());
    const go = () => setFilter(c.name, q.value.trim() ? { column: c.name, op: "contains", value: q.value.trim() } : null);
    apply.addEventListener("click", go);
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }
  box.appendChild(actions);
  return box;
}

// hideButton hides the popover's column; the last column shown stays.
function hideButton(c: Column) {
  const b = el("button", "btn-ghost") as HTMLButtonElement;
  b.append(icon("eye-off", 13), el("span", "btn-label", "Hide column"));
  b.disabled = S.cols.length === 1;
  b.title = b.disabled ? "The last column shown cannot be hidden" : "Hide this column (Columns shows it again)";
  b.addEventListener("click", () => showColumns(S.cols.map((x) => x.name).filter((n) => n !== c.name)));
  const row = el("div", "actions col-actions");
  row.appendChild(b);
  return row;
}
