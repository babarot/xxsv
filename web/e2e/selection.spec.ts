import { test, expect, open, cell, csv } from "./fixtures";

test("selects cells, ranges, columns and rows, and aggregates the range", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b,s\n1,10,x\n2,20,y\n3,30,z\n4,,w\n");
  await open(page, xxsv.url);
  await expect(page.locator("#namebox")).toHaveText("A1");
  await cell(page, 1, 1).click();
  await expect(page.locator("#namebox")).toHaveText("B2");
  await expect(page.locator("#fval .v")).toHaveText("20");
  await expect(page.locator("#agg")).toBeEmpty(); // one cell: no aggregate
  // Shift-click extends the range: B2:B4 holds 20, 30 and a missing cell.
  await cell(page, 3, 1).click({ modifiers: ["Shift"] });
  await expect(page.locator("#namebox")).toHaveText("B2:B4");
  await expect(page.locator("#agg")).toContainText("Count2");
  await expect(page.locator("#agg")).toContainText("Sum50");
  await expect(page.locator("#agg")).toContainText("Avg25");
  await expect(cell(page, 2, 1)).toHaveClass(/inr/);
  // A column letter selects the whole column.
  await page.locator('[data-col="0"]').click();
  await expect(page.locator("#namebox")).toHaveText("A1:A4");
  await expect(page.locator("#agg")).toContainText("Sum10");
  await expect(page.locator('[data-col="0"]')).toHaveClass(/hl/);
  // A row number selects the whole row; text cells count but do not sum.
  await page.locator('.rh[data-row="0"]').click();
  await expect(page.locator("#namebox")).toHaveText("A1:C1");
  await expect(page.locator("#agg")).toContainText("Count3");
  await expect(page.locator("#agg")).toContainText("Sum11");
});

test("moves with the arrow keys, stops at the edges and extends with Shift", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(5));
  await open(page, xxsv.url);
  await cell(page, 0, 0).click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#namebox")).toHaveText("A1");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#namebox")).toHaveText("B2");
  await expect(cell(page, 1, 1)).toHaveClass(/cur/);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator("#namebox")).toHaveText("B2:C3");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowDown");
  await expect(page.locator("#namebox")).toHaveText("C5");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await expect(page.locator("#namebox")).toHaveText("E5");
});

test("moves past the loaded rows with the keyboard and shows the value when it arrives", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(2000));
  await open(page, xxsv.url);
  await cell(page, 0, 1).click();
  // Arrow keys scroll the selection into view one row at a time.
  for (let i = 0; i < 250; i++) await page.keyboard.press("ArrowDown");
  await expect(page.locator("#namebox")).toHaveText("B251");
  await expect(page.locator("#fval .v")).toHaveText("item251");
});

test("focuses the search with /", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(5));
  await open(page, xxsv.url);
  await cell(page, 0, 0).click();
  await page.keyboard.press("/");
  await expect(page.locator("#search")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#search")).not.toBeFocused();
});

test("changing the query resets the selection to the first cell but keeps the column", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(30));
  await open(page, xxsv.url);
  await cell(page, 5, 2).click();
  await page.locator('[data-sort="price"]').click();
  await expect(page.locator("#namebox")).toHaveText("C1");
  await expect(cell(page, 0, 2)).toHaveClass(/cur/);
});
