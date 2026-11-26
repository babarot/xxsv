// The filter bar above the table, Notion-like: one chip per rule while the
// rules are joined by "and"; with "or" or a group, one chip that holds the
// whole condition and opens the advanced filter.
import { filterText, filtersText } from "./format.ts";
import { bundled, incomplete } from "./filters.ts";
import { icon } from "./icons.ts";
import type { Filter } from "./types.ts";
import { S, filtersChanged } from "./app.ts";
import { addRule, advancedOpen, closeFilterUi, columnMenu, editingRule, openAdvanced, openRuleEditor } from "./filter-ui.ts";
import { $, el } from "./dom.ts";

const close = () => {
  closeFilterUi();
  renderChips();
};

const typeOf = (column: string) => S.meta?.columns.find((c) => c.name === column)?.type;

export function renderChips() {
  const chips = $("chips");
  chips.replaceChildren();
  const filters = S.view.filters;
  chips.hidden = filters.length === 0;
  if (chips.hidden) return;
  chips.appendChild(el("span", "lab", "Filters"));
  if (bundled(filters)) {
    const b = el("button", "fchip bundle" + (advancedOpen() ? " open" : "")) as HTMLButtonElement;
    const text = filtersText(filters, typeOf) || "No complete rules";
    b.append(icon("sliders", 13), el("span", "tx", text), icon("chevron-down", 12));
    b.title = text;
    b.addEventListener("click", () => (advancedOpen() ? close() : openAdvanced()));
    chips.appendChild(b);
  } else {
    for (const f of filters as Filter[]) chips.appendChild(chip(f));
    const add = el("button", "f-add") as HTMLButtonElement;
    add.append(icon("plus", 12), el("span", "", "Filter"));
    add.title = "Add a filter";
    add.addEventListener("click", () => columnMenu(add, addRule));
    chips.appendChild(add);
    const adv = el("button", "f-adv") as HTMLButtonElement;
    adv.append(icon("sliders", 13), el("span", "", "Advanced"));
    adv.title = "Join rules with and / or, and group them";
    adv.addEventListener("click", () => openAdvanced());
    chips.appendChild(adv);
  }
  const clear = el("button", "chip-clear", "Clear all") as HTMLButtonElement;
  clear.addEventListener("click", () => {
    S.view.filters = [];
    closeFilterUi();
    filtersChanged();
  });
  chips.appendChild(clear);
}

// chip shows a rule as Notion does: "対応: 保留, 処理中" for "is", the
// condition written out for the others, only the column while it waits for
// a value.
function chip(f: Filter) {
  const waiting = incomplete(f);
  const b = el("button", "fchip" + (waiting ? " idle" : "") + (editingRule() === f ? " open" : "")) as HTMLButtonElement & { rule?: Filter };
  b.rule = f;
  const [col, cond] = filterText(f, typeOf(f.column));
  const plain = f.op === "in" && !f.not ? (f.values ?? []).map((v) => (v === "" ? "(empty)" : v)).join(", ") : cond;
  const tx = el("span", "tx");
  tx.append(el("b", "", col));
  if (!waiting) tx.append(document.createTextNode(": " + plain));
  b.append(tx, icon("chevron-down", 12));
  b.title = waiting ? `${col}: choose a value` : `${col} ${cond}`;
  b.addEventListener("click", () => (editingRule() === f ? close() : openRuleEditor(f)));
  return b;
}
