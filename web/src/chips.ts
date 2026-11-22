// The filter chips above the table.
import { filterText } from "./format.ts";
import { icon } from "./icons.ts";
import { S, resetRows, setFilter } from "./app.ts";
import { renderColPop } from "./col-popover.ts";
import { $, el } from "./dom.ts";

export function renderChips() {
  const chips = $("chips");
  chips.replaceChildren();
  chips.hidden = S.view.filters.length === 0;
  if (chips.hidden) return;
  chips.appendChild(el("span", "lab", "Filters"));
  for (const f of S.view.filters) {
    const [col, rest] = filterText(f, S.meta?.columns.find((c) => c.name === f.column)?.type);
    const chip = el("span", "chip");
    chip.append(el("b", "", col), document.createTextNode(" " + rest));
    const x = el("button", "btn-icon") as HTMLButtonElement;
    x.appendChild(icon("x", 11));
    x.title = "Remove filter";
    x.setAttribute("aria-label", "Remove filter");
    x.addEventListener("click", () => setFilter(f.column, null));
    chip.appendChild(x);
    chips.appendChild(chip);
  }
  if (S.view.filters.length > 1) {
    const clear = el("button", "chip-clear", "Clear all") as HTMLButtonElement;
    clear.addEventListener("click", () => {
      S.view.filters = [];
      S.view.top = 0;
      renderChips();
      resetRows();
      if (S.colPop !== null) renderColPop();
    });
    chips.appendChild(clear);
  }
}
