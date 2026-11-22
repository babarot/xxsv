import { test, expect, open, cell, column, csv, holdResponses } from "./fixtures";

test("drops an aggregate that arrives after the range changed", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(20));
  await open(page, xxsv.url);
  const agg = await holdResponses(page, "**/api/aggregate");
  agg.start();
  await cell(page, 0, 2).click();
  await cell(page, 4, 2).click({ modifiers: ["Shift"] });
  await agg.waitFor(1);
  await cell(page, 1, 1).click(); // one cell: no aggregate
  agg.releaseAll();
  await page.waitForTimeout(500);
  await expect(page.locator("#agg")).toBeEmpty();
});

test("drops an aggregate that arrives after the query changed", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(20));
  await open(page, xxsv.url);
  const agg = await holdResponses(page, "**/api/aggregate");
  agg.start();
  await page.locator('[data-col="2"]').click();
  await agg.waitFor(1);
  await page.locator('[data-sort="qty"]').click();
  agg.releaseAll();
  await page.waitForTimeout(500);
  await expect(page.locator("#agg")).toBeEmpty();
});

test("drops a full cell value that arrives after the query changed", async ({ page, serve }) => {
  const long = "y".repeat(600);
  const xxsv = await serve("t.csv", `id,text\n1,${long}\n2,short\n`);
  await open(page, xxsv.url);
  const full = await holdResponses(page, "**/api/cell*");
  full.start();
  await cell(page, 0, 1).click();
  await full.waitFor(1);
  await page.locator("#search").fill("short");
  await expect(page.locator("#counts")).toHaveText("1 of 2 rows · 2 columns");
  full.releaseAll();
  await page.waitForTimeout(500);
  await expect(page.locator("#fval .v")).toHaveText("short");
});

test("drops rows that arrive after the query changed", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(20));
  await open(page, xxsv.url);
  const rows = await holdResponses(page, "**/api/rows");
  rows.start();
  await page.locator('[data-sort="qty"]').click(); // ascending, held
  await rows.waitFor(1);
  rows.stop();
  await page.locator('[data-sort="qty"]').click(); // descending, passes
  await expect(page.locator('[data-sort="qty"] .arrow')).toBeVisible();
  const desc = (await column(page, 2, 20)).map(Number);
  expect(desc).toEqual([...desc].sort((a, b) => b - a));
  rows.releaseAll();
  await page.waitForTimeout(500);
  expect((await column(page, 2, 20)).map(Number)).toEqual(desc);
});

test("clears the old cell's value and popover as soon as the query changes", async ({ page, serve }) => {
  const long = "z".repeat(600);
  const xxsv = await serve("t.csv", `id,text\n1,${long}\n2,short\n`);
  await open(page, xxsv.url);
  await cell(page, 0, 1).click();
  await page.keyboard.press(" ");
  await expect(page.locator("#peek")).toBeVisible();
  const rows = await holdResponses(page, "**/api/rows");
  rows.start();
  await page.locator('[data-sort="id"]').click();
  await rows.waitFor(1);
  await expect(page.locator("#peek")).toBeHidden();
  await expect(page.locator("#fval")).toBeEmpty();
  rows.releaseAll();
});
