// The top bar's file and counts, and the status bar at the bottom.
import { changeSummary, fmt } from "./format.ts";
import { S } from "./app.ts";
import { $, el } from "./dom.ts";

export function renderTop() {
  if (!S.meta) return;
  $("file").textContent = S.meta.file;
  $("format").textContent = S.meta.format;
  document.title = `${S.meta.file} · xxsv`;
}

export function renderCounts() {
  if (!S.meta) return;
  const filtered = S.view.search !== "" || S.view.filters.length > 0;
  $("counts").textContent = filtered
    ? `${fmt(S.total)} of ${fmt(S.meta.rows)} rows · ${S.meta.columns.length} columns`
    : `${fmt(S.meta.rows)} rows · ${S.meta.columns.length} columns`;
}

export function setBusy(on: boolean) {
  document.querySelector("#watch .dot")?.classList.toggle("busy", on);
}

export function renderStatus() {
  if (!S.meta) return;
  $("watch-file").textContent = `watching ${S.meta.file}`;
  const summary = S.flash.seen && S.meta.changes ? ` · ${changeSummary(S.meta.changes)}` : "";
  $("gen").textContent = `generation ${S.meta.generation} · loaded ${new Date(S.meta.loadedAt).toLocaleTimeString()}${summary}`;
  const notices = $("notices");
  notices.replaceChildren();
  const add = (text: string, title: string) => {
    const s = el("span", "", text);
    s.title = title;
    notices.appendChild(s);
  };
  if (S.meta.headerGenerated) add("no header row", "Columns are named col1, col2, … (run with --header to read the first row as names)");
  if (S.meta.raggedRows) add(`${fmt(S.meta.raggedRows)} ragged rows`, "Rows with a different number of fields than the header");
  if (S.meta.skippedLines) add(`${fmt(S.meta.skippedLines)} lines skipped`, "Lines that were not JSON objects");
  if (S.meta.foldedKeys) add(`${fmt(S.meta.foldedKeys)} keys folded`, 'Rare keys kept together in the "(other keys)" column');
  showError(S.meta.error ? `reload failed: ${S.meta.error} (showing the last good version)` : "");
}

export function showError(msg: string) {
  const e = $("error");
  e.hidden = !msg;
  e.textContent = msg;
  e.title = msg;
}
