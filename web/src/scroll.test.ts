import { test } from "node:test";
import assert from "node:assert/strict";
import { HEAD_H, MAX_PX, ROW_H } from "./constants.ts";
import { firstRow, rowToReveal, rowsTop, scale, scrollLeftToReveal, scrollTopFor, sizerHeight, visibleRows } from "./scroll.ts";

const view = (scrollTop: number, total: number, clientHeight = 600) => ({
  scrollTop, clientHeight, scrollHeight: sizerHeight(total),
});

test("small tables are not scaled", () => {
  assert.equal(scale(1000), 1);
  assert.equal(sizerHeight(1000), HEAD_H + 1000 * ROW_H);
  assert.equal(firstRow(view(10 * ROW_H, 1000), 1000), 10);
  assert.equal(scrollTopFor(10, view(0, 1000), 1000), 10 * ROW_H);
  assert.equal(rowsTop(10, view(10 * ROW_H, 1000), 1000), HEAD_H + 10 * ROW_H);
});

test("large tables are scaled to MAX_PX and map the scroll position by fraction", () => {
  const total = 1_000_000;
  assert.ok(scale(total) < 1);
  assert.equal(Math.round(sizerHeight(total)), HEAD_H + MAX_PX);
  const v = view(0, total);
  const maxScroll = v.scrollHeight - v.clientHeight;
  assert.equal(firstRow({ ...v, scrollTop: 0 }, total), 0);
  // The bottom shows the last rows.
  assert.equal(firstRow({ ...v, scrollTop: maxScroll }, total), total - visibleRows(v.clientHeight) + 1);
  // scrollTopFor and firstRow agree.
  for (const row of [1, 12_345, 500_000, 999_000]) {
    assert.equal(firstRow({ ...v, scrollTop: scrollTopFor(row, v, total) }, total), row);
  }
  // Rows are drawn at the top of the view.
  assert.equal(rowsTop(500_000, { ...v, scrollTop: 1234 }, total), 1234 + HEAD_H);
});

test("scrollTopFor clamps the row", () => {
  assert.equal(scrollTopFor(-5, view(0, 100), 100), 0);
  assert.equal(scrollTopFor(500, view(0, 100), 100), 99 * ROW_H);
});

test("rowToReveal scrolls only when the row is out of view", () => {
  const v = view(100 * ROW_H, 1000); // rows 100.. in view
  const shown = visibleRows(v.clientHeight) - 2;
  assert.equal(rowToReveal(105, v, 1000), null);
  assert.equal(rowToReveal(99, v, 1000), 99);
  assert.equal(rowToReveal(100 + shown, v, 1000), 100 + 1);
});

test("scrollLeftToReveal keeps columns clear of the stuck row numbers", () => {
  const widths = [100, 100, 100, 100];
  assert.equal(scrollLeftToReveal(1, widths, 50, 0, 300), null); // 150..250 fits in 0..300
  assert.equal(scrollLeftToReveal(3, widths, 50, 0, 300), 50 + 400 - 300);
  assert.equal(scrollLeftToReveal(0, widths, 50, 120, 300), 0);
});
