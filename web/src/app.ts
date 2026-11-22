// The page's state changes and what they redraw: loading the meta, a new
// query, the selection, filters and the sort. The state itself and what each
// change keeps are in state.ts; this file calls the drawing modules after.
import { MAX_CELL_BYTES } from "./constants.ts";
import { readHash, writeHash } from "./hash.ts";
import { Rows, blockOf } from "./rows.ts";
import { moved, range } from "./selection.ts";
import { applyMeta, newQuery, newState, rowsShown } from "./state.ts";
import type { Filter, Meta, Pos, RowsResponse, Stats } from "./types.ts";
import { cancelAggregate, requestAggregate } from "./aggregate.ts";
import { api, post } from "./api.ts";
import { renderPinPanel, renderSelectionInfo } from "./cell-popover.ts";
import { renderChips } from "./chips.ts";
import { renderColPop } from "./col-popover.ts";
import { $ } from "./dom.ts";
import { ensureVisible, layout, render, scheduleRender, scrollToRow } from "./grid.ts";
import { renderHeader } from "./header.ts";
import { renderAbout } from "./settings.ts";
import { renderCounts, renderStatus, renderTop, setBusy, showError } from "./status.ts";

export const S = newState(readHash());

export const rows = new Rows({
  fetch: (offset, limit) => api<RowsResponse>("/api/rows", post({ ...currentQuery(), offset, limit, maxCellBytes: MAX_CELL_BYTES })),
  epoch: () => S.epoch,
  generation: () => S.meta?.generation,
  stale: () => void refresh(),
  loaded: blockLoaded,
  failed: showError,
});

let refreshing: Promise<void> | null = null;

export function refresh(): Promise<void> {
  if (!refreshing) refreshing = doRefresh().finally(() => (refreshing = null));
  return refreshing;
}

export async function doRefresh() {
  setBusy(true);
  try {
    const [m, s] = await Promise.all([api<Meta>("/api/meta"), api<{ stats: Stats[] }>("/api/stats")]);
    applyMeta(S, m, s.stats);
    // The distribution popover shows the new stats, or closes when its
    // column is gone (applyMeta clears it when the columns changed).
    renderColPop();
    renderTop();
    renderStatus();
    renderChips();
    restartRows();
    if (!$("settings").hidden) renderAbout();
  } finally {
    setBusy(false);
  }
}

export const selRange = () => range(S.cur, S.anchor);

export function cycleSort(column: string) {
  if (S.view.sort?.column !== column) S.view.sort = { column };
  else if (!S.view.sort.desc) S.view.sort = { column, desc: true };
  else S.view.sort = null;
  S.view.top = 0;
  resetRows();
}

export function currentQuery() {
  return { search: S.view.search, filters: S.view.filters, sort: S.view.sort ?? undefined };
}

// resetRows starts over after the query changed (state.ts: newQuery).
export function resetRows() {
  newQuery(S);
  restartRows();
}

// restartRows drops the rows and fetches the ones in view; the state has
// moved to a new epoch (newQuery or applyMeta). The scroll position is
// restored from view.top.
export function restartRows() {
  rows.reset();
  // Until the new rows arrive, nothing may show or act on the old cell:
  // clear the formula bar, the popover, the pinned panel and the aggregate.
  cancelAggregate();
  $("fval").replaceChildren();
  $<HTMLButtonElement>("fbar-filter").disabled = true;
  $("peek").hidden = true;
  renderPinPanel(null);
  writeHash(S.view);
  renderHeader();
  void rows.load(blockOf(S.view.top)).then(() => {
    layout();
    scrollToRow(S.view.top);
    render();
    selectionChanged();
  });
}

// blockLoaded runs when a block of the current epoch was stored.
export function blockLoaded(b: number, res: RowsResponse) {
  // The first block of a reloaded file starts the glow.
  rowsShown(S, performance.now());
  if (res.total !== S.total) {
    S.total = res.total;
    layout();
  }
  if (!S.meta?.error) showError("");
  renderCounts();
  scheduleRender();
  // The selected cell may have been waiting for this block (a keyboard
  // move past the loaded rows); show its value now.
  if (blockOf(S.cur.r) === b) renderSelectionInfo();
}

export function select(p: Pos, extend: boolean) {
  const moved = p.r !== S.cur.r || p.c !== S.cur.c;
  S.cur = p;
  if (!extend) S.anchor = { ...p };
  if (moved) S.expanded = false;
  S.colPop = null;
  $("colpop").hidden = true;
  renderHeader();
  render();
  selectionChanged();
}

export function selectionChanged() {
  renderSelectionInfo();
  requestAggregate();
}

export function toggleColPop(ci: number) {
  S.colPop = S.colPop === ci ? null : ci;
  S.expanded = false;
  $("peek").hidden = true;
  renderHeader();
  renderColPop();
}

export function setFilter(column: string, f: Filter | null) {
  S.view.filters = S.view.filters.filter((x) => x.column !== column);
  if (f) S.view.filters.push(f);
  S.view.top = 0;
  renderChips();
  resetRows();
  if (S.colPop !== null) renderColPop();
}

export function moveBy(dr: number, dc: number, extend: boolean) {
  if (!S.meta || S.total === 0) return;
  const p = moved(S.cur, dr, dc, S.total, S.meta.columns.length);
  ensureVisible(p);
  select(p, extend);
}

// toggleMissing filters a column to its missing cells, or removes that
// filter when it is on.
export function toggleMissing(column: string) {
  const on = S.view.filters.some((f) => f.column === column && f.op === "null");
  setFilter(column, on ? null : { column, op: "null" });
}
