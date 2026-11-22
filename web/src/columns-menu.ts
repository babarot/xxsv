// The column list under the Columns button: check a column to show it, drag
// a shown one to move it. It acts at once, so the table behind it follows.
import { TYPE_ABBR } from "./constants.ts";
import { icon } from "./icons.ts";
import { S, showColumns } from "./app.ts";
import { $, el } from "./dom.ts";

// A filter box for the names shows above this many columns.
export const FILTER_FROM = 12;

let open = false;
let filter = "";
let dragged: string | null = null;

export const columnsMenuOpen = () => open;

export function toggleColumnsMenu(on = !open) {
  open = on;
  if (!on) filter = "";
  $("cols-btn").classList.toggle("on", on);
  renderColumnsMenu();
  if (on) $("colmenu").querySelector<HTMLInputElement>("input.cm-filter")?.focus();
}

const shownNames = () => S.cols.map((c) => c.name);

// moveColumn puts the dragged column before or after a shown one.
function moveColumn(name: string, target: string, after: boolean) {
  if (name === target) return;
  const names = shownNames().filter((n) => n !== name);
  names.splice(names.indexOf(target) + (after ? 1 : 0), 0, name);
  showColumns(names);
}

export function renderColumnsMenu() {
  const menu = $("colmenu");
  if (!open || !S.meta) {
    menu.hidden = true;
    return;
  }
  menu.replaceChildren();
  const head = el("div", "cm-head");
  head.append(el("b", "", "Columns"), el("span", "dim", `${S.cols.length} of ${S.meta.columns.length} shown`));
  menu.appendChild(head);
  if (S.meta.columns.length > FILTER_FROM) {
    const f = el("input", "cm-filter") as HTMLInputElement;
    f.placeholder = "Filter columns…";
    f.value = filter;
    f.addEventListener("input", () => {
      filter = f.value;
      renderList(list);
    });
    menu.appendChild(f);
  }
  const list = el("div", "cm-list");
  renderList(list);
  menu.appendChild(list);
  const all = el("button", "btn-ghost", "Show all") as HTMLButtonElement;
  all.disabled = S.view.columns === null;
  all.addEventListener("click", () => {
    showColumns(null);
    renderColumnsMenu();
  });
  menu.appendChild(all);
  menu.hidden = false;
  const b = $("cols-btn").getBoundingClientRect();
  menu.style.top = b.bottom + 6 + "px";
  menu.style.left = Math.max(8, Math.min(b.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
  menu.style.maxHeight = window.innerHeight - b.bottom - 20 + "px";
}

// renderList lists the shown columns in their order, then the hidden ones
// in file order.
function renderList(list: HTMLElement) {
  if (!S.meta) return;
  const shown = shownNames();
  const hidden = S.meta.columns.map((c) => c.name).filter((n) => !shown.includes(n));
  const type = new Map(S.meta.columns.map((c) => [c.name, c.type]));
  const q = filter.toLowerCase();
  list.replaceChildren();
  for (const name of [...shown, ...hidden]) {
    if (q && !name.toLowerCase().includes(q)) continue;
    const on = shown.includes(name);
    const item = el("label", "cm-item" + (on ? "" : " off"));
    item.dataset.column = name;
    const grip = el("span", "cm-grip");
    if (on) {
      grip.appendChild(icon("grip", 13));
      grip.title = "Drag to move";
      item.draggable = true;
    }
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = on;
    // At least one column stays shown.
    box.disabled = on && shown.length === 1;
    box.addEventListener("change", () => {
      showColumns(box.checked ? [...shownNames(), name] : shownNames().filter((n) => n !== name));
      renderColumnsMenu();
    });
    item.append(grip, box, el("span", "cm-name", name), el("span", "typ", TYPE_ABBR[type.get(name)!]));
    item.addEventListener("dragstart", (e) => {
      dragged = name;
      e.dataTransfer?.setData("text/plain", name);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => (dragged = null));
    if (on) {
      const after = (e: DragEvent) => e.offsetY > item.offsetHeight / 2;
      item.addEventListener("dragover", (e) => {
        if (!dragged) return;
        e.preventDefault();
        item.classList.toggle("drop-before", !after(e));
        item.classList.toggle("drop-after", after(e));
      });
      item.addEventListener("dragleave", () => item.classList.remove("drop-before", "drop-after"));
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        item.classList.remove("drop-before", "drop-after");
        if (dragged) moveColumn(dragged, name, after(e));
        dragged = null;
        renderColumnsMenu();
      });
    }
    list.appendChild(item);
  }
  if (!list.childElementCount) list.appendChild(el("div", "dim", "No columns match."));
}
