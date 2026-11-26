import { test, expect, open, cell, column, saveAndWait, removeChip } from "./fixtures";

const names = (page: import("@playwright/test").Page) => page.locator("#header .names .nm").allTextContents();

test("hides a column from its popover and shows it again from the column list", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b,c\n1,x,10\n2,y,20\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="1"]').click();
  await page.locator("#colpop").getByRole("button", { name: "Hide column" }).click();
  await expect.poll(() => names(page)).toEqual(["a", "c"]);
  await expect(page.locator("#counts")).toHaveText("2 rows · 2 columns · 1 hidden");
  await expect(cell(page, 0, 1)).toHaveText("10");
  // The link opens the column list; a hidden column comes back at the end.
  await page.locator("#hidden-link").click();
  await expect(page.locator("#colmenu")).toBeVisible();
  await page.locator('#colmenu .cm-item[data-column="b"] input').check();
  await expect.poll(() => names(page)).toEqual(["a", "c", "b"]);
  await expect(page.locator("#counts")).toHaveText("2 rows · 3 columns");
  await page.keyboard.press("Escape");
  await expect(page.locator("#colmenu")).toBeHidden();
});

test("moves a column by dragging it in the column list, and Show all restores the file's order", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b,c\n1,x,10\n2,y,20\n");
  await open(page, xxsv.url);
  await page.locator("#cols-btn").click();
  const item = (n: string) => page.locator(`#colmenu .cm-item[data-column="${n}"]`);
  // Drop c on the top half of a: c goes before it.
  await item("c").dragTo(item("a"), { targetPosition: { x: 40, y: 3 } });
  await expect.poll(() => names(page)).toEqual(["c", "a", "b"]);
  expect(await column(page, 0, 2)).toEqual(["10", "20"]);
  // The view keeps the order: the hash holds it.
  await expect.poll(() => JSON.parse(decodeURIComponent(new URL(page.url()).hash.slice(1) || "{}")).columns).toEqual(["c", "a", "b"]);
  await page.locator("#colmenu").getByRole("button", { name: "Show all" }).click();
  await expect.poll(() => names(page)).toEqual(["a", "b", "c"]);
});

test("keeps the last column shown", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b\n1,x\n");
  await open(page, xxsv.url);
  await page.locator("#cols-btn").click();
  await page.locator('#colmenu .cm-item[data-column="b"] input').uncheck();
  await expect(page.locator('#colmenu .cm-item[data-column="a"] input')).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.locator('[data-prof="0"]').click();
  await expect(page.locator("#colpop").getByRole("button", { name: "Hide column" })).toBeDisabled();
});

test("aggregates and selects in the shown columns, and sorts and filters by a hidden one", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b,c\n1,x,10\n2,y,20\n3,z,30\n");
  const view = { search: "", filters: [{ column: "b", op: "contains", value: "y" }], sorts: [{ column: "a", desc: true }], columns: ["c", "a"], top: 0 };
  await page.goto(xxsv.url + "#" + encodeURIComponent(JSON.stringify(view)));
  await expect(cell(page, 0, 0)).toHaveText("20"); // filtered by the hidden b
  await expect(page.locator("#counts")).toHaveText("1 of 3 rows · 2 columns · 1 hidden");
  await removeChip(page); // drop the filter on the hidden b
  await expect.poll(() => column(page, 0, 3)).toEqual(["30", "20", "10"]); // sorted by a, shown second
  // A range over the first shown column sums c, not the file's first column.
  await cell(page, 0, 0).click();
  await cell(page, 2, 0).click({ modifiers: ["Shift"] });
  await expect(page.locator("#agg")).toContainText("Sum60");
  await cell(page, 0, 1).click();
  await expect(page.locator("#fval .typ")).toHaveText("a · integer");
});

test("a reload keeps hidden columns hidden, drops gone ones and shows new ones at the end", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b,c\n1,x,10\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  await page.locator("#colpop").getByRole("button", { name: "Hide column" }).click(); // hide a
  await page.locator("#cols-btn").click();
  await page.locator('#colmenu .cm-item[data-column="c"]').dragTo(page.locator('#colmenu .cm-item[data-column="b"]'), { targetPosition: { x: 40, y: 3 } });
  await expect.poll(() => names(page)).toEqual(["c", "b"]);
  await page.keyboard.press("Escape");
  await saveAndWait(page, xxsv, "a,c,d\n1,10,new\n"); // b gone, d new
  await expect.poll(() => names(page)).toEqual(["c", "d"]);
  await expect(page.locator("#counts")).toHaveText("1 rows · 2 columns · 1 hidden");
  await expect(cell(page, 0, 1)).toHaveText("new");
});

test("filters the column list when there are many columns", async ({ page, serve }) => {
  const header = Array.from({ length: 15 }, (_, i) => `col${i + 1}`);
  const xxsv = await serve("t.csv", header.join(",") + "\n" + header.map((_, i) => i).join(",") + "\n");
  await open(page, xxsv.url);
  await page.locator("#cols-btn").click();
  await expect(page.locator("#colmenu .cm-item")).toHaveCount(15);
  await page.locator("#colmenu .cm-filter").fill("col1");
  await expect(page.locator("#colmenu .cm-item")).toHaveCount(7); // col1, col10..col15
});
