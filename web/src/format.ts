// Text for the page: numbers, column letters, labels and sentences. Nothing
// here touches the DOM.
import { TYPE_ABBR } from "./constants.ts";
import type { Changes, Column, ColType, Filter, Hist, Meta, Stats, ViewState } from "./types.ts";

export const isNum = (t: ColType) => t === "integer" || t === "number";
export const isRange = (t: ColType) => isNum(t) || t === "date" || t === "datetime";

export const fmt = (n: number) => n.toLocaleString();

// abbr shortens a count: 1234 -> 1.2k, 56789 -> 57k.
export const abbr = (n: number) => {
  if (n < 1000) return String(n);
  const u = ["k", "M", "B"];
  let i = -1;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return n.toFixed(n < 10 ? 1 : 0) + u[i];
};

// groupDigits puts commas in an integer's text, 1234567 -> 1,234,567,
// without turning it into a number (integers past 2^53 stay exact). Text
// that is not a plain integer is returned as it is.
export const groupDigits = (s: string) => {
  const m = /^([+-]?)(\d+)$/.exec(s.trim());
  return m ? m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") : s;
};

export const round = (n: number) =>
  Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 });

// colLetter names columns like a spreadsheet: A..Z, AA..AZ, BA..
export const colLetter = (i: number) => {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

// edgeLabel writes a histogram bin edge: a date for date columns, a time
// for datetime columns (with Z when the column is shown in UTC), else a
// number cut to three significant digits (bin edges are computed values,
// 30.6386..., which read better short on an axis).
export function edgeLabel(s: Stats, v: number) {
  if (s.type === "date" || s.type === "datetime") {
    const iso = new Date(v).toISOString();
    return s.type === "date" ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ") + (s.utc ? "Z" : "");
  }
  return round(Math.abs(v) >= 100 ? Math.round(v) : Number(v.toPrecision(3)));
}

// pretty indents JSON values for reading.
export function pretty(v: string, t: ColType) {
  if (t !== "json") return v;
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

// step is the unit of a discrete histogram of a column: a day for dates.
export const histStep = (t: ColType) => (t === "date" ? 86_400_000 : 1);

// binLabel writes bin i of a histogram: "a – b", or for a discrete one the
// whole values it holds, "3" or "3 – 5".
export function binLabel(s: Stats, h: Hist, i: number) {
  const a = h.bins[i];
  if (!h.discrete) return `${edgeLabel(s, a)} – ${edgeLabel(s, h.bins[i + 1])}`;
  const b = h.bins[i + 1] - histStep(s.type);
  return b === a ? edgeLabel(s, a) : `${edgeLabel(s, a)} – ${edgeLabel(s, b)}`;
}

// invalidText names the invalid cells of a column type.
export const invalidText = (t: ColType | undefined) =>
  isNum(t ?? "string") ? "not a number" : t === "date" || t === "datetime" ? "not a date" : t === "boolean" ? "not true/false" : "invalid";

// filterText describes a filter as [column, condition]; type is the
// column's, for naming invalid cells.
export function filterText(f: Filter, type?: ColType): [string, string] {
  switch (f.op) {
    case "invalid": return [f.column, `is ${invalidText(type)}`];
    case "range": return [f.column, `${f.min ?? "…"} – ${f.max ?? "…"}`];
    case "null": return [f.column, "is missing"];
    case "notnull": return [f.column, "is not missing"];
    case "equals": return [f.column, `is “${f.value ?? ""}”`];
    default: return [f.column, `contains “${f.value ?? ""}”`];
  }
}

// changeSummary says what the last reload changed, such as
// "3 changed, 2 added, 1 removed".
export function changeSummary(c: Changes): string {
  const parts: string[] = [];
  const cols = (n: number, what: string) => `${fmt(n)} column${n === 1 ? "" : "s"} ${what}`;
  if (c.tooMany) parts.push("too many changes to show");
  else {
    if (c.changedRows) parts.push(`${fmt(c.changedRows)} changed`);
    if (c.addedRows) parts.push(`${fmt(c.addedRows)} added`);
    if (c.removedRows) parts.push(`${fmt(c.removedRows)} removed`);
  }
  if (c.addedColumns.length) parts.push(cols(c.addedColumns.length, "added"));
  if (c.removedColumns.length) parts.push(cols(c.removedColumns.length, "removed"));
  return parts.length ? parts.join(", ") : "no changes";
}

// viewSentence describes the current view for the settings panel.
export function viewSentence(meta: Meta, total: number, view: ViewState) {
  const parts: string[] = [];
  parts.push(`${fmt(total)} of ${fmt(meta.rows)} rows`);
  if (view.search) parts.push(`matching “${view.search}”`);
  const typeOf = (name: string) => meta.columns.find((c) => c.name === name)?.type;
  if (view.filters.length) parts.push("where " + view.filters.map((f) => filterText(f, typeOf(f.column)).join(" ")).join(" and "));
  if (view.sorts.length) parts.push("sorted by " + view.sorts.map((k) => `${k.column} ${k.desc ? "descending" : "ascending"}`).join(", then "));
  return parts.join(", ") + ".";
}

// estimateWidth picks a column's width in pixels from its name, type and a
// sample of its values (the first rows shown), between 90 and 340.
export function estimateWidth(c: Column, values: string[] = []): number {
  let chars = c.name.length + TYPE_ABBR[c.type].length + 5;
  const longest = Math.max(0, ...values.map((v) => v.length));
  if (isNum(c.type)) chars = Math.max(chars, longest + 3, 8);
  else if (c.type === "date") chars = Math.max(chars, 11);
  else if (c.type === "datetime") chars = Math.max(chars, 18);
  else if (c.type === "boolean") chars = Math.max(chars, 6);
  else if (c.type === "json") chars = Math.max(chars, 12);
  else chars = Math.max(chars, Math.min(longest, 34), 12);
  return Math.max(90, Math.min(340, chars * 7.2 + 22));
}

// rownumWidth fits the largest row number.
export const rownumWidth = (rows: number) => Math.max(52, fmt(rows).length * 7 + 20);
