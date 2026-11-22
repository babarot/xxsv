// The table header: column letters, names with sort and filter marks, and the distribution row.
import { NULL_MARK, TYPE_ABBR } from "./constants.ts";
import { abbr, colLetter, isNum } from "./format.ts";
import { icon } from "./icons.ts";
import { S, selRange } from "./app.ts";
import { histogram, missingColumn, topSegments } from "./charts.ts";
import { $, el } from "./dom.ts";

export function gridTemplate() {
  const cols = S.widths.map((w, i) => (i === S.widths.length - 1 ? `minmax(${w}px, 1fr)` : `${w}px`));
  return `${S.rownumW}px ${cols.join(" ")}`;
}

export function renderHeader() {
  if (!S.meta) return;
  const header = $("header");
  const template = gridTemplate();
  const min = S.rownumW + S.widths.reduce((a, b) => a + b, 0) + "px";
  const { c0, c1 } = selRange();
  const mk = (cls: string) => {
    const row = el("div", "row " + cls);
    row.style.gridTemplateColumns = template;
    row.style.minWidth = min;
    row.appendChild(el("div", "corner"));
    return row;
  };
  const letters = mk("letters");
  const names = mk("names");
  const profile = mk("profile");
  S.meta.columns.forEach((c, i) => {
    const lt = el("div", i >= c0 && i <= c1 ? "hl" : "", colLetter(i));
    lt.dataset.col = String(i);
    lt.title = `Select column ${colLetter(i)}`;
    letters.appendChild(lt);

    const nm = el("div", isNum(c.type) ? "num" : "");
    nm.dataset.sort = c.name;
    nm.title = `${c.name} (${c.type}): click to sort`;
    nm.appendChild(el("span", "nm", c.name));
    if (S.view.sort?.column === c.name) {
      const a = el("span", "arrow");
      a.appendChild(icon(S.view.sort.desc ? "arrow-down" : "arrow-up", 12));
      nm.appendChild(a);
    }
    if (S.view.filters.some((f) => f.column === c.name)) {
      const f = el("span", "fmark");
      f.appendChild(icon("filter", 11));
      nm.appendChild(f);
    }
    nm.appendChild(el("span", "typ", TYPE_ABBR[c.type]));
    names.appendChild(nm);

    const pf = el("div", S.colPop === i ? "open" : "");
    pf.dataset.prof = String(i);
    pf.title = "Distribution and filters";
    const s = S.stats[i];
    const h = s && histogram(s, S.histScale, 100, 21);
    const miss = s && missingColumn(s, i);
    if (h && miss) {
      const wrap = el("div", "hist");
      wrap.append(h, miss);
      pf.appendChild(wrap);
    } else if (h) pf.appendChild(h);
    else if (s?.top?.length) {
      pf.appendChild(el("div", "cap", `${abbr(s.unique)}${s.uniqueApprox ? "+" : ""} unique${s.nulls ? ` · ${abbr(s.nulls)} ${NULL_MARK}` : ""}`));
      pf.appendChild(topSegments(s, i));
    } else if (s) pf.appendChild(el("div", "cap", c.type === "json" ? `json${s.nulls ? ` · ${abbr(s.nulls)} ${NULL_MARK}` : ""}` : "no values"));
    profile.appendChild(pf);
  });
  header.replaceChildren(letters, names, profile);
  $("rows").style.minWidth = min;
  $("rows").style.width = "100%";
}
