// The Export menu: writes the current view (search, filters, sort keys and
// shown columns, every matching row) as CSV, TSV or JSONL. The server
// checks the view and returns a token; the download then comes straight
// from the server, so a large file never sits in the page's memory.
import { fmt } from "./format.ts";
import { S, currentQuery } from "./app.ts";
import { api, post } from "./api.ts";
import { $, el } from "./dom.ts";
import { showError } from "./status.ts";

let open = false;

export const exportMenuOpen = () => open;

export function toggleExportMenu(on = !open) {
  open = on;
  $("export-btn").classList.toggle("on", on);
  renderExportMenu();
}

export function renderExportMenu() {
  const menu = $("expmenu");
  if (!open || !S.meta) {
    menu.hidden = true;
    return;
  }
  menu.replaceChildren();
  const head = el("div", "cm-head");
  head.appendChild(el("b", "", "Export"));
  menu.appendChild(head);
  menu.appendChild(el("div", "dim", `${fmt(S.total)} rows × ${fmt(S.cols.length)} columns, as filtered, sorted and shown`));
  const formats = el("div", "exp-formats");
  for (const [format, label] of [["csv", "CSV"], ["tsv", "TSV"], ["jsonl", "JSONL"]]) {
    const b = el("button", "btn-ghost", label) as HTMLButtonElement;
    b.dataset.format = format;
    b.addEventListener("click", () => void download(format));
    formats.appendChild(b);
  }
  menu.appendChild(formats);
  menu.hidden = false;
  const r = $("export-btn").getBoundingClientRect();
  menu.style.top = r.bottom + 6 + "px";
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
}

async function download(format: string) {
  toggleExportMenu(false);
  try {
    const { token } = await api<{ token: string }>("/api/export", post({ format, query: currentQuery() }));
    const a = document.createElement("a");
    a.href = `/api/export/${token}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    showError(`export failed: ${(e as Error).message}`);
  }
}
