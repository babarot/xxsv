import { test } from "node:test";
import assert from "node:assert/strict";
import { abbr, binLabel, changeSummary, colLetter, edgeLabel, estimateWidth, filterText, groupDigits, pretty, viewSentence } from "./format.ts";
import type { Changes, Meta, Stats } from "./types.ts";

test("groupDigits groups integers in their text, exact past 2^53", () => {
  assert.equal(groupDigits("1234567"), "1,234,567");
  assert.equal(groupDigits("999"), "999");
  assert.equal(groupDigits("-1000"), "-1,000");
  assert.equal(groupDigits("+12345"), "+12,345");
  assert.equal(groupDigits("9007199254740993"), "9,007,199,254,740,993");
  assert.equal(groupDigits("007"), "007");
  assert.equal(groupDigits("12.5"), "12.5");
  assert.equal(groupDigits("abc"), "abc");
  assert.equal(groupDigits(""), "");
});

test("colLetter names columns like a spreadsheet", () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52, 701, 702].map(colLetter), ["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
});

test("abbr shortens counts", () => {
  assert.deepEqual([0, 999, 1000, 1234, 56789, 1_500_000, 2e9].map(abbr), ["0", "999", "1.0k", "1.2k", "57k", "1.5M", "2.0B"]);
});

const stats = (type: Stats["type"]): Stats => ({ name: "x", type, count: 1, nulls: 0, invalid: 0, unique: 1, uniqueApprox: false });

test("edgeLabel writes dates for date columns and short numbers otherwise", () => {
  const day = Date.UTC(2024, 2, 18, 20, 56);
  assert.equal(edgeLabel(stats("date"), day), "2024-03-18");
  assert.equal(edgeLabel(stats("datetime"), day), "2024-03-18 20:56");
  assert.equal(edgeLabel({ ...stats("datetime"), utc: true }, day), "2024-03-18 20:56Z");
  assert.equal(edgeLabel(stats("number"), 30.6386), "30.6");
  assert.equal(edgeLabel(stats("number"), 1234.56), "1,235");
  assert.equal(edgeLabel(stats("number"), 0.000123456), "0.0001"); // 4 fraction digits at most
});

test("pretty indents JSON and leaves the rest", () => {
  assert.equal(pretty('{"a":[1]}', "json"), '{\n  "a": [\n    1\n  ]\n}');
  assert.equal(pretty("{not json", "json"), "{not json");
  assert.equal(pretty('{"a":1}', "string"), '{"a":1}');
});

test("filterText describes each kind of filter", () => {
  assert.deepEqual(filterText({ column: "q", op: "range", min: "1" }), ["q", "1 – …"]);
  assert.deepEqual(filterText({ column: "q", op: "null" }), ["q", "is missing"]);
  assert.deepEqual(filterText({ column: "q", op: "notnull" }), ["q", "is not missing"]);
  assert.deepEqual(filterText({ column: "q", op: "equals", value: "a" }), ["q", "is “a”"]);
  assert.deepEqual(filterText({ column: "q", op: "contains", value: "b" }), ["q", "contains “b”"]);
  assert.deepEqual(filterText({ column: "q", op: "invalid" }, "integer"), ["q", "is not a number"]);
  assert.deepEqual(filterText({ column: "q", op: "invalid" }, "datetime"), ["q", "is not a date"]);
  assert.deepEqual(filterText({ column: "q", op: "invalid" }, "boolean"), ["q", "is not true/false"]);
});

const changes = (c: Partial<Changes>): Changes => ({
  from: 1, changedRows: 0, changedCells: 0, addedRows: 0, removedRows: 0, addedColumns: [], removedColumns: [], tooMany: false, ...c,
});

test("changeSummary says what a reload changed", () => {
  assert.equal(changeSummary(changes({})), "no changes");
  assert.equal(changeSummary(changes({ changedRows: 3, addedRows: 2, removedRows: 1 })), "3 changed, 2 added, 1 removed");
  assert.equal(changeSummary(changes({ addedRows: 1500 })), "1,500 added");
  assert.equal(changeSummary(changes({ addedColumns: ["a"], removedColumns: ["b", "c"] })), "1 column added, 2 columns removed");
  assert.equal(changeSummary(changes({ tooMany: true, addedColumns: ["a"] })), "too many changes to show, 1 column added");
});

test("viewSentence describes the view", () => {
  const meta = { rows: 1000, columns: [{ name: "q", type: "integer" }] } as Meta;
  assert.equal(viewSentence(meta, 1000, { search: "", filters: [], sort: null, top: 0 }), "1,000 of 1,000 rows.");
  assert.equal(
    viewSentence(meta, 12, { search: "ab", filters: [{ column: "q", op: "range", min: "1", max: "2" }], sort: { column: "q", desc: true }, top: 0 }),
    "12 of 1,000 rows, matching “ab”, where q 1 – 2, sorted by q descending.",
  );
});

test("estimateWidth stays between 90 and 340 pixels", () => {
  assert.equal(estimateWidth({ name: "", type: "boolean" }), 90);
  assert.equal(estimateWidth({ name: "x".repeat(100), type: "string" }), 340);
  const w = estimateWidth({ name: "id", type: "integer" }, ["123456789"]);
  assert.ok(w > 90 && w < 340);
});

test("binLabel names the whole values of a discrete bin", () => {
  const n = stats("integer");
  assert.equal(binLabel(n, { bins: [1, 2, 3], counts: [5, 5], discrete: true }, 0), "1");
  assert.equal(binLabel(n, { bins: [0, 10, 20], counts: [5, 5], discrete: true }, 1), "10 – 19");
  assert.equal(binLabel(n, { bins: [0, 2.5, 5], counts: [5, 5] }, 1), "2.5 – 5");
  const d = stats("date");
  const day = 86_400_000, jan1 = Date.UTC(2024, 0, 1);
  assert.equal(binLabel(d, { bins: [jan1, jan1 + day], counts: [1], discrete: true }, 0), "2024-01-01");
  assert.equal(binLabel(d, { bins: [jan1, jan1 + 7 * day], counts: [1], discrete: true }, 0), "2024-01-01 – 2024-01-07");
});
