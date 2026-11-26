import { test } from "node:test";
import assert from "node:assert/strict";
import { bundled, dropColumns, fromRoot, inGroup, liveFilters, normalize, opKey, remove, replaceColumn, rootOf, topRules, withOp } from "./filters.ts";
import type { Filter, FilterNode } from "./types.ts";

const a: Filter = { column: "a", op: "in", values: ["x"] };
const b: Filter = { column: "b", op: "range", min: "4" };
const c: Filter = { column: "c", op: "contains", value: "z" };

test("rootOf and fromRoot read one or group as a root with or", () => {
  assert.deepEqual(rootOf([a, b]), { conj: "and", items: [a, b] });
  assert.deepEqual(rootOf([{ or: [a, b] }]), { conj: "or", items: [a, b] });
  assert.deepEqual(rootOf([{ or: [a, b] }, c]).conj, "and");
  assert.deepEqual(fromRoot({ conj: "or", items: [a, b] }), [{ or: [a, b] }]);
  assert.deepEqual(fromRoot({ conj: "or", items: [] }), []);
  assert.deepEqual(fromRoot({ conj: "and", items: [a] }), [a]);
});

test("liveFilters leaves out incomplete rules and empty groups", () => {
  const empty: Filter = { column: "a", op: "in", values: [] };
  assert.deepEqual(liveFilters([empty, a, { or: [{ column: "b", op: "range" }] }]), [a]);
  assert.deepEqual(liveFilters([{ or: [empty, b] }]), [{ or: [b] }]);
  assert.deepEqual(liveFilters([{ column: "a", op: "null" }]), [{ column: "a", op: "null" }]);
});

test("the column helpers look at rules directly in the filters, or in groups", () => {
  const fs: FilterNode[] = [a, { or: [b, c] }];
  assert.equal(bundled(fs), true);
  assert.equal(bundled([a, b]), false);
  assert.deepEqual(topRules(fs, "a"), [a]);
  assert.deepEqual(topRules(fs, "b"), []);
  assert.equal(inGroup(fs, "b"), true);
  assert.equal(inGroup(fs, "a"), false);
});

test("replaceColumn keeps the place of the column's rule", () => {
  assert.deepEqual(replaceColumn([a, b, c], "b", { column: "b", op: "null" }), [a, { column: "b", op: "null" }, c]);
  assert.deepEqual(replaceColumn([a, b], "c", c), [a, b, c]);
  assert.deepEqual(replaceColumn([a, b], "a", null), [b]);
  const g = { or: [{ column: "a", op: "null" as const }] };
  assert.deepEqual(replaceColumn([g, a], "a", null), [g]);
});

test("remove and dropColumns drop groups left empty", () => {
  assert.deepEqual(remove([a, { or: [b] }], b), [a]);
  assert.deepEqual(remove([{ or: [b, c] }], b), [{ or: [c] }]);
  assert.deepEqual(dropColumns([a, { or: [b, c] }], new Set(["a", "c"])), [a, { or: [c] }]);
  assert.deepEqual(dropColumns([{ or: [b] }], new Set(["a"])), []);
});

test("normalize reads equals as in, and drops what is neither a rule nor a group", () => {
  assert.deepEqual(normalize([{ column: "a", op: "equals", value: "x" }, 3, null, { or: [{ column: "b", op: "equals", value: "" }] }]), [
    { column: "a", op: "in", values: ["x"] },
    { or: [{ column: "b", op: "in", values: [""] }] },
  ]);
  assert.deepEqual(normalize("nope"), []);
});

test("opKey names range rules by their bounds", () => {
  assert.equal(opKey({ column: "n", op: "range", min: "1" }), "ge");
  assert.equal(opKey({ column: "n", op: "range", max: "1" }), "le");
  assert.equal(opKey({ column: "n", op: "range", min: "1", max: "1" }), "eq");
  assert.equal(opKey({ column: "n", op: "range", min: "1", max: "1", not: true }), "!eq");
  assert.equal(opKey({ column: "n", op: "range", min: "1", max: "2" }), "range");
  assert.equal(opKey({ column: "n", op: "range", min: "1", not: true }), "!range");
  assert.equal(opKey({ column: "s", op: "in", values: [], not: true }), "!in");
});

test("withOp keeps what carries over to the new condition", () => {
  assert.deepEqual(withOp(a, "!in"), { column: "a", op: "in", not: true, values: ["x"] });
  assert.deepEqual(withOp(a, "contains"), { column: "a", op: "contains", value: "x" });
  assert.deepEqual(withOp(c, "in", ["z", "w"]), { column: "c", op: "in", values: ["z"] });
  assert.deepEqual(withOp(c, "in", ["w"]), { column: "c", op: "in", values: [] });
  assert.deepEqual(withOp(b, "le"), { column: "b", op: "range", max: "4" });
  assert.deepEqual(withOp(b, "eq"), { column: "b", op: "range", min: "4", max: "4" });
  assert.deepEqual(withOp({ column: "b", op: "range", min: "1", max: "2" }, "!range"), { column: "b", op: "range", not: true, min: "1", max: "2" });
  assert.deepEqual(withOp(a, "null"), { column: "a", op: "null" });
});
