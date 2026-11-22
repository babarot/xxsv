import { test } from "node:test";
import assert from "node:assert/strict";
import { first, isSingle, moved, nameBox, range, wholeColumn, wholeRow } from "./selection.ts";

test("range orders the corners", () => {
  assert.deepEqual(range({ r: 5, c: 1 }, { r: 2, c: 3 }), { r0: 2, r1: 5, c0: 1, c1: 3 });
  assert.ok(isSingle(range({ r: 1, c: 1 }, { r: 1, c: 1 })));
});

test("moved stops at the edges", () => {
  assert.deepEqual(moved({ r: 0, c: 0 }, -1, -1, 10, 3), { r: 0, c: 0 });
  assert.deepEqual(moved({ r: 9, c: 2 }, 5, 5, 10, 3), { r: 9, c: 2 });
  assert.deepEqual(moved({ r: 4, c: 1 }, 1, 1, 10, 3), { r: 5, c: 2 });
});

test("first goes to the first row and keeps the column if it still exists", () => {
  assert.deepEqual(first({ r: 7, c: 2 }, 5), { r: 0, c: 2 });
  assert.deepEqual(first({ r: 7, c: 4 }, 2), { r: 0, c: 1 });
  assert.deepEqual(first({ r: 7, c: 4 }, 0), { r: 0, c: 0 });
});

test("wholeColumn and wholeRow span the table", () => {
  assert.deepEqual(wholeColumn(2, 100), [{ r: 0, c: 2 }, { r: 99, c: 2 }]);
  assert.deepEqual(wholeColumn(2, 0), [{ r: 0, c: 2 }, { r: 0, c: 2 }]);
  assert.deepEqual(wholeRow(3, 5), [{ r: 3, c: 0 }, { r: 3, c: 4 }]);
});

test("nameBox names a cell or a range", () => {
  assert.equal(nameBox({ r: 1, c: 1 }, { r: 1, c: 1 }), "B2");
  assert.equal(nameBox({ r: 5, c: 2 }, { r: 1, c: 1 }), "B2:C6");
  assert.equal(nameBox({ r: 0, c: 26 }, { r: 0, c: 26 }), "AA1");
});
