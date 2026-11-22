// The side panel's Values tab: a column's values over the rows the search
// and the filters on other columns keep, most frequent first, with a search
// of its own. A value filters the table to it, switching from the value
// filtered to before; pressed again, the filter goes.
import { NULL_MARK, TYPE_ABBR } from "./constants.ts";
import { fmt } from "./format.ts";
import { S, setFilter } from "./app.ts";
import { api, post } from "./api.ts";
import { panelTabs } from "./cell-popover.ts";
import { $, el } from "./dom.ts";
import { render } from "./grid.ts";
import { showError } from "./status.ts";

interface ValueItem { value: string; count: number; missing?: boolean; cut?: boolean; rowId: number }
interface ValuesResponse { generation: number; distinct: number; rows: number; total: number; items: ValueItem[] }

const PAGE = 200;

let search = "";
let items: ValueItem[] = [];
let info: Omit<ValuesResponse, "items"> | null = null;
let loading = false;
// request moves on whenever the list starts over, so an answer to an older
// request is dropped.
let request = 0;

// openValues shows the values of a column in the side panel.
export function openValues(column: string | null) {
  if (!column) return;
  if (S.valuesCol !== column) search = "";
  S.valuesCol = column;
  S.panel = "values";
  S.expanded = false;
  $("peek").hidden = true;
  render();
  restartValues();
}

// restartValues fetches the list again from the start: the query, the file
// or the column changed. It does nothing unless the tab is open.
export function restartValues() {
  if (S.panel !== "values" || !S.meta) return;
  if (!S.valuesCol || !S.meta.columns.some((c) => c.name === S.valuesCol)) {
    // The column is gone (a reload): close the tab.
    S.panel = null;
    S.valuesCol = null;
    $("pinpanel").hidden = true;
    return;
  }
  request++;
  items = [];
  info = null;
  loading = false;
  draw();
  void loadMore();
}

async function loadMore() {
  if (loading || !S.meta || !S.valuesCol || (info && items.length >= info.total)) return;
  loading = true;
  const mine = request;
  try {
    const res = await api<ValuesResponse>("/api/values", post({
      query: { search: S.view.search, filters: S.view.filters },
      column: S.valuesCol, search, offset: items.length, limit: PAGE,
    }));
    if (mine !== request || res.generation !== S.meta?.generation) return;
    items.push(...res.items);
    info = { generation: res.generation, distinct: res.distinct, rows: res.rows, total: res.total };
    loading = false;
    draw();
  } catch (e) {
    if (mine === request) showError(`values failed: ${(e as Error).message}`);
  } finally {
    if (mine === request) loading = false;
  }
}

// draw keeps the search box (and its focus) and redraws the rest.
function draw() {
  const panel = $("pinpanel");
  if (S.panel !== "values" || !S.meta || !S.valuesCol) return;
  panel.hidden = false;
  let box = panel.querySelector<HTMLInputElement>("input.vals-search");
  let list = panel.querySelector<HTMLElement>(".vals-list");
  let summary = panel.querySelector<HTMLElement>(".vals-summary");
  const col = S.meta.columns.find((c) => c.name === S.valuesCol)!;
  if (!box || panel.dataset.col !== col.name) {
    panel.dataset.col = col.name;
    const head = el("div", "col-title");
    head.append(el("b", "", col.name), el("span", "typ", TYPE_ABBR[col.type]));
    // Another column: the shown ones, and this one if it is hidden.
    const pick = el("select", "vals-col") as HTMLSelectElement;
    pick.title = "Column";
    const names = S.cols.map((c) => c.name);
    if (!names.includes(col.name)) names.push(col.name);
    for (const n of names) {
      const o = el("option", "", n) as HTMLOptionElement;
      o.value = n;
      o.selected = n === col.name;
      pick.appendChild(o);
    }
    pick.addEventListener("change", () => openValues(pick.value));
    head.appendChild(pick);
    summary = el("div", "dim vals-summary");
    box = el("input", "vals-search") as HTMLInputElement;
    box.placeholder = "Search values…";
    box.value = search;
    let timer = 0;
    box.addEventListener("input", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        search = box!.value;
        restartValues();
      }, 200);
    });
    list = el("div", "bars vals-list");
    panel.replaceChildren(panelTabs(), head, summary, box, list);
  }
  summary!.textContent = info
    ? `${fmt(info.distinct)} distinct in ${fmt(info.rows)} rows${S.view.search || S.view.filters.some((f) => f.column !== col.name) ? " (filtered)" : ""}${search ? ` · ${fmt(info.total)} match` : ""}`
    : "Counting…";
  const active = S.view.filters.find((f) => f.column === col.name);
  const max = Math.max(1, ...items.map((i) => i.count));
  list!.replaceChildren();
  for (const it of items) {
    const on = !!active && (it.missing ? active.op === "null" : active.op === "equals" && active.value === it.value);
    const row = el("button", "vals-item" + (on ? " on" : "")) as HTMLButtonElement;
    const label = el("span", it.missing ? "null" : "", it.missing ? `${NULL_MARK} (missing)` : it.value === "" ? "(empty)" : it.value + (it.cut ? "…" : ""));
    const bar = el("em");
    const fill = el("i");
    fill.style.width = (it.count / max) * 100 + "%";
    bar.appendChild(fill);
    const pct = info && info.rows ? ((it.count / info.rows) * 100).toFixed(1) + "%" : "";
    row.append(label, bar, el("b", "", fmt(it.count)), el("small", "pct", pct));
    row.title = on ? "Remove this filter" : it.missing ? "Filter to missing cells" : "Filter by this value";
    row.addEventListener("click", () => void pickValue(col.name, it, on));
    list!.appendChild(row);
  }
  if (info && !items.length) list!.appendChild(el("div", "dim", search ? "No values match." : "No rows."));
}

// pickValue filters the table to a value, fetching the whole of a cut one
// first; on an active value it removes the filter.
async function pickValue(column: string, it: ValueItem, on: boolean) {
  if (on) return setFilter(column, null);
  if (it.missing) return setFilter(column, { column, op: "null" });
  let value = it.value;
  if (it.cut && S.meta) {
    const col = S.meta.columns.findIndex((c) => c.name === column);
    try {
      value = (await api<{ value: string }>(`/api/cell?gen=${S.meta.generation}&row=${it.rowId}&col=${col}`)).value;
    } catch (e) {
      showError(`value failed: ${(e as Error).message}`);
      return;
    }
  }
  setFilter(column, { column, op: "equals", value });
}

// The list grows as it is scrolled near its end.
export function wireValuesPanel() {
  const panel = $("pinpanel");
  panel.addEventListener("scroll", () => {
    if (S.panel === "values" && panel.scrollTop + panel.clientHeight > panel.scrollHeight - 200) void loadMore();
  });
}
