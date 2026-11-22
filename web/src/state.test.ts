import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMeta, applyStats, fitWidths, flashElapsed, newQuery, newState, rowsShown } from "./state.ts";
import type { Meta, Stats } from "./types.ts";

const meta = (generation: number, columns = ["a", "b", "c"]): Meta => ({
  version: "", generation, file: "t.csv", format: "csv", headerGenerated: false,
  columns: columns.map((name) => ({ name, type: "string" })), rows: 10,
  raggedRows: 0, skippedLines: 0, foldedKeys: 0, loadedAt: "",
});

test("newQuery moves the epoch on, resets the selection and keeps panels and the glow", () => {
  const s = newState();
  applyMeta(s, meta(1));
  s.cur = { r: 7, c: 2 };
  s.anchor = { r: 9, c: 0 };
  s.expanded = true;
  s.pinned = true;
  s.colPop = 1;
  s.fullValue = { key: "k", value: "v" };
  s.flash = { at: 5, pending: false, seen: true };
  const e = s.epoch;
  newQuery(s);
  assert.equal(s.epoch, e + 1);
  assert.deepEqual(s.cur, { r: 0, c: 2 });
  assert.deepEqual(s.anchor, { r: 0, c: 2 });
  assert.equal(s.expanded, false);
  assert.equal(s.fullValue, null);
  assert.equal(s.pinned, true);
  assert.equal(s.colPop, 1);
  assert.deepEqual(s.flash, { at: 5, pending: false, seen: true });
});

test("the first meta does not glow", () => {
  const s = newState();
  const { columnsChanged } = applyMeta(s, meta(1));
  assert.equal(columnsChanged, true);
  assert.deepEqual(s.flash, { at: null, pending: false, seen: false });
  assert.equal(s.widths.length, 3);
});

test("a new generation stops the glow and waits for the new rows", () => {
  const s = newState();
  applyMeta(s, meta(1));
  s.flash = { at: 100, pending: false, seen: true };
  s.colPop = 0;
  s.pinned = true;
  const e = s.epoch;
  const { columnsChanged } = applyMeta(s, meta(2));
  assert.equal(columnsChanged, false);
  assert.equal(s.epoch, e + 1);
  assert.deepEqual(s.flash, { at: null, pending: true, seen: true });
  assert.equal(s.colPop, 0); // same columns: the popover stays
  assert.equal(s.pinned, true);
  rowsShown(s, 500);
  assert.deepEqual(s.flash, { at: 500, pending: false, seen: true });
  assert.equal(flashElapsed(s, 800), 300);
  rowsShown(s, 900); // later blocks do not restart it
  assert.equal(flashElapsed(s, 900), 400);
});

test("the same generation again leaves the glow alone but still starts the rows over", () => {
  const s = newState();
  applyMeta(s, meta(2));
  s.flash = { at: 100, pending: false, seen: true };
  const e = s.epoch;
  applyMeta(s, meta(2));
  assert.deepEqual(s.flash, { at: 100, pending: false, seen: true });
  assert.equal(s.epoch, e + 1);
});

test("changed columns close the distribution popover and drop filters and the sort on missing columns", () => {
  const s = newState({ search: "", filters: [{ column: "b", op: "contains", value: "x" }, { column: "a", op: "null" }], sort: { column: "b" }, top: 5 });
  applyMeta(s, meta(1));
  s.colPop = 2;
  s.cur = { r: 3, c: 2 };
  const { columnsChanged } = applyMeta(s, meta(2, ["a", "z"]));
  assert.equal(columnsChanged, true);
  assert.equal(s.colPop, null);
  assert.deepEqual(s.view.filters, [{ column: "a", op: "null" }]);
  assert.equal(s.view.sort, null);
  assert.equal(s.view.top, 5); // the scroll position stays
  assert.deepEqual(s.cur, { r: 0, c: 1 }); // the column is kept within the new columns
  assert.equal(s.widths.length, 2);
});

test("flashElapsed is Infinity when nothing glows", () => {
  assert.equal(flashElapsed(newState(), 1000), Infinity);
});

test("the widths wait for the first rows after the columns changed, and then stay", () => {
  const s = newState();
  applyMeta(s, meta(1));
  assert.equal(s.widthsPending, true);
  assert.equal(fitWidths(s, [["x".repeat(30), "", ""]]), true);
  const w = s.widths;
  assert.ok(w[0] > w[1]);
  assert.equal(fitWidths(s, [["", "x".repeat(30), ""]]), false); // later rows leave them
  applyMeta(s, meta(2)); // same columns
  assert.equal(s.widthsPending, false);
  assert.deepEqual(s.widths, w);
});

test("stats are taken for the meta's generation only, and dropped with the columns", () => {
  const s = newState();
  applyMeta(s, meta(2));
  const st: Stats[] = [{ name: "a", type: "string", count: 1, nulls: 0, invalid: 0, unique: 1, uniqueApprox: false }];
  assert.equal(applyStats(s, 1, st), false);
  assert.deepEqual(s.stats, []);
  assert.equal(applyStats(s, 2, st), true);
  applyMeta(s, meta(3)); // same columns: the stats stay until the new ones come
  assert.equal(s.stats, st);
  applyMeta(s, meta(4, ["a", "z"]));
  assert.deepEqual(s.stats, []);
});
