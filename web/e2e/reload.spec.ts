import { test, expect, open, cell, column, csv, saveAndWait, generation } from "./fixtures";

test("keeps the sort, filters, search and scroll position across a reload, and resets the selection", async ({ page, serve }) => {
  // The search and the filter both narrow the rows, so losing either one
  // changes the count; the sort is checked on the data.
  const text = csv(3000);
  const matching = (t: string) => t.trimEnd().split("\n").slice(1).map((l) => l.split(",")).filter((r) => r[1].includes("item1") && Number(r[2]) >= 50).length;
  const xxsv = await serve("t.csv", text);
  const view = { search: "item1", filters: [{ column: "qty", op: "range", min: "50" }], sort: { column: "qty" }, top: 0 };
  await open(page, xxsv.url + "#" + encodeURIComponent(JSON.stringify(view)));
  const n = matching(text);
  await expect(page.locator("#counts")).toHaveText(`${n.toLocaleString("en-US")} of 3,000 rows · 5 columns`);
  await page.locator("#grid").evaluate((g) => (g.scrollTop = 100 * 26));
  await expect.poll(() => page.locator("#rows .rh").first().getAttribute("data-row")).toBe("100");
  await cell(page, 105, 1).click();
  const after = text + "3001,item1new,99,1.00,2024-01-01\n";
  await saveAndWait(page, xxsv, after);
  expect(matching(after)).toBe(n + 1);
  await expect(page.locator("#counts")).toHaveText(`${(n + 1).toLocaleString("en-US")} of 3,001 rows · 5 columns`);
  await expect(page.locator("#search")).toHaveValue("item1");
  await expect(page.locator("#chips .chip")).toHaveCount(1);
  await expect.poll(() => page.locator("#rows .rh").first().getAttribute("data-row")).toBe("100");
  const qty: number[] = [];
  for (let r = 100; r < 115; r++) qty.push(Number(await cell(page, r, 2).textContent()));
  expect(qty).toEqual([...qty].sort((a, b) => a - b));
  expect(Math.min(...qty)).toBeGreaterThanOrEqual(50);
  // The selection went back to the first row, since a display position
  // stands for another row now; the column stays.
  await expect(page.locator("#namebox")).toHaveText("B1");
});

test("keeps the pinned panel open across a reload", async ({ page, serve }) => {
  const long = "p".repeat(600);
  const xxsv = await serve("t.csv", `id,text\n1,${long}\n2,short\n`);
  await open(page, xxsv.url);
  await cell(page, 0, 1).click();
  await page.keyboard.press(" ");
  await page.locator("#peek").getByRole("button", { name: "Pin to side" }).click();
  await expect(page.locator("#pinpanel .vb-pre")).toHaveText(long);
  await saveAndWait(page, xxsv, `id,text\n1,${long}\n2,short\n3,more\n`);
  await expect(page.locator("#pinpanel")).toBeVisible();
  await expect(page.locator("#pinpanel .vb-pre")).toHaveText(long); // the first cell again
});

test("drops filters and the sort on columns that are gone", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b\n2,x\n1,y\n");
  await open(page, xxsv.url);
  await page.locator('[data-sort="b"]').click();
  await page.locator('[data-sort="b"]').click(); // descending: y first
  await expect(cell(page, 0, 1)).toHaveText("y");
  await page.locator('[data-prof="1"]').click();
  await page.locator('#colpop input[placeholder="contains…"]').fill("x");
  await page.locator('#colpop input[placeholder="contains…"]').press("Enter");
  await expect(page.locator("#chips .chip")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await saveAndWait(page, xxsv, "a,c\n2,x\n1,y\n");
  await expect(page.locator('[data-sort="c"]')).toBeVisible();
  await expect(page.locator(".arrow")).toHaveCount(0);
  await expect(page.locator("#chips")).toBeHidden();
  await expect(page.locator("#counts")).toHaveText("2 rows · 2 columns");
  await expect(cell(page, 0, 0)).toHaveText("2"); // file order again
});

test("closes the distribution popover when the columns change", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b\n1,x\n2,y\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  await expect(page.locator("#colpop")).toBeVisible();
  await saveAndWait(page, xxsv, "a,c\n1,x\n2,y\n");
  await expect(page.locator('[data-sort="c"]')).toBeVisible();
  await expect(page.locator("#colpop")).toBeHidden({ timeout: 3000 });
});

test("keeps the distribution popover open when the columns stay the same", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b\n1,x\n2,y\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  await saveAndWait(page, xxsv, "a,b\n1,x\n2,y\n3,z\n");
  await expect(page.locator("#colpop")).toBeVisible();
});

test("keeps the last good table when the file goes bad, and recovers", async ({ page, serve }) => {
  const xxsv = await serve("t.jsonl", '{"a":1}\n{"a":2}\n');
  await open(page, xxsv.url);
  const g = await generation(page);
  const { rmSync } = await import("node:fs");
  rmSync(xxsv.path);
  await expect(page.locator("#error")).toContainText("reload failed");
  expect(await column(page, 0, 2)).toEqual(["1", "2"]);
  await saveAndWait(page, xxsv, '{"a":1}\n{"a":2}\n{"a":3}\n');
  expect(await generation(page)).toBeGreaterThan(g);
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#counts")).toHaveText("3 rows · 1 columns");
});
