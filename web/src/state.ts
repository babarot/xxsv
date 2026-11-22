// The page's shared state, in one object, and the changes that start the
// rows over. Nothing here touches the DOM.
//
// Stale responses: every request for rows, a full cell value or an aggregate
// notes state.epoch when it starts and is dropped if the epoch changed when
// it returns. The epoch moves on whenever the rows a display position
// stands for change: a new query (search, filters, sort) or a new load of
// the file. What each change keeps and drops is decided here, in newQuery
// and applyMeta, and nowhere else.
import { estimateWidth, rownumWidth } from "./format.ts";
import { emptyView } from "./hash.ts";
import { first } from "./selection.ts";
import type { Column, Meta, Pos, Sort, Stats, ViewState } from "./types.ts";

export interface State {
  meta: Meta | null;
  // The columns shown and their order (view.columns over the meta's
  // columns), and each one's position in the file. Display positions (the
  // c of a Pos, colPop, widths and stats) index these; project sets them.
  cols: Column[];
  fileIdx: number[];
  // allStats are the stats in file order; stats are those of the columns
  // shown, in their order.
  allStats: Stats[];
  stats: (Stats | undefined)[];
  // widthOf holds each column's width by name, so it follows the column when
  // columns are hidden or moved; widths are those of the columns shown. A
  // Map, since a column may be named "__proto__".
  widthOf: Map<string, number>;
  widths: number[];
  // widthsPending is set when the columns changed, until the first rows
  // come and the widths are fitted to them (fitWidths).
  widthsPending: boolean;
  rownumW: number; // fits the largest row number
  view: ViewState;
  total: number; // rows that match the query
  epoch: number;
  // The selection, as display positions in the filtered, sorted rows: cur
  // is the active cell, anchor the other corner of the range.
  cur: Pos;
  anchor: Pos;
  expanded: boolean; // the cell popover is open
  pinned: boolean; // the cell popover sits in the side panel instead
  colPop: number | null; // column whose distribution popover is open
  fullValue: { key: string; value: string } | null; // full text of a cut cell
  histScale: "linear" | "log";
  numGroup: boolean; // put commas in integers in the table (the Digit grouping setting)
  flash: Flash;
}

// Flash is the glow on cells changed by a reload. at is when the first rows
// of the reloaded file were shown (performance.now()): the changes glow for
// FLASH_MS from then, since on a large file the rows come a while after the
// meta. pending is set when a reload is seen, until those rows arrive. seen
// shows the summary. All stay unset on the first load and after a browser
// reload: nothing glows, and no summary is shown.
export interface Flash { at: number | null; pending: boolean; seen: boolean }

export function newState(view: ViewState = emptyView()): State {
  return {
    meta: null, cols: [], fileIdx: [], allStats: [], stats: [], widthOf: new Map(), widths: [], widthsPending: false,
    rownumW: 52, view, total: 0, epoch: 0,
    cur: { r: 0, c: 0 }, anchor: { r: 0, c: 0 },
    expanded: false, pinned: false, colPop: null, fullValue: null,
    histScale: "linear", numGroup: true, flash: { at: null, pending: false, seen: false },
  };
}

// newQuery starts the rows over for the current query: what a display
// position stands for changes, so the selection goes back to the first row
// (keeping the column), the cell popover closes and the full value of the
// old cell is dropped. The pinned panel, the distribution popover and the
// glow stay. The caller resets view.top when the query itself changed.
export function newQuery(s: State) {
  s.epoch++;
  s.cur = first(s.cur, s.cols.length || 1);
  s.anchor = { ...s.cur };
  s.expanded = false;
  s.fullValue = null;
}

// applyMeta takes a new meta and starts the rows over. When the generation
// changed, the glow of the last reload stops and the next waits for the new
// rows; filters, sort keys and shown columns that are gone are dropped, and
// columns new since the last meta are shown at the end (a column the user
// never hid is not hidden); when the columns changed, the stats are
// dropped, the widths wait for the first rows (fitWidths) and the
// distribution popover closes. The stats of the same columns stay until the
// new ones come (applyStats). It reports whether the columns changed.
export function applyMeta(s: State, m: Meta): { columnsChanged: boolean } {
  const columnsChanged = s.meta === null || JSON.stringify(s.meta.columns) !== JSON.stringify(m.columns);
  if (s.meta !== null && m.generation !== s.meta.generation) {
    s.flash = { at: null, pending: true, seen: true };
  }
  const before = s.meta ? new Set(s.meta.columns.map((c) => c.name)) : null;
  s.meta = m;
  const names = new Set(m.columns.map((c) => c.name));
  s.view.filters = s.view.filters.filter((f) => names.has(f.column));
  s.view.sorts = s.view.sorts.filter((k) => names.has(k.column));
  if (s.view.columns) {
    const added = before ? m.columns.map((c) => c.name).filter((n) => !before.has(n)) : [];
    s.view.columns = normalColumns(m, [...s.view.columns.filter((n) => names.has(n)), ...added]);
  }
  if (columnsChanged) {
    s.allStats = [];
    s.widthOf = new Map();
    s.widthsPending = true;
    s.colPop = null;
  }
  s.rownumW = rownumWidth(m.rows);
  project(s);
  newQuery(s);
  return { columnsChanged };
}

// normalColumns is the view's columns for a list of names: null (every
// column in file order) when the list is that, or empty.
export function normalColumns(m: Meta, names: string[]): string[] | null {
  const all = m.columns.map((c) => c.name);
  if (names.length === 0 || JSON.stringify(names) === JSON.stringify(all)) return null;
  return names;
}

// project sets the columns shown, their widths and stats from the meta and
// view.columns. A column shown for the first time gets a width from its name
// and type.
export function project(s: State) {
  if (!s.meta) return;
  const all = s.meta.columns;
  const pos = new Map(all.map((c, i) => [c.name, i]));
  const order = s.view.columns ? s.view.columns.flatMap((n) => (pos.has(n) ? [pos.get(n)!] : [])) : all.map((_, i) => i);
  s.fileIdx = order.length ? order : all.map((_, i) => i);
  s.cols = s.fileIdx.map((i) => all[i]);
  s.widths = s.cols.map((c) => {
    if (!s.widthOf.has(c.name)) s.widthOf.set(c.name, estimateWidth(c));
    return s.widthOf.get(c.name)!;
  });
  s.stats = s.allStats.length ? s.fileIdx.map((i) => s.allStats[i]) : [];
}

// setColumns shows the named columns in that order (null: every column). The
// distribution popover closes and the selection stays within the columns;
// the caller starts the rows over, since they come in the shown columns.
export function setColumns(s: State, names: string[] | null) {
  if (!s.meta) return;
  s.view.columns = names && normalColumns(s.meta, names);
  s.colPop = null;
  project(s);
}

// applyStats takes the stats of a generation, which come after the meta on
// a large file. It reports whether they were taken: stats of another
// generation than the meta's are dropped.
export function applyStats(s: State, generation: number, stats: Stats[]): boolean {
  if (s.meta?.generation !== generation) return false;
  s.allStats = stats;
  project(s);
  return true;
}

// fitWidths fits the widths of the columns shown to the first rows shown
// after the columns changed (rows come in the shown columns); later rows and
// the stats leave them, so the table does not shift under the reader. It
// reports whether the widths were set.
export function fitWidths(s: State, rows: string[][]): boolean {
  if (!s.widthsPending || !s.meta) return false;
  s.cols.forEach((c, i) => s.widthOf.set(c.name, estimateWidth(c, rows.map((r) => r[i] ?? ""))));
  s.widthsPending = false;
  project(s);
  return true;
}

// MAX_SORT_KEYS is the server's limit on sort keys.
export const MAX_SORT_KEYS = 5;

// nextSorts is the sort keys after a click on a column name (cycleSort). A
// Shift-click past the limit leaves the keys as they are.
export function nextSorts(sorts: Sort[], column: string, add: boolean): Sort[] {
  const i = sorts.findIndex((k) => k.column === column);
  if (!add) {
    if (sorts.length !== 1 || i !== 0) return [{ column }];
    return sorts[0].desc ? [] : [{ column, desc: true }];
  }
  if (i < 0) return sorts.length >= MAX_SORT_KEYS ? sorts : [...sorts, { column }];
  if (!sorts[i].desc) return sorts.map((k, j) => (j === i ? { column, desc: true } : k));
  return sorts.filter((_, j) => j !== i);
}

// rowsShown is called when a block of the current epoch is stored: the
// first one after a reload starts the glow.
export function rowsShown(s: State, now: number) {
  if (s.flash.pending) s.flash = { ...s.flash, at: now, pending: false };
}

// flashElapsed is how long the glow has been on, or Infinity if it is off.
export const flashElapsed = (s: State, now: number) => (s.flash.at === null ? Infinity : now - s.flash.at);
