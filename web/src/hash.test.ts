import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyView, formatHash, parseHash } from "./hash.ts";
import type { ViewState } from "./types.ts";

test("parseHash reads what formatHash writes", () => {
  const v: ViewState = { search: "a b&c", filters: [{ column: "q", op: "range", min: "1" }], sort: { column: "q", desc: true }, top: 42 };
  assert.deepEqual(parseHash(formatHash(v).slice(1)), v);
});

test("parseHash gives the empty view for an empty or broken hash", () => {
  assert.deepEqual(parseHash(""), emptyView());
  assert.deepEqual(parseHash("%7Bnot-json"), emptyView());
  assert.deepEqual(parseHash("%E0%A4%A"), emptyView()); // bad percent-encoding
});

test("parseHash fills fields an older or partial hash lacks", () => {
  assert.deepEqual(parseHash(encodeURIComponent('{"search":"x"}')), { search: "x", filters: [], sort: null, top: 0 });
});
