// Virtual scrolling: only the rows in view are in the DOM, inside a sizer as
// tall as all the rows. Browsers cap element heights, so past MAX_PX the
// sizer is scaled down and the scroll position maps to rows by fraction.
// Nothing here touches the DOM; the grid's sizes come as arguments.
import { HEAD_H, MAX_PX, ROW_H } from "./constants.ts";

export interface Viewport { scrollTop: number; scrollHeight: number; clientHeight: number }

export const scale = (total: number) => {
  const h = total * ROW_H;
  return h > MAX_PX ? MAX_PX / h : 1;
};

export const sizerHeight = (total: number) => HEAD_H + total * ROW_H * scale(total);

export const visibleRows = (clientHeight: number) => Math.ceil((clientHeight - HEAD_H) / ROW_H) + 1;

// firstRow is the row at the top of the view.
export function firstRow(v: Viewport, total: number): number {
  if (scale(total) === 1) return Math.floor(v.scrollTop / ROW_H);
  const maxScroll = v.scrollHeight - v.clientHeight;
  const frac = maxScroll > 0 ? v.scrollTop / maxScroll : 0;
  return Math.round(frac * Math.max(0, total - visibleRows(v.clientHeight) + 1));
}

// scrollTopFor is the scroll position that puts a row at the top.
export function scrollTopFor(row: number, v: Viewport, total: number): number {
  row = Math.max(0, Math.min(row, Math.max(0, total - 1)));
  if (scale(total) === 1) return row * ROW_H;
  const maxScroll = v.scrollHeight - v.clientHeight;
  return (row / Math.max(1, total - visibleRows(v.clientHeight) + 1)) * maxScroll;
}

// rowsTop is where the rendered rows go: under the header at their place,
// or at the top of the view when the sizer is scaled.
export const rowsTop = (first: number, v: Viewport, total: number) =>
  scale(total) === 1 ? HEAD_H + first * ROW_H : v.scrollTop + HEAD_H;

// rowToReveal is the row to scroll to so that row r is in view, or null if
// it already is (keyboard moves scroll just enough).
export function rowToReveal(r: number, v: Viewport, total: number): number | null {
  const top = firstRow(v, total);
  const shown = visibleRows(v.clientHeight) - 2;
  if (r < top) return r;
  if (r >= top + shown) return r - shown + 1;
  return null;
}

// scrollLeftToReveal is the horizontal scroll position that shows column c,
// or null if it is in view; the row numbers stay stuck on the left.
export function scrollLeftToReveal(c: number, widths: number[], rownumW: number, scrollLeft: number, clientWidth: number): number | null {
  const left = rownumW + widths.slice(0, c).reduce((a, b) => a + b, 0);
  const right = left + widths[c];
  if (left - rownumW < scrollLeft) return left - rownumW;
  if (right > scrollLeft + clientWidth) return right - clientWidth;
  return null;
}
