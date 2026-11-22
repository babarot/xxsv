// The selection, as display positions: cur is the active cell, anchor the
// other corner of the range. Nothing here touches the DOM.
import { colLetter } from "./format.ts";
import type { Pos } from "./types.ts";

export interface Range { r0: number; r1: number; c0: number; c1: number }

export const range = (cur: Pos, anchor: Pos): Range => ({
  r0: Math.min(cur.r, anchor.r), r1: Math.max(cur.r, anchor.r),
  c0: Math.min(cur.c, anchor.c), c1: Math.max(cur.c, anchor.c),
});

export const isSingle = (r: Range) => r.r0 === r.r1 && r.c0 === r.c1;

// moved returns the position dr rows and dc columns away, kept inside the
// table of rows x cols.
export const moved = (p: Pos, dr: number, dc: number, rows: number, cols: number): Pos => ({
  r: Math.max(0, Math.min(rows - 1, p.r + dr)),
  c: Math.max(0, Math.min(cols - 1, p.c + dc)),
});

// first is where the selection goes when the rows change: the first row,
// the same column (or the last one, when there are fewer columns now).
export const first = (p: Pos, cols: number): Pos => ({ r: 0, c: Math.min(p.c, Math.max(0, cols - 1)) });

// wholeColumn and wholeRow return [cur, anchor] for a column or a row.
export const wholeColumn = (c: number, rows: number): [Pos, Pos] => [{ r: 0, c }, { r: Math.max(0, rows - 1), c }];
export const wholeRow = (r: number, cols: number): [Pos, Pos] => [{ r, c: 0 }, { r, c: Math.max(0, cols - 1) }];

// nameBox names the selection like a spreadsheet: B2, or B2:C5 for a range.
export function nameBox(cur: Pos, anchor: Pos) {
  const { r0, r1, c0, c1 } = range(cur, anchor);
  return r0 !== r1 || c0 !== c1 ? `${colLetter(c0)}${r0 + 1}:${colLetter(c1)}${r1 + 1}` : `${colLetter(cur.c)}${cur.r + 1}`;
}
