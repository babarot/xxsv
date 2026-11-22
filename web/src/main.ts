// xxsv UI: a spreadsheet-like, virtual-scrolling table over the server's
// paging API. This file starts the page and wires the events; the rest is in
// modules (app.ts for the state changes, grid.ts for the table, ...).
//
// The server holds the data; the page asks for the rows it shows, in blocks.
// The view state (search, filters, sort, scroll position) lives in the URL
// hash, so it survives both a file reload and a browser reload. Colors come
// from the theme (themes/*.css); the code only names tokens.

import { writeHashNow } from "./hash.ts";
import { hydrateIcons } from "./icons.ts";
import { wholeColumn, wholeRow } from "./selection.ts";
import { S, cycleSort, moveBy, refresh, resetRows, select, toggleColPop, toggleMissing } from "./app.ts";
import { columnsMenuOpen, renderColumnsMenu, toggleColumnsMenu } from "./columns-menu.ts";
import { exportMenuOpen, renderExportMenu, toggleExportMenu } from "./export-menu.ts";
import { wireValuesPanel } from "./values-panel.ts";
import { filterBySelected, renderSelectionInfo } from "./cell-popover.ts";
import { $, copyText } from "./dom.ts";
import { grid, isLong, scheduleRender } from "./grid.ts";
import { renderHeader } from "./header.ts";
import { histScale, numGroup, toggleSettings, wireChoices } from "./settings.ts";
import { connect } from "./live.ts";
import { showError } from "./status.ts";

function setup() {
  hydrateIcons();
  S.histScale = histScale();
  S.numGroup = numGroup();
  const search = $<HTMLInputElement>("search");
  search.value = S.view.search;
  let timer = 0;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      S.view.search = search.value;
      S.view.top = 0;
      resetRows();
    }, 250);
  });

  const g = grid();
  // A Shift-press in the table extends the range or adds a sort key; the
  // browser would also extend its text selection over the header's labels
  // and the formula bar, so that is stopped.
  g.addEventListener("mousedown", (e) => {
    if (e.shiftKey) e.preventDefault();
  });
  g.addEventListener("click", (e) => {
    if (!S.meta) return;
    const t = e.target as HTMLElement;
    if (t.closest(".xmark")) {
      S.expanded = true;
      renderSelectionInfo();
      return;
    }
    const lt = t.closest<HTMLElement>("[data-col]");
    if (lt) {
      [S.cur, S.anchor] = wholeColumn(Number(lt.dataset.col), S.total);
      select(S.cur, true);
      return;
    }
    const nm = t.closest<HTMLElement>("[data-sort]");
    if (nm) return cycleSort(nm.dataset.sort!, e.shiftKey);
    // The hatched missing part of a distribution filters to missing cells.
    const miss = t.closest<HTMLElement>("[data-missing]");
    if (miss) return toggleMissing(S.cols[Number(miss.dataset.missing)].name);
    const pf = t.closest<HTMLElement>("[data-prof]");
    if (pf) return toggleColPop(Number(pf.dataset.prof));
    const rh = t.closest<HTMLElement>(".rh[data-row]");
    if (rh) {
      [S.cur, S.anchor] = wholeRow(Number(rh.dataset.row), S.cols.length);
      select(S.cur, true);
      return;
    }
    const cell = t.closest<HTMLElement>("[data-r]");
    if (!cell) return;
    select({ r: Number(cell.dataset.r), c: Number(cell.dataset.c) }, e.shiftKey);
    // A double-click opens the cell popover. The first click rebuilt the
    // rows, so the second lands on a new element and no dblclick event
    // fires; the click's detail still counts it.
    if (e.detail === 2 && !e.shiftKey && isLong(S.cur)) {
      S.expanded = true;
      renderSelectionInfo();
    }
  });
  g.addEventListener("scroll", scheduleRender, { passive: true });
  window.addEventListener("resize", scheduleRender);
  // A click outside the distribution popover closes it. The event's path is
  // taken at dispatch: a click on a filter button re-renders the popover and
  // detaches the target before this runs.
  document.addEventListener("click", (e) => {
    const path = e.composedPath();
    const inside = path.some((n) => n instanceof HTMLElement && (n.id === "colpop" || n.dataset?.prof !== undefined));
    if (S.colPop !== null && !inside) {
      S.colPop = null;
      $("colpop").hidden = true;
      renderHeader();
    }
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
    if (e.key === "Escape") {
      if (!$("settings").hidden) toggleSettings(false);
      else if (columnsMenuOpen()) toggleColumnsMenu(false);
      else if (exportMenuOpen()) toggleExportMenu(false);
      else if (typing) (t as HTMLElement).blur();
      else if (S.colPop !== null) toggleColPop(S.colPop);
      else if (S.expanded) { S.expanded = false; renderSelectionInfo(); }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || !$("settings").hidden) return;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (e.key === "/") {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (e.key in moves) {
      e.preventDefault();
      moveBy(...moves[e.key], e.shiftKey);
    } else if (e.key === " ") {
      e.preventDefault();
      if (isLong(S.cur) && S.panel !== "cell") {
        S.expanded = !S.expanded;
        renderSelectionInfo();
      }
    }
  });

  $("fbar-filter").addEventListener("click", filterBySelected);
  $("cols-btn").addEventListener("click", () => toggleColumnsMenu());
  $("export-btn").addEventListener("click", () => toggleExportMenu());
  wireValuesPanel();
  // The "N hidden" link next to the counts opens the column list too.
  $("counts").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("#hidden-link")) toggleColumnsMenu(true);
  });
  // A press outside a menu closes it.
  document.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (columnsMenuOpen() && !t.closest("#colmenu, #cols-btn, #hidden-link")) toggleColumnsMenu(false);
    if (exportMenuOpen() && !t.closest("#expmenu, #export-btn")) toggleExportMenu(false);
  });
  window.addEventListener("resize", () => {
    renderColumnsMenu();
    renderExportMenu();
  });
  $("settings-btn").addEventListener("click", () => toggleSettings());
  $("settings-close").addEventListener("click", () => toggleSettings(false));
  $("settings").addEventListener("click", (e) => { if (e.target === e.currentTarget) toggleSettings(false); });
  $("copy-link").addEventListener("click", (e) => {
    writeHashNow(S.view);
    void copyText(location.href, e.currentTarget as HTMLElement);
  });
  wireChoices();
}


setup();
void refresh();
connect({
  generation: () => S.meta?.generation,
  reload: () => void refresh(),
  error: (message) => showError(`reload failed: ${message} (showing the last good version)`),
});
