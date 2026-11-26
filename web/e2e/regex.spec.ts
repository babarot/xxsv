import { test, expect, open, csv, chips, pickOp } from "./fixtures";

const hashView = (page: import("@playwright/test").Page) => JSON.parse(decodeURIComponent(new URL(page.url()).hash.slice(1) || "{}"));

test("searches with a regular expression, case-sensitive unless (?i)", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(200));
  await open(page, xxsv.url);
  // The toggle answers the first press, the box not focused.
  await page.locator("#search-rx").click();
  await expect(page.locator("#search-rx")).toHaveClass(/on/);
  await page.locator("#search").fill("^item1\\d$");
  await expect(page.locator("#counts")).toHaveText("10 of 200 rows · 5 columns"); // item10..item19
  await page.locator("#search").fill("^ITEM1\\d$");
  await expect(page.locator("#counts")).toHaveText("0 of 200 rows · 5 columns");
  await page.locator("#search").fill("(?i)^ITEM1\\d$");
  await expect(page.locator("#counts")).toHaveText("10 of 200 rows · 5 columns");
  await expect.poll(() => hashView(page)).toMatchObject({ search: "(?i)^ITEM1\\d$", regex: true });
  // One the server cannot read: its error shows, and the table stays.
  await page.locator("#search").fill("item(1");
  await expect(page.locator("#search-err")).toBeVisible();
  await expect(page.locator("#search-err")).toContainText("missing closing )");
  await expect(page.locator("#counts")).toHaveText("10 of 200 rows · 5 columns");
  expect(hashView(page).search).toBe("(?i)^ITEM1\\d$");
  await page.locator("#search").fill("item(1)");
  await expect(page.locator("#search-err")).toBeHidden();
  await expect(page.locator("#counts")).toHaveText("111 of 200 rows · 5 columns"); // item1, item10.., item100..199
  // Off again: the same text is plain.
  await page.locator("#search-rx").click();
  await expect(page.locator("#counts")).toHaveText("0 of 200 rows · 5 columns");
});

test("keeps the regex toggle in the URL", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(30));
  const view = { search: "^item2$", regex: true, filters: [], sorts: [], columns: null, top: 0 };
  await page.goto(xxsv.url + "#" + encodeURIComponent(JSON.stringify(view)));
  await expect(page.locator("#counts")).toHaveText("1 of 30 rows · 5 columns");
  await expect(page.locator("#search-rx")).toHaveClass(/on/);
  await expect(page.locator("#search")).toHaveValue("^item2$");
});

test("filters a column with a regular expression", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(30));
  await open(page, xxsv.url);
  await page.locator('[data-prof="1"]').click();
  await pickOp(page, "#colpop", "matches regex");
  const box = page.locator('#colpop input[placeholder="regex (RE2)…"]');
  await box.fill("^item(1|2");
  await box.press("Enter");
  await expect(page.locator("#colpop .ff-err")).toContainText("missing closing )");
  await expect(page.locator("#chips")).toBeHidden();
  await box.fill("^item(1|2)$");
  await box.press("Enter");
  await expect(chips(page)).toHaveText("name: matches /^item(1|2)$/");
  await expect(page.locator("#counts")).toHaveText("2 of 30 rows · 5 columns");
});

test("checks text carried over to a regular expression before applying it", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "k\na(\nb\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  await pickOp(page, "#colpop", "contains");
  await page.locator('#colpop input[placeholder="contains…"]').fill("a(");
  await page.locator('#colpop input[placeholder="contains…"]').press("Enter");
  await expect(page.locator("#counts")).toHaveText("1 of 2 rows · 1 columns");
  await pickOp(page, "#colpop", "matches regex");
  await expect(page.locator("#colpop .ff-err")).toContainText("missing closing )");
  await expect(page.locator('#colpop input[placeholder="regex (RE2)…"]')).toHaveValue("a(");
  await expect(page.locator("#counts")).toHaveText("2 rows · 1 columns"); // the rule waits
});
