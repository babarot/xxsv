// Editing the filter, Notion-like: a rule's editor (under its chip, and in
// the distribution popover), the menus of columns and conditions, and the
// advanced filter, which joins rules with "and" or "or" and groups them one
// level deep. Changes apply at once; text waits for a pause in typing, and
// a regular expression for the server's check.
import { abbr, fmt } from "./format.ts";
import {
  bundled, defaultRule, fromRoot, groupConj, groupItems, isGroup, makeGroup, opKey, opsFor, remove, rootOf, rulesOf, withOp,
  type Conj, type OpKey, type Root,
} from "./filters.ts";
import { icon } from "./icons.ts";
import type { ColType, Filter, FilterNode, Group } from "./types.ts";
import { S, filtersChanged } from "./app.ts";
import { renderChips } from "./chips.ts";
import { check } from "./search.ts";
import { $, el } from "./dom.ts";

const typeOf = (column: string): ColType | undefined => S.meta?.columns.find((c) => c.name === column)?.type;

// knownValues are a column's most frequent values with their counts, from
// its stats.
function knownValues(column: string): { value: string; count: number }[] {
  const s = S.allStats.find((x) => x.name === column);
  return s?.top ?? [];
}

// chosen keeps the condition picked for a rule: a range without bounds
// reads as "between", so "≥" picked before a value is typed is kept here.
const chosen = new WeakMap<Filter, OpKey>();
export function uiKey(f: Filter): OpKey {
  const k = chosen.get(f);
  return k && f.op === "range" && (k.replace("!", "") === "eq" || k === "ge" || k === "le" || k.replace("!", "") === "range") ? k : opKey(f);
}

// badRegex keeps text that failed the check when a rule became a regular
// expression: the rule waits without it, and its box shows it with the error.
const badRegex = new WeakMap<Filter, { text: string; msg: string }>();

// setOp changes a rule's condition in place, then runs after. Text carried
// over to a regular expression is checked first.
async function setOp(f: Filter, k: OpKey, after: () => void) {
  assign(f, withOp(f, k, knownValues(f.column).map((v) => v.value)));
  chosen.set(f, k);
  badRegex.delete(f);
  if (f.op === "regex" && f.value) {
    const msg = await check({ filters: [f] });
    if (msg) {
      badRegex.set(f, { text: f.value, msg: msg.replace(/^filter on "[^"]*": /, "") });
      delete f.value;
    }
  }
  after();
}

// assign changes a rule in place to next, so that the views holding it
// (the chip, the editor, the panel) keep pointing at it.
function assign(f: Filter, next: Filter) {
  for (const k of Object.keys(f) as (keyof Filter)[]) delete f[k];
  Object.assign(f, next);
}

// place puts a pop-up under an anchor, inside the page.
function place(pop: HTMLElement, anchor: Element, dy = 6) {
  const app = $("app").getBoundingClientRect();
  const r = anchor.getBoundingClientRect();
  pop.hidden = false;
  const left = Math.min(r.left - app.left, app.width - pop.offsetWidth - 10);
  pop.style.left = Math.max(10, left) + "px";
  pop.style.top = r.bottom - app.top + dy + "px";
}

// ---- menus ----

interface MenuItem { label?: string; hint?: string; icon?: string; danger?: boolean; on?: boolean; sep?: boolean; run?: () => void }
let menuClosed: (() => void) | null = null;
// menuAnchor is what opened the menu: a click on it is not a click outside.
let menuAnchor: Element | null = null;
export const isMenuAnchor = (n: EventTarget) => n === menuAnchor;

// showMenu opens the pop-up menu under an anchor; search adds a box that
// narrows the items. onClose runs when it closes, however it closes.
export function showMenu(anchor: Element, items: MenuItem[], opts: { search?: string; onClose?: () => void } = {}) {
  const prev = dropMenu();
  const m = $("fmenu");
  m.replaceChildren();
  m.style.width = "";
  const item = (it: MenuItem) => {
    if (it.sep) return el("div", "sepl");
    const b = el("button", (it.danger ? "danger" : "") + (it.on ? " on" : "")) as HTMLButtonElement;
    if (it.icon) b.appendChild(icon(it.icon, 13));
    b.appendChild(el("span", "lb", it.label));
    if (it.hint) b.appendChild(el("span", "typ", it.hint));
    b.addEventListener("click", () => {
      closeMenu();
      it.run?.();
    });
    return b;
  };
  if (opts.search !== undefined) {
    const q = el("input", "tx") as HTMLInputElement;
    q.placeholder = opts.search;
    const list = el("div", "mlist");
    const draw = () => list.replaceChildren(...items.filter((it) => it.sep ? !q.value : !it.label || it.label.toLowerCase().includes(q.value.toLowerCase())).map(item));
    q.addEventListener("input", draw);
    q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") list.querySelector<HTMLButtonElement>("button")?.click();
    });
    m.append(q, list);
    draw();
    setTimeout(() => q.focus());
  } else m.append(...items.map(item));
  menuClosed = opts.onClose ?? null;
  menuAnchor = anchor;
  place(m, anchor, 4);
  prev?.(); // after placing: it may draw the anchor's panel again
}

// showPanel opens the menu's pop-up with any content (a list of values).
function showPanel(anchor: Element, content: HTMLElement, width: number, onClose?: () => void) {
  const prev = dropMenu();
  const m = $("fmenu");
  m.replaceChildren(content);
  m.style.width = width + "px";
  menuClosed = onClose ?? null;
  menuAnchor = anchor;
  place(m, anchor, 4);
  prev?.();
}

// dropMenu hides the menu and hands back what was to run on its closing.
function dropMenu() {
  const m = $("fmenu");
  const f = m.hidden ? null : menuClosed;
  m.hidden = true;
  menuClosed = null;
  return f;
}

export function closeMenu() {
  const m = $("fmenu");
  if (m.hidden) return;
  m.hidden = true;
  const f = menuClosed;
  menuClosed = null;
  f?.();
}

// columnMenu lists the columns to filter by.
export function columnMenu(anchor: Element, pick: (column: string) => void, extra: MenuItem[] = []) {
  const items: MenuItem[] = (S.meta?.columns ?? []).map((c) => ({ label: c.name, hint: c.type === "string" ? "str" : c.type === "integer" ? "int" : c.type === "number" ? "num" : c.type, run: () => pick(c.name) }));
  showMenu(anchor, extra.length ? [...items, { sep: true }, ...extra] : items, { search: "Filter by…" });
}

// ---- a rule's editor ----

// opButton shows a rule's condition and opens the menu of the others.
export function opButton(f: Filter, changed: () => void) {
  const ops = opsFor(typeOf(f.column));
  const key = uiKey(f);
  const b = el("button", "op-btn") as HTMLButtonElement;
  b.append(el("span", "", ops.find(([k]) => k === key)?.[1] ?? key), icon("chevron-down", 12));
  b.title = "Condition";
  b.addEventListener("click", () => {
    showMenu(b, ops.map(([k, label]) => ({
      label, on: k === key,
      run: () => {
        if (k === key) return;
        void setOp(f, k, changed);
      },
    })));
  });
  return b;
}

let regexSeq = 0;

// ruleEditor edits a rule's value: the values to pick for "is", one or two
// boxes for numbers and dates, a box for text. commit runs after each
// change that the query takes; focus puts the keyboard in the first box.
export function ruleEditor(f: Filter, commit: () => void, focus = true): HTMLElement {
  const box = el("div", "fed");
  const key = uiKey(f);
  const k = key.replace("!", "");
  const t = typeOf(f.column);
  if (k === "null" || k === "notnull" || k === "invalid") {
    box.appendChild(el("div", "hint", "No value needed."));
    return box;
  }
  if (k === "in") {
    box.appendChild(valueList(f, commit, focus));
    return box;
  }
  const field = (value: string, placeholder: string) => {
    const i = el("input", "tx") as HTMLInputElement;
    i.value = value;
    i.placeholder = placeholder;
    i.spellcheck = false;
    return i;
  };
  // Text waits for a pause in typing; Enter applies at once. One timer for
  // the editor, and none once it is gone (the condition changed), so a late
  // one cannot write old text over the new rule.
  let timer = 0;
  const typed = (i: HTMLInputElement, apply: () => void | Promise<void>) => {
    const run = () => {
      clearTimeout(timer);
      if (box.isConnected) void apply();
    };
    i.addEventListener("input", () => {
      clearTimeout(timer);
      timer = window.setTimeout(run, 300);
    });
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
  };
  const ph = t === "date" ? "YYYY-MM-DD" : t === "datetime" ? "YYYY-MM-DD hh:mm" : "";
  if (k === "range") {
    const row = el("div", "rng");
    const lo = field(f.min ?? "", ("min " + ph).trim());
    const hi = field(f.max ?? "", ("max " + ph).trim());
    const apply = () => {
      const a = lo.value.trim(), b = hi.value.trim();
      if (a) f.min = a; else delete f.min;
      if (b) f.max = b; else delete f.max;
      commit();
    };
    typed(lo, apply);
    typed(hi, apply);
    row.append(lo, el("span", "dim", "–"), hi);
    box.appendChild(row);
    if (focus) setTimeout(() => lo.focus());
    return box;
  }
  if (k === "eq" || k === "ge" || k === "le") {
    const i = field((k === "le" ? f.max : f.min) ?? "", ph || "value");
    typed(i, () => {
      const v = i.value.trim();
      delete f.min;
      delete f.max;
      if (v) {
        if (k !== "le") f.min = v;
        if (k !== "ge") f.max = v;
      }
      commit();
    });
    box.appendChild(i);
    if (focus) setTimeout(() => i.focus());
    return box;
  }
  const regex = k === "regex";
  const bad = regex ? badRegex.get(f) : undefined;
  const i = field(bad?.text ?? f.value ?? "", regex ? "regex (RE2)…" : k === "prefix" ? "starts with…" : k === "suffix" ? "ends with…" : "contains…");
  const err = el("div", "ff-err");
  err.hidden = !bad;
  err.textContent = bad?.msg ?? "";
  typed(i, async () => {
    // A regular expression keeps its spaces; other text is trimmed.
    const v = regex ? i.value : i.value.trim();
    if (v === (f.value ?? "")) return;
    if (regex && v) {
      // The rule alone is checked: it may not be in the filters yet.
      const seq = ++regexSeq;
      const msg = await check({ filters: [{ ...f, value: v }] });
      if (seq !== regexSeq) return;
      err.hidden = !msg;
      err.textContent = msg.replace(/^filter on "[^"]*": /, "");
      if (msg) return;
    }
    err.hidden = true;
    badRegex.delete(f);
    if (v) f.value = v; else delete f.value;
    commit();
  });
  box.append(i, err);
  if (focus) setTimeout(() => i.focus());
  return box;
}

// valueList picks the values of "is" and "is not": the picked ones sit as
// pills in the search box (× or Backspace removes one, as in Notion), and
// under it the column's values, most frequent first, narrowed by the box,
// which also adds a value not listed.
function valueList(f: Filter, commit: () => void, focus: boolean) {
  const wrap = el("div", "vpick");
  const box = el("div", "vbox");
  const q = el("input") as HTMLInputElement;
  q.spellcheck = false;
  q.setAttribute("aria-label", "Search or add a value");
  box.appendChild(q);
  box.addEventListener("click", (e) => { if (e.target === box) q.focus(); });
  const list = el("div", "vlist");
  const not = !!f.not;
  // armed: Backspace in the empty box marked the last pill; the next one
  // removes it.
  let armed = false;
  const label = (v: string) => (v === "" ? "(empty)" : v);
  const set = (values: string[]) => {
    f.values = values;
    armed = false;
    commit();
    draw();
  };
  const draw = () => {
    const picked = f.values ?? [];
    box.querySelectorAll(".vtag").forEach((t) => t.remove());
    picked.forEach((v, i) => {
      const tag = el("span", "vtag" + (not ? " strike" : "") + (armed && i === picked.length - 1 ? " armed" : ""));
      tag.title = label(v);
      const x = el("button") as HTMLButtonElement;
      x.title = `Remove ${label(v)}`;
      x.setAttribute("aria-label", x.title);
      x.appendChild(icon("x", 11));
      x.addEventListener("click", () => {
        set(picked.filter((p) => p !== v));
        q.focus();
      });
      tag.append(el("span", "t", label(v)), x);
      box.insertBefore(tag, q);
    });
    q.placeholder = picked.length ? "" : "Search or add a value…";
    const known = knownValues(f.column);
    const items = [
      ...picked.filter((v) => !known.some((k) => k.value === v)).map((v) => ({ value: v, count: -1 })),
      ...known,
    ];
    const needle = q.value.toLowerCase();
    list.replaceChildren();
    for (const it of items) {
      if (needle && !it.value.toLowerCase().includes(needle)) continue;
      const on = picked.includes(it.value);
      const row = el("label", on ? "on" : "");
      const cb = el("input") as HTMLInputElement;
      cb.type = "checkbox";
      cb.checked = on;
      cb.addEventListener("change", () => set(cb.checked ? [...picked, it.value] : picked.filter((v) => v !== it.value)));
      row.title = `${label(it.value)}${it.count >= 0 ? ` (${fmt(it.count)})` : ""}`;
      row.append(cb, el("span", "lv" + (on && not ? " strike" : ""), label(it.value)), el("span", "n", it.count >= 0 ? abbr(it.count) : ""));
      list.appendChild(row);
    }
    const text = q.value.trim();
    if (text && !items.some((it) => it.value === text)) {
      const add = el("button", "vadd") as HTMLButtonElement;
      add.append(icon("plus", 12), el("span", "", `Add “${text}”`));
      add.addEventListener("click", () => {
        q.value = "";
        set([...picked, text]);
      });
      list.appendChild(add);
    }
    if (!list.childElementCount) list.appendChild(el("div", "hint", "No values."));
  };
  q.addEventListener("input", () => {
    armed = false;
    draw();
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") list.querySelector<HTMLElement>(".vadd, label:not(.on) input")?.click();
    else if (e.key === "Backspace" && q.value === "" && f.values?.length) {
      e.preventDefault();
      if (armed) set(f.values.slice(0, -1));
      else {
        armed = true;
        draw();
      }
    } else if (armed) {
      armed = false;
      draw();
    }
  });
  draw();
  wrap.append(box, list);
  if (focus) setTimeout(() => q.focus());
  return wrap;
}

// ---- the editor under a chip ----

let editing: Filter | null = null;
export const editingRule = () => editing;

// openRuleEditor opens a rule's editor under its chip.
export function openRuleEditor(f: Filter) {
  closeFilterUi();
  editing = f;
  renderChips(); // draws the chip as open (and the rule, if it is new)
  drawRuleEditor();
}

function chipOf(f: Filter) {
  return [...document.querySelectorAll<HTMLElement>("#chips .fchip")].find((c) => (c as HTMLElement & { rule?: Filter }).rule === f);
}

function drawRuleEditor() {
  const f = editing;
  const pop = $("fedit");
  if (!f) {
    pop.hidden = true;
    return;
  }
  pop.replaceChildren();
  const head = el("div", "fe-head");
  head.append(el("span", "cn", f.column), opButton(f, () => {
    filtersChanged();
    drawRuleEditor();
  }), el("span", "sp"));
  const del = el("button", "btn-icon") as HTMLButtonElement;
  del.title = "Delete filter";
  del.setAttribute("aria-label", "Delete filter");
  del.appendChild(icon("trash", 13));
  del.addEventListener("click", () => {
    S.view.filters = remove(S.view.filters, f);
    closeFilterUi();
    filtersChanged();
  });
  head.appendChild(del);
  pop.append(head, ruleEditor(f, () => filtersChanged()));
  const chip = chipOf(f);
  if (chip) place(pop, chip);
}

// addRule adds a rule on a column and opens its editor; when the filters
// need the advanced filter, the rule joins its first level there.
export function addRule(column: string) {
  const f = defaultRule(column, typeOf(column));
  if (bundled(S.view.filters)) {
    const root = rootOf(S.view.filters);
    root.items.push(f);
    S.view.filters = fromRoot(root);
    return openAdvanced();
  }
  S.view.filters = [...S.view.filters, f];
  openRuleEditor(f);
}

// ---- the advanced filter ----

let advanced = false;
export const advancedOpen = () => advanced;

export function openAdvanced() {
  closeFilterUi();
  advanced = true;
  renderChips();
  drawAdvanced();
}

function newRule(): Filter {
  const c = S.meta?.columns.find((x) => x.type !== "json") ?? S.meta?.columns[0];
  return defaultRule(c?.name ?? "", c?.type);
}

function drawAdvanced() {
  const pop = $("fadv");
  if (!advanced) {
    pop.hidden = true;
    return;
  }
  const root = rootOf(S.view.filters);
  // structure applies a change to the shape: the filters are written back
  // from the root and the panel is drawn again.
  const structure = () => {
    S.view.filters = fromRoot(root);
    filtersChanged();
    drawAdvanced();
  };
  pop.replaceChildren();
  pop.appendChild(el("div", "adv-title", "Advanced filter"));
  const body = el("div", "adv-body");
  root.items.forEach((n, i) => body.appendChild(isGroup(n) ? groupRow(root, n, i, structure) : ruleRow(root, n, i, structure, true)));
  if (!root.items.length) body.appendChild(el("div", "hint", "No filter rules. Add one below."));
  pop.appendChild(body);
  const foot = el("div", "adv-foot");
  const add = el("button", "lnk") as HTMLButtonElement;
  add.append(icon("plus", 13), el("span", "", "Add filter rule"), icon("chevron-down", 12));
  add.addEventListener("click", () => showMenu(add, [
    { label: "Add filter rule", icon: "plus", run: () => { root.items.push(newRule()); structure(); } },
    { label: "Add filter group", icon: "group", run: () => { root.items.push(makeGroup(other(root.conj), [newRule()])); structure(); } },
  ]));
  foot.append(add, el("span", "sp"));
  const del = el("button", "lnk danger") as HTMLButtonElement;
  del.append(icon("trash", 13), el("span", "", "Delete filter"));
  del.addEventListener("click", () => {
    S.view.filters = [];
    closeFilterUi();
    filtersChanged();
  });
  foot.appendChild(del);
  pop.appendChild(foot);
  const anchor = document.querySelector("#chips .fchip.bundle, #chips .f-adv") ?? $("chips");
  place(pop, anchor);
}

const other = (c: Conj): Conj => (c === "and" ? "or" : "and");

// connCell is the first column of a row: "Where", then the and/or of its
// level (chosen on the second row, as in Notion), then the same in words.
function connCell(conj: Conj, i: number, setConj: (c: Conj) => void) {
  if (i === 0) return el("div", "cw", "Where");
  if (i > 1) return el("div", "cw", conj === "and" ? "And" : "Or");
  const s = el("select", "cj") as HTMLSelectElement;
  s.title = "Join with and / or";
  for (const c of ["and", "or"] as Conj[]) {
    const o = el("option", "", c === "and" ? "And" : "Or") as HTMLOptionElement;
    o.value = c;
    s.appendChild(o);
  }
  s.value = conj;
  s.addEventListener("change", () => setConj(s.value as Conj));
  return s;
}

// ruleRow is a rule in the panel; a group puts its own first cell in.
function ruleRow(root: Root, f: Filter, i: number, structure: () => void, top: boolean) {
  const row = el("div", "adv-row");
  row.appendChild(connCell(root.conj, i, (c) => { root.conj = c; structure(); }));
  const cols = el("select") as HTMLSelectElement;
  cols.title = "Column";
  for (const c of S.meta?.columns ?? []) {
    const o = el("option", "", c.name) as HTMLOptionElement;
    o.value = c.name;
    cols.appendChild(o);
  }
  cols.value = f.column;
  cols.addEventListener("change", () => {
    assign(f, defaultRule(cols.value, typeOf(cols.value)));
    structure();
  });
  const ops = el("select") as HTMLSelectElement;
  ops.title = "Condition";
  for (const [k, label] of opsFor(typeOf(f.column))) {
    const o = el("option", "", label) as HTMLOptionElement;
    o.value = k;
    ops.appendChild(o);
  }
  ops.value = uiKey(f);
  ops.addEventListener("change", () => void setOp(f, ops.value as OpKey, structure));
  row.append(cols, ops, inlineValue(f));
  const more = el("button", "btn-icon") as HTMLButtonElement;
  more.title = "More";
  more.appendChild(icon("ellipsis", 14));
  more.addEventListener("click", () => {
    const actions: MenuItem[] = [{ label: "Delete rule", icon: "trash", danger: true, run: () => { removeFrom(root, f); structure(); } }];
    if (top) actions.unshift({ label: "Turn into group", icon: "group", run: () => { root.items[root.items.indexOf(f)] = makeGroup(other(root.conj), [f]); structure(); } });
    showMenu(more, actions);
  });
  row.appendChild(more);
  return row;
}

// removeFrom takes a node out of the root, dropping a group left empty.
function removeFrom(root: Root, n: FilterNode) {
  root.items = remove(root.items, n);
}

// inlineValue is a rule's value in its row: the picked values, which open
// the list, or the boxes of the editor.
function inlineValue(f: Filter): HTMLElement {
  const k = uiKey(f).replace("!", "");
  if (k !== "in") return ruleEditor(f, () => filtersChanged(), false);
  const tok = el("button", "tok") as HTMLButtonElement;
  const vs = f.values ?? [];
  if (vs.length) for (const v of vs) tok.appendChild(el("span", "t" + (f.not ? " strike" : ""), v === "" ? "(empty)" : v));
  else tok.appendChild(el("span", "ph", "Select…"));
  // The list changes the rule in place; closing it only draws the panel
  // again (writing the root back would undo changes made meanwhile).
  tok.addEventListener("click", () => showPanel(tok, ruleEditor(f, () => filtersChanged()), 260, () => { if (advanced) drawAdvanced(); }));
  return tok;
}

function groupRow(root: Root, g: Group, i: number, structure: () => void) {
  const row = el("div", "adv-row g");
  row.appendChild(connCell(root.conj, i, (c) => { root.conj = c; structure(); }));
  const box = el("div", "adv-group");
  const items = groupItems(g);
  const setConj = (c: Conj) => {
    const next = makeGroup(c, items);
    root.items[root.items.indexOf(g)] = g.not ? { ...next, not: true } : next;
    structure();
  };
  items.forEach((n, j) => {
    if (isGroup(n)) {
      // Deeper groups come only from a URL; they are shown, not edited.
      const r = el("div", "adv-row");
      r.append(connCell(groupConj(g), j, setConj), el("div", "nested", "Nested group"));
      const del = el("button", "btn-icon") as HTMLButtonElement;
      del.title = "Delete group";
      del.appendChild(icon("trash", 13));
      del.addEventListener("click", () => { removeFrom(root, n); structure(); });
      r.appendChild(del);
      box.appendChild(r);
      return;
    }
    const r = ruleRow(root, n, j, structure, false);
    r.replaceChild(connCell(groupConj(g), j, setConj), r.firstChild!);
    box.appendChild(r);
  });
  const foot = el("div", "gfoot");
  const add = el("button", "lnk") as HTMLButtonElement;
  add.append(icon("plus", 13), el("span", "", "Add filter rule"));
  add.addEventListener("click", () => { items.push(newRule()); structure(); });
  const del = el("button", "lnk danger") as HTMLButtonElement;
  del.append(icon("trash", 13), el("span", "", "Delete group"));
  del.addEventListener("click", () => { removeFrom(root, g); structure(); });
  foot.append(add, del);
  box.appendChild(foot);
  row.appendChild(box);
  return row;
}

// ---- open and close ----

export const filterUiOpen = () => !$("fmenu").hidden || editing !== null || advanced;

// closeTop closes the menu if one is open, else the editor or the panel.
export function closeTop() {
  if (!$("fmenu").hidden) return closeMenu();
  closeFilterUi();
  renderChips();
}

export function closeFilterUi() {
  closeMenu();
  editing = null;
  advanced = false;
  $("fedit").hidden = true;
  $("fadv").hidden = true;
}

// redrawFilterUi draws the open editor or panel again after the filters
// changed elsewhere (a reload of the file drops rules on columns that are
// gone); an editor whose rule is gone closes.
export function redrawFilterUi() {
  if (editing && !rulesOf(S.view.filters).includes(editing)) closeFilterUi();
  if (editing) drawRuleEditor();
  if (advanced) drawAdvanced();
}
