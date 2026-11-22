// The side panel's Row tab: every value of the selected cell's row, one per
// line, the shown columns first in their order and the hidden ones after,
// dimmed. It follows the selection.
import { NULL_MARK, TYPE_ABBR } from "./constants.ts";
import { fmt, pretty } from "./format.ts";
import { icon } from "./icons.ts";
import type { CellInfo } from "./rows.ts";
import { S, setFilter } from "./app.ts";
import { api } from "./api.ts";
import { panelTabs } from "./cell-popover.ts";
import { $, el } from "./dom.ts";
import { cellAt } from "./grid.ts";

interface RowCell { value: string; null?: boolean; cut?: boolean }

// The row last fetched, and the whole values of its cut cells.
let shown: { key: string; cells: RowCell[] } | null = null;
let pending = "";

const keyOf = (rowId: number) => `${S.meta?.generation}:${rowId}`;

// renderRowPanel draws the row of the selected cell, fetching it when it is
// another row than the one shown.
export function renderRowPanel(cell: CellInfo | null) {
  const panel = $("pinpanel");
  if (S.panel !== "row" || !S.meta) return;
  panel.hidden = false;
  if (!cell) {
    panel.replaceChildren(panelTabs(), el("div", "dim", "Loading…"));
    return;
  }
  const key = keyOf(cell.rowId);
  if (shown?.key === key) return draw(cell.rowId, shown.cells);
  panel.replaceChildren(panelTabs(), el("div", "dim", "Loading…"));
  if (pending === key) return;
  pending = key;
  void (async () => {
    try {
      const res = await api<{ generation: number; cells: RowCell[] }>(`/api/row?gen=${S.meta!.generation}&row=${cell.rowId}`);
      // Cut values come whole from /api/cell.
      await Promise.all(res.cells.map(async (c, i) => {
        if (!c.cut) return;
        const full = await api<{ value: string }>(`/api/cell?gen=${res.generation}&row=${cell.rowId}&col=${i}`);
        res.cells[i] = { value: full.value };
      }));
      if (pending !== key) return;
      shown = { key, cells: res.cells };
      pending = "";
      // The selection may have moved on while the row came.
      if (S.panel === "row" && cellAt(S.cur)?.rowId === cell.rowId) draw(cell.rowId, res.cells);
    } catch {
      if (pending === key) pending = "";
    }
  })();
}

function draw(rowId: number, cells: RowCell[]) {
  if (!S.meta) return;
  const panel = $("pinpanel");
  const head = el("div", "vb-head");
  head.append(el("span", "", `row ${fmt(rowId + 1)} · ${fmt(S.cur.r + 1)} of ${fmt(S.total)} shown`));
  const list = el("div", "rowkv");
  const hidden = S.meta.columns.map((_, i) => i).filter((i) => !S.fileIdx.includes(i));
  for (const fi of [...S.fileIdx, ...hidden]) {
    const col = S.meta.columns[fi];
    const c = cells[fi];
    const missing = !!c?.null;
    const item = el("div", "rk" + (S.fileIdx.includes(fi) ? "" : " hid") + (fi === S.fileIdx[S.cur.c] ? " sel" : ""));
    item.dataset.column = col.name;
    const k = el("div", "k");
    k.append(el("b", "", col.name), el("span", "typ", TYPE_ABBR[col.type] + (S.fileIdx.includes(fi) ? "" : " · hidden")));
    const f = el("button", "btn-icon") as HTMLButtonElement;
    f.appendChild(icon("filter", 11));
    // JSON values cannot be matched; a missing cell filters to missing ones.
    f.disabled = !missing && col.type === "json";
    f.title = missing ? "Filter to missing cells" : f.disabled ? "JSON values cannot be filtered by" : "Filter by this value";
    f.addEventListener("click", () => setFilter(col.name, missing ? { column: col.name, op: "null" } : { column: col.name, op: "equals", value: c.value }));
    k.appendChild(f);
    const v = el("div", "v" + (missing ? " null" : ""), missing ? `${NULL_MARK} (missing)` : pretty(c?.value ?? "", col.type));
    item.append(k, v);
    list.appendChild(item);
  }
  panel.replaceChildren(panelTabs(), head, list);
}
