import { test, expect, open, cell, saveAndWait } from "./fixtures";

const items = (page: import("@playwright/test").Page) =>
  page.locator("#pinpanel .vals-item").evaluateAll((els) => els.map((e) => `${e.querySelector("span")!.textContent}:${e.querySelector("b")!.textContent}`));

test("lists a column's values, and filters by one", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "city,n\nOsaka,1\nLima,2\nOsaka,3\n,4\nOslo,5\nOsaka,6\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  await page.locator("#colpop").getByRole("button", { name: "All values" }).click();
  await expect(page.locator("#colpop")).toBeHidden();
  await expect(page.locator('#pinpanel .ptabs [data-panel="values"]')).toHaveClass(/on/);
  await expect(page.locator("#pinpanel .vals-summary")).toHaveText("4 distinct in 6 rows");
  // Most frequent first; equal counts in the order they first appear.
  await expect.poll(() => items(page)).toEqual(["Osaka:3", "Lima:1", "∅ (missing):1", "Oslo:1"]);
  await page.locator("#pinpanel .vals-item").first().click();
  await expect(page.locator("#chips .chip")).toHaveText("city is “Osaka”");
  await expect(page.locator("#counts")).toHaveText("3 of 6 rows · 2 columns");
  // The column's own filter does not narrow its list: the active value is
  // marked, and another one switches to it.
  await expect.poll(() => items(page)).toEqual(["Osaka:3", "Lima:1", "∅ (missing):1", "Oslo:1"]);
  await expect(page.locator("#pinpanel .vals-item.on")).toHaveText(/Osaka/);
  await page.locator("#pinpanel .vals-item", { hasText: "Lima" }).click();
  await expect(page.locator("#chips .chip")).toHaveText("city is “Lima”");
  await expect(page.locator("#counts")).toHaveText("1 of 6 rows · 2 columns");
  await page.locator("#pinpanel .vals-item.on").click(); // pressed again: the filter goes
  await expect(page.locator("#chips")).toBeHidden();
  await page.locator("#pinpanel .vals-item", { hasText: "missing" }).click();
  await expect(page.locator("#counts")).toHaveText("1 of 6 rows · 2 columns");
});

test("searches the values, and counts booleans the way a filter matches them", async ({ page, serve }) => {
  const rows = Array.from({ length: 118 }, (_, i) => ["true", "TRUE", "false"][i % 3]);
  const xxsv = await serve("t.csv", "ok,n\n" + [...rows, "pending", ""].map((v, i) => `${v},${i}`).join("\n") + "\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  await page.locator("#colpop").getByRole("button", { name: "All values" }).click();
  await expect.poll(() => items(page)).toEqual(["true:79", "false:39", "pending:1", "∅ (missing):1"]);
  await page.locator("#pinpanel .vals-item", { hasText: "pending" }).click();
  await expect(page.locator("#counts")).toHaveText("1 of 120 rows · 2 columns");
  await page.locator("#chips .chip .btn-icon").click();
  await page.locator("#pinpanel .vals-search").fill("TRU");
  await expect.poll(() => items(page)).toEqual(["true:79"]);
});

test("counts over the rows the other columns' filters keep", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "city,n\nOsaka,1\nLima,2\nOsaka,3\nOslo,30\n");
  const view = { search: "", filters: [{ column: "n", op: "range", max: "5" }], sorts: [], columns: null, top: 0 };
  await page.goto(xxsv.url + "#" + encodeURIComponent(JSON.stringify(view)));
  await page.locator('[data-prof="0"]').click();
  await page.locator("#colpop").getByRole("button", { name: "All values" }).click();
  await expect(page.locator("#pinpanel .vals-summary")).toHaveText("2 distinct in 3 rows (filtered)");
  await expect.poll(() => items(page)).toEqual(["Osaka:2", "Lima:1"]);
});

test("switches between the cell and the values in the side panel", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b\nx,1\ny,2\n");
  await open(page, xxsv.url);
  await cell(page, 1, 0).click();
  await page.locator('[data-prof="1"]').click();
  await page.locator("#colpop").getByRole("button", { name: "All values" }).click();
  await expect(page.locator("#pinpanel .col-title b")).toHaveText("b");
  await page.locator('#pinpanel [data-panel="cell"]').click();
  await expect(page.locator("#pinpanel .vb-pre")).toHaveText("y");
  await page.locator('#pinpanel [data-panel="values"]').click();
  await expect(page.locator("#pinpanel .col-title b")).toHaveText("b"); // the column chosen before
  await page.locator("#pinpanel select.vals-col").selectOption("a");
  await expect.poll(() => items(page)).toEqual(["x:1", "y:1"]);
  await page.locator('#pinpanel .ptabs .btn-icon').click();
  await expect(page.locator("#pinpanel")).toBeHidden();
});

test("closes the values when a reload removes their column, and recounts otherwise", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b\nx,1\nx,2\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  await page.locator("#colpop").getByRole("button", { name: "All values" }).click();
  await expect.poll(() => items(page)).toEqual(["x:2"]);
  await saveAndWait(page, xxsv, "a,b\nx,1\ny,2\ny,3\n");
  await expect.poll(() => items(page)).toEqual(["y:2", "x:1"]);
  await saveAndWait(page, xxsv, "c,b\nx,1\n");
  await expect(page.locator("#pinpanel")).toBeHidden();
});
