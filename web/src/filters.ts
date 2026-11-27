// The filter of the view: a list of rules and groups that all must keep a
// row (view.filters, as the server reads it). The UI shows it as a root with
// "and" or "or" between its items, and groups one level under it, like
// Notion's advanced filter; a root with "or" is kept as one "or" group.
import type { ColType, Filter, FilterNode, Group } from "./types.ts";

export type Conj = "and" | "or";

export const isGroup = (n: FilterNode): n is Group => !("column" in n);
export const groupConj = (g: Group): Conj => (g.or ? "or" : "and");
export const groupItems = (g: Group): FilterNode[] => g.or ?? g.and ?? [];
export const makeGroup = (conj: Conj, items: FilterNode[]): Group => (conj === "or" ? { or: items } : { and: items });

export interface Root { conj: Conj; items: FilterNode[] }

// rootOf reads the filters as a root: one "or" group is a root with "or".
export function rootOf(filters: FilterNode[]): Root {
  const g = filters[0];
  if (filters.length === 1 && isGroup(g) && g.or && !g.not) return { conj: "or", items: g.or };
  return { conj: "and", items: filters };
}

// fromRoot writes a root back as filters.
export function fromRoot(root: Root): FilterNode[] {
  if (root.conj === "and" || root.items.length === 0) return root.items;
  return [{ or: root.items }];
}

// rulesOf lists the rules in the nodes, groups included.
export const rulesOf = (nodes: FilterNode[]): Filter[] => nodes.flatMap((n) => (isGroup(n) ? rulesOf(groupItems(n)) : [n]));

// bundled reports whether the filters need the advanced filter to show:
// any "or", or a group. Rules joined by "and" show as chips.
export const bundled = (filters: FilterNode[]) => filters.some(isGroup);

const base = (f: Filter) => f.op;

// incomplete reports a rule without the value its op needs, such as a new
// one; it is shown but left out of the query, as Notion does.
export function incomplete(f: Filter): boolean {
  switch (base(f)) {
    case "null": case "notnull": case "invalid": return false;
    case "in": return !f.values?.length;
    case "range": return !f.min && !f.max;
    default: return !f.value;
  }
}

// liveFilters drops the incomplete rules and the groups left empty: what
// the server is sent.
export function liveFilters(nodes: FilterNode[]): FilterNode[] {
  const out: FilterNode[] = [];
  for (const n of nodes) {
    if (!isGroup(n)) {
      if (!incomplete(n)) out.push(n);
      continue;
    }
    const items = liveFilters(groupItems(n));
    if (items.length) out.push({ ...makeGroup(groupConj(n), items), ...(n.not ? { not: true } : {}) });
  }
  return out;
}

// topRules are the rules on a column directly in the filters (joined by
// "and"), not those in groups.
export const topRules = (filters: FilterNode[], column: string) =>
  filters.filter((n): n is Filter => !isGroup(n) && n.column === column);

// inGroup reports whether a group holds a rule on the column.
export const inGroup = (filters: FilterNode[], column: string) =>
  filters.some((n) => isGroup(n) && rulesOf([n]).some((f) => f.column === column));

// filtered reports whether a complete rule filters the column.
export const filtered = (filters: FilterNode[], column: string) =>
  rulesOf(filters).some((f) => f.column === column && !incomplete(f));

// replaceColumn replaces the rules directly on a column with f (none for
// null), where the first of them was; rules on it in groups stay.
export function replaceColumn(filters: FilterNode[], column: string, f: Filter | null): FilterNode[] {
  const at = filters.findIndex((n) => !isGroup(n) && n.column === column);
  const rest = filters.filter((n) => isGroup(n) || n.column !== column);
  if (!f) return rest;
  if (at < 0) return [...rest, f];
  const before = filters.slice(0, at).filter((n) => isGroup(n) || n.column !== column).length;
  return [...rest.slice(0, before), f, ...rest.slice(before)];
}

// remove takes a node out wherever it is, dropping groups left empty.
export function remove(nodes: FilterNode[], target: FilterNode): FilterNode[] {
  const out: FilterNode[] = [];
  for (const n of nodes) {
    if (n === target) continue;
    if (!isGroup(n)) {
      out.push(n);
      continue;
    }
    const items = remove(groupItems(n), target);
    if (items.length) {
      const g = makeGroup(groupConj(n), items);
      if (n.not) g.not = true;
      out.push(g);
    }
  }
  return out;
}

// facetFilters are the filters a rule's values are counted over: all but
// the rule. Under "or" or a negated group, the rule's neighbours do not
// narrow the rows it can match, so the top-level node holding it goes too.
export function facetFilters(nodes: FilterNode[], f: Filter): FilterNode[] {
  const narrows = (n: FilterNode): boolean => n === f || (isGroup(n) && !n.not && !n.or && groupItems(n).some(narrows));
  const out: FilterNode[] = [];
  for (const n of nodes) {
    if (n === f) continue;
    if (!rulesOf([n]).includes(f)) out.push(n);
    else if (narrows(n)) out.push(...remove([n], f));
  }
  return out;
}

// dropColumns drops the rules on columns the file no longer has.
export function dropColumns(nodes: FilterNode[], names: Set<string>): FilterNode[] {
  const out: FilterNode[] = [];
  for (const n of nodes) {
    if (!isGroup(n)) {
      if (names.has(n.column)) out.push(n);
      continue;
    }
    const items = dropColumns(groupItems(n), names);
    if (items.length) out.push({ ...makeGroup(groupConj(n), items), ...(n.not ? { not: true } : {}) });
  }
  return out;
}

// normalize reads filters from a URL: "equals" becomes "in" with one value,
// the form the UI edits; anything not a rule or group is dropped.
export function normalize(nodes: unknown): FilterNode[] {
  if (!Array.isArray(nodes)) return [];
  const out: FilterNode[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if ("column" in n) {
      const f = { ...(n as Filter) };
      if (f.op === "equals") {
        f.op = "in";
        f.values = [f.value ?? ""];
        delete f.value;
      }
      out.push(f);
    } else if ("or" in n || "and" in n) {
      const g = n as Group;
      const conj = g.or ? "or" : "and";
      const ng = makeGroup(conj, normalize(conj === "or" ? g.or : g.and));
      if (g.not) ng.not = true;
      out.push(ng);
    }
  }
  return out;
}

// The conditions the UI offers. A key is an op, with "!" in front for not;
// numbers and dates have Notion's comparisons, all kept as "range".
export type OpKey = string;
export const TEXT_OPS: [OpKey, string][] = [
  ["in", "is"], ["!in", "is not"],
  ["contains", "contains"], ["!contains", "does not contain"],
  ["prefix", "starts with"], ["suffix", "ends with"],
  ["regex", "matches regex"], ["!regex", "does not match regex"],
  ["null", "is empty"], ["notnull", "is not empty"],
];
export const RANGE_OPS: [OpKey, string][] = [
  ["eq", "="], ["!eq", "≠"], ["ge", "≥"], ["le", "≤"],
  ["range", "between"], ["!range", "not between"],
  ["null", "is empty"], ["notnull", "is not empty"],
];

export const isRangeType = (t?: ColType) => t === "integer" || t === "number" || t === "date" || t === "datetime";
export const opsFor = (t?: ColType) => (isRangeType(t) ? RANGE_OPS : TEXT_OPS);

// opKey names a rule's condition. A range with one bound is "≥" or "≤",
// with equal bounds "=". Invalid cells have no entry in the menus.
export function opKey(f: Filter): OpKey {
  const not = f.not ? "!" : "";
  if (f.op === "equals") return not + "in";
  if (f.op !== "range") return f.op === "null" || f.op === "notnull" || f.op === "invalid" ? f.op : not + f.op;
  if (f.min && f.min === f.max) return not + "eq";
  if (f.not) return "!range";
  if (f.min && !f.max) return "ge";
  if (f.max && !f.min) return "le";
  return "range";
}

// withOp changes a rule's condition, keeping what carries over: a picked
// value becomes the text and back, a bound stays a bound.
export function withOp(f: Filter, key: OpKey, known: string[] = []): Filter {
  const not = key.startsWith("!");
  const k = not ? key.slice(1) : key;
  const first = f.op === "in" || f.op === "equals" ? f.values?.[0] ?? f.value ?? "" : f.op === "range" ? f.min || f.max || "" : f.value ?? "";
  const out: Filter = { column: f.column, op: "contains" };
  if (not) out.not = true;
  switch (k) {
    case "null": case "notnull": case "invalid":
      out.op = k;
      delete out.not;
      break;
    case "in":
      out.op = "in";
      out.values = f.op === "in" ? [...(f.values ?? [])] : first && (known.length === 0 || known.includes(first)) ? [first] : [];
      break;
    case "eq": out.op = "range"; out.min = out.max = first; break;
    case "ge": out.op = "range"; out.min = first; break;
    case "le": out.op = "range"; out.max = first; break;
    case "range": out.op = "range"; out.min = f.op === "range" ? f.min : first; out.max = f.op === "range" && f.max !== f.min ? f.max : ""; break;
    default: out.op = k as Filter["op"]; out.value = first;
  }
  for (const key of ["value", "min", "max"] as const) if (out[key] === "") delete out[key];
  return out;
}

// defaultRule is a new rule on a column: "is" for text, "between" for
// numbers and dates, "contains" for JSON, whose values cannot be listed.
export function defaultRule(column: string, t?: ColType): Filter {
  if (isRangeType(t)) return { column, op: "range" };
  if (t === "json") return { column, op: "contains" };
  return { column, op: "in", values: [] };
}
