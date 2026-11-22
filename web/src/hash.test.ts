import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyView, formatHash, parseHash } from "./hash.ts";
import type { ViewState } from "./types.ts";

test("parseHash reads what formatHash writes", () => {
  const v: ViewState = { search: "a b&c", regex: true, filters: [{ column: "q", op: "range", min: "1" }], sorts: [{ column: "q", desc: true }, { column: "r" }], columns: ["r", "q"], top: 42 };
  assert.deepEqual(parseHash(formatHash(v).slice(1)), v);
});

test("parseHash gives the empty view for an empty or broken hash", () => {
  assert.deepEqual(parseHash(""), emptyView());
  assert.deepEqual(parseHash("%7Bnot-json"), emptyView());
  assert.deepEqual(parseHash("%E0%A4%A"), emptyView()); // bad percent-encoding
});

test("parseHash fills fields an older or partial hash lacks", () => {
  assert.deepEqual(parseHash(encodeURIComponent('{"search":"x"}')), { search: "x", regex: false, filters: [], sorts: [], columns: null, top: 0 });
});

test("parseHash reads the one sort of a hash from before sort keys", () => {
  const old = encodeURIComponent('{"search":"","filters":[],"sort":{"column":"q","desc":true},"top":0}');
  assert.deepEqual(parseHash(old).sorts, [{ column: "q", desc: true }]);
  assert.deepEqual(parseHash(encodeURIComponent('{"sort":null}')).sorts, []);
});
