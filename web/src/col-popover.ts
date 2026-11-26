// The distribution popover of a column: chart, statistics and filters.
import { NULL_MARK } from "./constants.ts";
import { abbr, edgeLabel, fmt, histStep, invalidText, round } from "./format.ts";
import { defaultRule, inGroup, incomplete, topRules } from "./filters.ts";
import { openAdvanced, opButton, ruleEditor } from "./filter-ui.ts";
import { icon } from "./icons.ts";
import type { Column, Filter, Stats } from "./types.ts";
import { S, filtersChanged, setFilter, showColumns, toggleColPop, toggleMissing } from "./app.ts";
import { positionPopovers } from "./cell-popover.ts";
import { barsMax, histOf, histogram, missingLine, rowsOf, topBars } from "./charts.ts";
import { $, el } from "./dom.ts";
import { openValues } from "./values-panel.ts";

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
  const missOn = topRules(S.view.filters, c.name).some((f) => f.op === "null");
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
  pop.appendChild(columnActions(c));
  pop.hidden = false;
  positionPopovers();
}

// filterForm edits the column's rule in place, with the same editor as its
// chip; a column in "or" rules or groups is edited in the advanced filter.
// Missing and invalid cells have a row of their own under it.
export function filterForm(c: Column, s?: Stats) {
  const box = el("div", "ff");
  box.appendChild(el("div", "lbl", "Filter"));
  const mine = topRules(S.view.filters, c.name);
  if (inGroup(S.view.filters, c.name) || mine.length > 1) {
    const note = el("div", "inadv");
    note.append(el("span", "", `${c.name} is part of the advanced filter.`));
    const go = el("button", "btn-ghost") as HTMLButtonElement;
    go.append(icon("sliders", 13), el("span", "btn-label", "Edit filter"));
    go.addEventListener("click", () => {
      toggleColPop(S.colPop!);
      openAdvanced();
    });
    box.append(note, go);
    box.append(...missingRow(c, s, mine[0]));
    return box;
  }
  // A new rule waits here until it has a value, then joins the filters.
  const current = mine[0];
  if (!current && draft?.column !== c.name) draft = defaultRule(c.name, c.type);
  const f = current ?? draft!;
  const join = () => {
    if (!S.view.filters.includes(f) && !incomplete(f)) {
      S.view.filters = [...S.view.filters, f];
      draft = null;
    }
  };
  const commit = () => {
    join();
    filtersChanged(true);
  };
  const head = el("div", "fe-head");
  head.append(opButton(f, () => {
    join();
    filtersChanged();
    renderColPop();
  }), el("span", "sp"));
  if (current) {
    const clear = el("button", "lnk") as HTMLButtonElement;
    clear.textContent = "Clear";
    clear.addEventListener("click", () => setFilter(c.name, null));
    head.appendChild(clear);
  }
  box.append(head, ruleEditor(f, commit, false));
  box.append(...missingRow(c, s, current));
  return box;
}

let draft: Filter | null = null;

// missingRow filters to missing or invalid cells, under a label and with
// dashed borders, so they do not read as values of the column. Only columns
// with such cells get it.
function missingRow(c: Column, s: Stats | undefined, current: Filter | undefined): HTMLElement[] {
  if (!s || (s.nulls === 0 && s.invalid === 0)) return [];
  const opt = (op: "null" | "notnull" | "invalid", label: string, count: number) => {
    const on = current?.op === op && !current.not;
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
}

// columnActions list the column's values in the side panel, or hide the
// column (the last column shown stays).
function columnActions(c: Column) {
  const values = el("button", "btn-ghost") as HTMLButtonElement;
  values.append(icon("list", 13), el("span", "btn-label", "All values"));
  values.title = "List every value and its count in the side panel";
  values.addEventListener("click", () => {
    toggleColPop(S.colPop!);
    openValues(c.name);
  });
  const b = el("button", "btn-ghost") as HTMLButtonElement;
  b.append(icon("eye-off", 13), el("span", "btn-label", "Hide column"));
  b.disabled = S.cols.length === 1;
  b.title = b.disabled ? "The last column shown cannot be hidden" : "Hide this column (Columns shows it again)";
  b.addEventListener("click", () => showColumns(S.cols.map((x) => x.name).filter((n) => n !== c.name)));
  const row = el("div", "actions col-actions");
  row.append(values, b);
  return row;
}
