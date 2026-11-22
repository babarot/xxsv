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
import type { Meta, Pos, Stats, ViewState } from "./types.ts";

export interface State {
  meta: Meta | null;
  stats: Stats[];
  widths: number[];
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
    meta: null, stats: [], widths: [], rownumW: 52, view, total: 0, epoch: 0,
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
  s.cur = first(s.cur, s.meta?.columns.length ?? 1);
  s.anchor = { ...s.cur };
  s.expanded = false;
  s.fullValue = null;
}

// applyMeta takes a new meta and stats and starts the rows over. When the
// generation changed, the glow of the last reload stops and the next waits
// for the new rows; filters and the sort on columns that are gone are
// dropped; when the columns changed, the widths are estimated again and the
// distribution popover closes. It reports whether the columns changed.
export function applyMeta(s: State, m: Meta, stats: Stats[]): { columnsChanged: boolean } {
  const columnsChanged = s.meta === null || JSON.stringify(s.meta.columns) !== JSON.stringify(m.columns);
  if (s.meta !== null && m.generation !== s.meta.generation) {
    s.flash = { at: null, pending: true, seen: true };
  }
  s.meta = m;
  s.stats = stats;
  const names = new Set(m.columns.map((c) => c.name));
  s.view.filters = s.view.filters.filter((f) => names.has(f.column));
  if (s.view.sort && !names.has(s.view.sort.column)) s.view.sort = null;
  if (columnsChanged) {
    s.widths = m.columns.map((c, i) => estimateWidth(c, stats[i]));
    s.colPop = null;
  }
  s.rownumW = rownumWidth(m.rows);
  newQuery(s);
  return { columnsChanged };
}

// rowsShown is called when a block of the current epoch is stored: the
// first one after a reload starts the glow.
export function rowsShown(s: State, now: number) {
  if (s.flash.pending) s.flash = { ...s.flash, at: now, pending: false };
}

// flashElapsed is how long the glow has been on, or Infinity if it is off.
export const flashElapsed = (s: State, now: number) => (s.flash.at === null ? Infinity : now - s.flash.at);
