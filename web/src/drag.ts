// Selecting cells with the mouse: a press selects a cell, and dragging
// extends the range, scrolling the table past its edges.
import { HEAD_H } from "./constants.ts";
import { S, moveBy, select } from "./app.ts";
import { renderSelectionInfo } from "./cell-popover.ts";
import { hasMore } from "./grid.ts";
import type { Pos } from "./types.ts";

const SCROLL_MS = 50; // one more row or column while held past an edge

export function wireDrag(g: HTMLElement) {
  let at: { x: number; y: number } | null = null; // the pointer, while dragging
  let timer = 0;

  const cellOf = (t: Element | null): Pos | null => {
    const cell = t?.closest<HTMLElement>("[data-r]");
    return cell && g.contains(cell) ? { r: Number(cell.dataset.r), c: Number(cell.dataset.c) } : null;
  };

  // past says which edges of the cells in view the pointer is beyond.
  const past = (): [number, number] => {
    const b = g.getBoundingClientRect();
    const beyond = (v: number, lo: number, hi: number) => (v < lo ? -1 : v >= hi ? 1 : 0);
    return [
      beyond(at!.y, b.top + g.clientTop + HEAD_H, b.top + g.clientTop + g.clientHeight),
      beyond(at!.x, b.left + g.clientLeft + S.rownumW, b.left + g.clientLeft + g.clientWidth),
    ];
  };

  const extend = () => {
    const p = cellOf(document.elementFromPoint(at!.x, at!.y));
    if (p && (p.r !== S.cur.r || p.c !== S.cur.c)) select(p, true);
  };

  const stop = () => {
    at = null;
    clearInterval(timer);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", stop);
    window.removeEventListener("blur", stop);
  };

  const move = (e: MouseEvent) => {
    if (!(e.buttons & 1)) return stop(); // released where we could not see
    at = { x: e.clientX, y: e.clientY };
    const [dr, dc] = past();
    if (!dr && !dc) extend();
  };

  g.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || !S.meta || t.closest(".xmark")) return;
    const p = cellOf(t);
    if (!p) return;
    select(p, e.shiftKey);
    // Selecting rebuilt the rows, so a double-click lands on two different
    // elements and fires no dblclick; the press's count still tells.
    if (e.detail === 2 && !e.shiftKey && hasMore(S.cur)) {
      S.expanded = true;
      renderSelectionInfo();
      return;
    }
    stop();
    at = { x: e.clientX, y: e.clientY };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    timer = window.setInterval(() => {
      const [dr, dc] = past();
      if (dr || dc) moveBy(dr, dc, true);
    }, SCROLL_MS);
  });
}
