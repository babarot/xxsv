// The page's state changes and what they redraw: loading the meta, a new
// query, the selection, filters and the sort. The state itself and what each
// change keeps are in state.ts; this file calls the drawing modules after.
import { MAX_CELL_BYTES } from "./constants.ts";
import { readHash, writeHash } from "./hash.ts";
import { Rows, blockOf } from "./rows.ts";
import { moved, range } from "./selection.ts";
import { applyMeta, applyStats, fitWidths, newQuery, newState, nextSorts, rowsShown, setColumns } from "./state.ts";
import { liveFilters, replaceColumn, topRules } from "./filters.ts";
import type { Filter, Meta, Pos, RowsResponse, Stats } from "./types.ts";
import { cancelAggregate, requestAggregate } from "./aggregate.ts";
import { api, post } from "./api.ts";
import { renderPinPanel, renderSelectionInfo } from "./cell-popover.ts";
import { renderChips } from "./chips.ts";
import { redrawFilterUi } from "./filter-ui.ts";
import { renderColumnsMenu } from "./columns-menu.ts";
import { restartValues } from "./values-panel.ts";
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
    // On a large file the stats come a while after the meta and the rows:
    // show the table first and the distributions when they come.
    const stats = api<{ generation: number; stats: Stats[] }>("/api/stats");
    stats.catch(() => {}); // awaited below; not unhandled while the meta loads
    const m = await api<Meta>("/api/meta");
    const { columnsChanged } = applyMeta(S, m);
    // applyMeta drops rules on columns that are gone; the rows start over
    // below, so the remembered query follows the filters as they are now.
    lastFilters = JSON.stringify(liveFilters(S.view.filters));
    // The distribution popover closes when its column is gone (applyMeta
    // clears it when the columns changed).
    renderColPop();
    renderTop();
    renderStatus();
    renderChips();
    // An open editor is drawn again only when columns changed: a reload of
    // the same columns must not drop what is being typed.
    if (columnsChanged) redrawFilterUi();
    renderColumnsMenu();
    restartRows();
    if (!$("settings").hidden) renderAbout();
    const s = await stats;
    if (applyStats(S, s.generation, s.stats)) {
      renderHeader();
      renderColPop();
    }
  } finally {
    setBusy(false);
  }
}

export const selRange = () => range(S.cur, S.anchor);

// cycleSort sorts by a clicked column name. A click sorts by that column
// alone, cycling ascending, descending and off; with add (Shift), the column
// is added as the last key, or its key cycles ascending, descending and off,
// leaving the other keys.
export function cycleSort(column: string, add: boolean) {
  S.view.sorts = nextSorts(S.view.sorts, column, add);
  S.view.top = 0;
  resetRows();
}

// currentQuery is the query of the view; rules still waiting for a value
// are left out.
export function currentQuery() {
  return { search: S.view.search, regex: S.view.regex || undefined, filters: liveFilters(S.view.filters), sorts: S.view.sorts, columns: S.view.columns ?? undefined };
}

// showColumns shows the named columns in that order (null: every column),
// and starts the rows over, since they come in the shown columns. The
// scroll position stays.
export function showColumns(names: string[] | null) {
  setColumns(S, names);
  $("colpop").hidden = true;
  renderCounts();
  resetRows();
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
  restartValues();
  writeHash(S.view);
  // After the columns changed, the header waits for the first rows to fit
  // the widths to (blockLoaded), so that it is drawn once.
  if (!S.widthsPending) renderHeader();
  const epoch = S.epoch;
  void rows.load(blockOf(S.view.top)).then(() => {
    // No rows came (a failed request): fit the widths to the names.
    if (epoch === S.epoch && fitWidths(S, [])) renderHeader();
    layout();
    scrollToRow(S.view.top);
    render();
    selectionChanged();
  });
}

// blockLoaded runs when a block of the current epoch was stored.
export function blockLoaded(b: number, res: RowsResponse) {
  if (fitWidths(S, res.rows)) renderHeader();
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

// setFilter replaces the rules directly on a column with f (none for null);
// rules on it inside groups stay.
export function setFilter(column: string, f: Filter | null) {
  S.view.filters = replaceColumn(S.view.filters, column, f);
  filtersChanged();
}

// filtersChanged starts the rows over after view.filters changed. The
// distribution popover is drawn again unless it made the change itself
// (keepColPop), so a box being typed in keeps the keyboard.
// A change that leaves the query the same (a rule still waiting for its
// value) keeps the rows and the scroll position.
let lastFilters = JSON.stringify(liveFilters(S.view.filters));
export function filtersChanged(keepColPop = false) {
  renderChips();
  const now = JSON.stringify(liveFilters(S.view.filters));
  if (now !== lastFilters) {
    lastFilters = now;
    S.view.top = 0;
    resetRows();
  } else writeHash(S.view);
  if (S.colPop !== null && !keepColPop) renderColPop();
}

export function moveBy(dr: number, dc: number, extend: boolean) {
  if (!S.meta || S.total === 0) return;
  const p = moved(S.cur, dr, dc, S.total, S.cols.length);
  ensureVisible(p);
  select(p, extend);
}

// toggleMissing filters a column to its missing cells, or removes that
// filter when it is on.
export function toggleMissing(column: string) {
  const on = topRules(S.view.filters, column).some((f) => f.op === "null");
  setFilter(column, on ? null : { column, op: "null" });
}
