// The selected cell: the formula bar, the cell popover and the pinned side panel.
import { NULL_MARK } from "./constants.ts";
import { colLetter, fmt, pretty } from "./format.ts";
import { icon } from "./icons.ts";
import type { CellInfo } from "./rows.ts";
import { nameBox } from "./selection.ts";
import type { Column } from "./types.ts";
import { api } from "./api.ts";
import { S, setFilter } from "./app.ts";
import { $, copyText, el } from "./dom.ts";
import { cellAt, isLong, render } from "./grid.ts";
import { openValues } from "./values-panel.ts";
import { renderRowPanel } from "./row-panel.ts";

// renderSelectionInfo fills the formula bar, the cell popover and the pinned
// panel for the active cell, fetching the full value of a cut cell.
// canFilterBy reports whether the table can be filtered by a cell's value:
// its full value must have arrived, and JSON values cannot be matched. A
// missing cell filters to missing cells.
const canFilterBy = (col: Column, cell: CellInfo, ready: boolean) => cell.value === "" || (ready && col.type !== "json");

function filterBy(col: Column, cell: CellInfo, value: string) {
  if (cell.value === "") setFilter(col.name, { column: col.name, op: "null" });
  else setFilter(col.name, { column: col.name, op: "equals", value });
}

// The formula bar's filter button acts on the selected cell; what it
// filters by is set each time the selection info is drawn.
let fbarFilter: (() => void) | null = null;
export const filterBySelected = () => fbarFilter?.();

function renderFbarFilter(col: Column | null, cell: CellInfo | null, value: string, ready: boolean) {
  const b = $<HTMLButtonElement>("fbar-filter");
  const ok = col !== null && cell !== null && canFilterBy(col, cell, ready);
  b.disabled = !ok;
  fbarFilter = ok ? () => filterBy(col!, cell!, value) : null;
  b.title = !ok ? "Filter by this value" : cell!.value === "" ? "Filter to missing cells" : "Filter by this value";
}

export function renderSelectionInfo() {
  if (!S.meta) return;
  $("namebox").textContent = nameBox(S.cur, S.anchor);
  const col = S.cols[S.cur.c];
  const cell = cellAt(S.cur);
  const fval = $("fval");
  fval.replaceChildren();
  if (!cell) {
    $("peek").hidden = true;
    renderPinPanel(null);
    renderFbarFilter(null, null, "", false);
    return;
  }
  const key = `${S.meta.generation}:${cell.rowId}:${S.cur.c}`;
  const full = S.fullValue?.key === key ? S.fullValue.value : null;
  const value = full ?? cell.value;
  const v = el("span", "v" + (cell.value === "" ? " null" : ""), cell.value === "" ? `${NULL_MARK} (missing)` : value + (cell.cut && full === null ? "…" : ""));
  fval.append(v, el("span", "typ", `${col.name} · ${col.type}`));
  if (cell.cut && full === null) {
    const want = key;
    const epoch = S.epoch;
    api<{ value: string }>(`/api/cell?gen=${S.meta.generation}&row=${cell.rowId}&col=${S.fileIdx[S.cur.c]}`)
      .then((res) => {
        if (epoch !== S.epoch) return; // the query or the file changed meanwhile
        S.fullValue = { key: want, value: res.value };
        if (S.meta && `${S.meta.generation}:${cellAt(S.cur)?.rowId}:${S.cur.c}` === want) renderSelectionInfo();
      })
      .catch(() => { /* the table keeps showing the cut value */ });
  }
  const ready = !cell.cut || full !== null;
  renderFbarFilter(col, cell, value, ready);
  renderPeek(col, cell, value, ready);
  renderPinPanel({ col, cell, value, ready });
}

export function valueBlock(col: Column, cell: CellInfo, value: string, ready: boolean, mode: "peek" | "pin") {
  const box = document.createDocumentFragment();
  const head = el("div", "vb-head");
  head.append(el("span", "", `${colLetter(S.cur.c)}${S.cur.r + 1} · row ${fmt(cell.rowId + 1)} · ${col.name}`), el("span", "typ", col.type));
  const close = el("button", "btn-icon") as HTMLButtonElement;
  close.title = mode === "peek" ? "Close (Esc)" : "Unpin";
  close.setAttribute("aria-label", close.title);
  close.appendChild(icon(mode === "peek" ? "x" : "pin-off", 13));
  close.addEventListener("click", () => {
    if (mode === "peek") S.expanded = false;
    else S.panel = null;
    render();
    renderSelectionInfo();
  });
  head.appendChild(close);
  const pre = el("pre", "vb-pre", cell.value === "" ? `${NULL_MARK} (missing)` : ready ? pretty(value, col.type) : value + "…");
  const actions = el("div", "actions");
  const copy = el("button", "btn-ghost") as HTMLButtonElement;
  copy.append(icon("copy", 13), el("span", "btn-label", "Copy"));
  copy.disabled = !ready || cell.value === "";
  copy.addEventListener("click", () => void copyText(value, copy));
  const filter = el("button", "btn-ghost") as HTMLButtonElement;
  filter.append(icon("filter", 13), el("span", "btn-label", "Filter by this value"));
  filter.disabled = !canFilterBy(col, cell, ready);
  filter.addEventListener("click", () => filterBy(col, cell, value));
  actions.append(copy, filter);
  if (mode === "peek") {
    const pin = el("button", "btn-ghost") as HTMLButtonElement;
    pin.append(icon("pin", 13), el("span", "btn-label", "Pin to side"));
    pin.addEventListener("click", () => {
      S.panel = "cell";
      S.expanded = false;
      render();
      renderSelectionInfo();
    });
    actions.appendChild(pin);
  }
  box.append(head, pre, actions);
  return box;
}

export function renderPeek(col: Column, cell: CellInfo, value: string, ready: boolean) {
  const peek = $("peek");
  if (!S.expanded || S.panel === "cell" || !isLong(S.cur)) {
    peek.hidden = true;
    return;
  }
  peek.replaceChildren(valueBlock(col, cell, value, ready, "peek"));
  peek.hidden = false;
  positionPopovers();
}

// renderPinPanel draws the side panel when it shows the selected cell or its
// row; the values tab draws itself (values-panel.ts).
export function renderPinPanel(info: { col: Column; cell: CellInfo; value: string; ready: boolean } | null) {
  const panel = $("pinpanel");
  if (S.panel === null) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  if (S.panel === "row") return renderRowPanel(info?.cell ?? null);
  if (S.panel !== "cell") return;
  const body = info ? valueBlock(info.col, info.cell, info.value, info.ready, "pin") : el("div", "dim", "Loading…");
  panel.replaceChildren(panelTabs(), body);
}

// panelTabs are the side panel's tabs: the selected cell, and the values of
// a column (the selected cell's column, unless one was chosen).
export function panelTabs() {
  const tabs = el("div", "ptabs");
  const tab = (p: "cell" | "row" | "values", label: string) => {
    const b = el("button", S.panel === p ? "on" : "", label) as HTMLButtonElement;
    b.dataset.panel = p;
    b.addEventListener("click", () => {
      if (S.panel === p) return;
      S.panel = p;
      if (p === "values") openValues(S.valuesCol ?? S.cols[S.cur.c]?.name ?? null);
      else renderSelectionInfo();
    });
    return b;
  };
  tabs.append(tab("cell", "Cell"), tab("row", "Row"), tab("values", "Values"));
  const close = el("button", "btn-icon") as HTMLButtonElement;
  close.title = "Close the side panel";
  close.setAttribute("aria-label", close.title);
  close.appendChild(icon("x", 13));
  close.addEventListener("click", () => {
    S.panel = null;
    render();
    renderSelectionInfo();
  });
  tabs.appendChild(close);
  return tabs;
}

// positionPopovers keeps the cell popover under its cell (above it near the
// bottom) and the distribution popover under its column, as the table scrolls.
export function positionPopovers() {
  const center = $("center").getBoundingClientRect();
  const peek = $("peek");
  if (!peek.hidden) {
    const c = document.querySelector<HTMLElement>("#rows .cur");
    if (!c) peek.style.visibility = "hidden";
    else {
      peek.style.visibility = "";
      const r = c.getBoundingClientRect();
      const w = peek.offsetWidth, h = peek.offsetHeight;
      let top = r.bottom - center.top + 4;
      if (top + h > center.height - 4) top = Math.max(4, r.top - center.top - h - 4);
      peek.style.left = Math.min(Math.max(4, r.left - center.left), center.width - w - 8) + "px";
      peek.style.top = top + "px";
    }
  }
  const pop = $("colpop");
  if (!pop.hidden && S.colPop !== null) {
    const p = document.querySelector<HTMLElement>(`#header [data-prof="${S.colPop}"]`);
    if (p) {
      const r = p.getBoundingClientRect();
      pop.style.left = Math.min(Math.max(4, r.left - center.left), center.width - pop.offsetWidth - 8) + "px";
      pop.style.top = r.bottom - center.top + 4 + "px";
    }
  }
}
