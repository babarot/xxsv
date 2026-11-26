// The table body: virtual scrolling (scroll.ts does the math) and drawing
// the rows in view, with the selection and the glow of the last reload.
import { BLOCK, FLASH_MS, LONG_CHARS, NULL_MARK } from "./constants.ts";
import { fmt, groupDigits, imageKind, imageName, invalidText, isNum } from "./format.ts";
import { writeHash } from "./hash.ts";
import { icon } from "./icons.ts";
import { blockOf } from "./rows.ts";
import { firstRow as firstRowOf, rowToReveal, rowsTop, scrollLeftToReveal, scrollTopFor, sizerHeight, visibleRows as visibleRowsOf } from "./scroll.ts";
import { flashElapsed } from "./state.ts";
import type { Pos } from "./types.ts";
import { S, rows, selRange } from "./app.ts";
import { positionPopovers } from "./cell-popover.ts";
import { $, el } from "./dom.ts";
import { gridTemplate } from "./header.ts";
import { renderCounts } from "./status.ts";
import { showsImages, thumb } from "./thumbs.ts";

export const grid = () => $("grid");

export function layout() {
  $("sizer").style.height = sizerHeight(S.total) + "px";
  renderCounts();
}

export const visibleRows = () => visibleRowsOf(grid().clientHeight);

export const firstRow = () => firstRowOf(grid(), S.total);

export function scrollToRow(row: number) {
  const g = grid();
  g.scrollTop = scrollTopFor(row, g, S.total);
}

// ensureVisible scrolls just enough to show a cell (keyboard moves).
export function ensureVisible(p: Pos) {
  const g = grid();
  const row = rowToReveal(p.r, g, S.total);
  if (row !== null) scrollToRow(row);
  const left = scrollLeftToReveal(p.c, S.widths, S.rownumW, g.scrollLeft, g.clientWidth);
  if (left !== null) g.scrollLeft = left;
}

let frame = 0;

export function scheduleRender() {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
}

export const cellAt = (p: Pos) => (S.meta ? rows.cell(p) : null);

// hasMore reports whether a cell has more to show than fits the table: JSON,
// cut by the server, text past LONG_CHARS, or an image.
export function hasMore(p: Pos) {
  const cell = cellAt(p);
  if (!cell || cell.value === "" || !S.meta) return false;
  const t = S.cols[p.c].type;
  return t === "json" || cell.cut || (!isNum(t) && cell.value.length > LONG_CHARS) || imageKind(cell.value, t) !== null;
}

export function render() {
  if (!S.meta) return;
  const g = grid();
  const body = $("rows");
  const first = Math.min(firstRow(), Math.max(0, S.total - 1));
  const count = Math.min(visibleRows() + 2, Math.max(0, S.total - first));
  body.style.top = rowsTop(first, g, S.total) + "px";
  if (S.view.top !== first) {
    S.view.top = first;
    writeHash(S.view);
  }

  const template = gridTemplate();
  const cols = S.cols;
  // Rows are rebuilt on every scroll, so the flash animation starts with a
  // negative delay to pick up where it is: a row scrolled into view late
  // glows for the time left.
  const since = flashElapsed(S, performance.now());
  const flashing = since < FLASH_MS;
  body.style.setProperty("--flash-delay", flashing ? `${-Math.round(since)}ms` : "0ms");
  const { r0, r1, c0, c1 } = selRange();
  const rowEls: HTMLElement[] = [];
  for (let i = first; i < first + count; i++) {
    const b = Math.floor(i / BLOCK);
    const block = rows.block(b);
    if (!rows.has(b)) void rows.load(b);
    const row = el("div", "row");
    row.style.gridTemplateColumns = template;
    const rh = el("div", "rh" + (i >= r0 && i <= r1 ? " hl" : ""));
    rh.dataset.row = String(i);
    if (!block) {
      row.classList.add("loading");
      rh.textContent = fmt(i + 1);
      row.appendChild(rh);
      for (let c = 0; c < cols.length; c++) row.appendChild(el("div", "", c === 0 ? "…" : ""));
      rowEls.push(row);
      continue;
    }
    const r = i - b * BLOCK;
    if (flashing && block.added.has(r)) row.classList.add("added");
    rh.textContent = fmt(block.rowIds[r] + 1);
    rh.title = `Select row ${fmt(i + 1)}`;
    row.appendChild(rh);
    block.rows[r].forEach((v, c) => {
      const t = cols[c].type;
      const bad = block.invalid.has(`${r},${c}`);
      // Invalid text is shown as the file has it, never grouped.
      const shown = v === "" ? NULL_MARK : t === "integer" && S.numGroup && !bad ? groupDigits(v) : v;
      const cell = el("div", isNum(t) ? "num" : "", shown);
      cell.dataset.r = String(i);
      cell.dataset.c = String(c);
      if (v === "") cell.classList.add("null");
      if (block.cut.has(`${r},${c}`)) cell.classList.add("cut");
      const small = S.images && thumb({ value: v, type: t, gen: S.meta!.generation, rowId: block.rowIds[r], fileCol: S.fileIdx[c] }, cols[c].name, scheduleRender);
      if (small) {
        if (showsImages(cols[c].name) && imageKind(v, t) === "path") {
          cell.textContent = imageName(v);
          cell.title = v;
        }
        cell.prepend(small);
      }
      if (bad) {
        cell.classList.add("bad");
        cell.title = `${invalidText(t)} in a ${t} column`;
      }
      if (flashing && block.changed.has(`${r},${c}`)) cell.classList.add("chg");
      if (i >= r0 && i <= r1 && c >= c0 && c <= c1) cell.classList.add("inr");
      if (i === S.cur.r && c === S.cur.c) {
        cell.classList.add("cur");
        if (S.panel !== "cell" && hasMore({ r: i, c })) {
          const x = el("button", "xmark") as HTMLButtonElement;
          x.title = "Show the full value (Space, or double-click)";
          x.setAttribute("aria-label", "Show the full value");
          x.appendChild(icon("maximize", 11));
          cell.appendChild(x);
        }
      }
      row.appendChild(cell);
    });
    rowEls.push(row);
  }
  body.replaceChildren(...rowEls);
  positionPopovers();
  // Prefetch the next block while scrolling down.
  const next = Math.floor((first + count + BLOCK / 2) / BLOCK);
  if (next * BLOCK < S.total && !rows.has(next)) void rows.load(next);
  rows.evict(blockOf(first), blockOf(S.cur.r));
}
