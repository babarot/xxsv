import { test, expect, open, cell, column, csv, saveAndWait, chips, removeChip, pickOp } from "./fixtures";

test("shows the file, the shape, types and cells", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(30, (r, i) => (i === 3 ? [r[0], "", "1234567", r[3], r[4]] : r)));
  await open(page, xxsv.url);
  await expect(page.locator("#file")).toHaveText("t.csv");
  await expect(page.locator("#format")).toHaveText("csv");
  await expect(page.locator("#counts")).toHaveText("30 rows · 5 columns");
  await expect(page.locator('[data-sort="qty"] .typ')).toHaveText("int");
  await expect(page.locator('[data-sort="price"] .typ')).toHaveText("num");
  await expect(page.locator('[data-sort="day"] .typ')).toHaveText("date");
  await expect(page.locator('[data-sort="name"] .typ')).toHaveText("str");
  expect(await column(page, 0, 3)).toEqual(["1", "2", "3"]);
  await expect(cell(page, 2, 1)).toHaveText("∅"); // missing
  await expect(cell(page, 2, 2)).toHaveText("1,234,567"); // integers grouped
  await expect(page.locator("#watch-file")).toHaveText("watching t.csv");
});

test("reads a TSV without a header row", async ({ page, serve }) => {
  const xxsv = await serve("t.tsv", "1\talpha\t3.5\n2\tbeta\t4.5\n");
  await open(page, xxsv.url);
  await expect(page.locator("#counts")).toHaveText("2 rows · 3 columns");
  await expect(page.locator('[data-sort="col1"]')).toBeVisible();
  await expect(page.locator("#notices")).toContainText("no header row");
  expect(await column(page, 1, 2)).toEqual(["alpha", "beta"]);
});

test("reads JSONL with nested values as json", async ({ page, serve }) => {
  const xxsv = await serve("t.jsonl", '{"a":1,"m":{"x":1}}\n{"a":2,"m":[1,2]}\n{"b":"only"}\n');
  await open(page, xxsv.url);
  await expect(page.locator("#format")).toHaveText("jsonl");
  await expect(page.locator("#counts")).toHaveText("3 rows · 3 columns");
  await expect(page.locator('[data-sort="m"] .typ')).toHaveText("json");
  await expect(cell(page, 2, 0)).toHaveText("∅");
});

test("sorts ascending, descending, then not at all", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(20));
  await open(page, xxsv.url);
  const qty = page.locator('[data-sort="qty"]');
  await qty.click();
  await expect(qty.locator(".arrow")).toBeVisible();
  const asc = (await column(page, 2, 20)).map(Number);
  expect(asc).toEqual([...asc].sort((a, b) => a - b));
  await qty.click();
  await expect.poll(async () => (await column(page, 2, 20)).map(Number)).toEqual([...asc].sort((a, b) => b - a));
  await qty.click();
  await expect(qty.locator(".arrow")).toHaveCount(0);
  await expect.poll(() => column(page, 0, 3)).toEqual(["1", "2", "3"]);
});

test("sorts by several columns with Shift-click", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "id,g,v\n1,b,2\n2,a,2\n3,b,1\n4,a,1\n5,a,\n");
  await open(page, xxsv.url);
  const g = page.locator('[data-sort="g"]'), v = page.locator('[data-sort="v"]');
  await g.click();
  await v.click({ modifiers: ["Shift"] });
  await expect(g.locator(".prio")).toHaveText("1");
  await expect(v.locator(".prio")).toHaveText("2");
  // a before b; within each, v ascending with the missing cell last.
  await expect.poll(() => column(page, 0, 5)).toEqual(["4", "2", "5", "3", "1"]);
  await v.click({ modifiers: ["Shift"] }); // the second key turns descending
  await expect.poll(() => column(page, 0, 5)).toEqual(["2", "4", "5", "1", "3"]);
  await v.click({ modifiers: ["Shift"] }); // and goes, leaving the first
  await expect(v.locator(".arrow")).toHaveCount(0);
  await expect(g.locator(".prio")).toHaveCount(0); // one key: no number
  await expect.poll(() => column(page, 0, 5)).toEqual(["2", "4", "5", "1", "3"]);
  await v.click(); // a plain click sorts by that column alone
  await expect(g.locator(".arrow")).toHaveCount(0);
  await expect.poll(() => column(page, 0, 5)).toEqual(["3", "4", "1", "2", "5"]);
});

test("searches all cells", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(200));
  await open(page, xxsv.url);
  await page.locator("#search").fill("item17");
  await expect(page.locator("#counts")).toHaveText("11 of 200 rows · 5 columns"); // item17, item170..179
  await expect(cell(page, 0, 1)).toHaveText("item17");
  await page.locator("#search").fill("");
  await expect(page.locator("#counts")).toHaveText("200 rows · 5 columns");
});

test("filters from the distribution popover and removes the filter from its chip", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(50));
  await open(page, xxsv.url);
  // Range filter on qty, applied as typed.
  await page.locator('[data-prof="2"]').click();
  const pop = page.locator("#colpop");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".kv")).toContainText("count");
  await pop.locator("input").first().fill("90");
  await pop.locator("input").first().press("Enter");
  await expect(chips(page)).toHaveText(["qty: ≥ 90"]);
  await expect(page.locator('[data-sort="qty"] .fmark')).toBeVisible();
  for (const v of await column(page, 2, 3)) expect(Number(v)).toBeGreaterThanOrEqual(90);
  // The popover stays open, the box keeps its text.
  await expect(pop).toBeVisible();
  await expect(pop.locator("input").first()).toHaveValue("90");
  // Contains filter on name, from the same popover kind.
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await page.locator('[data-prof="1"]').click();
  await pickOp(page, "#colpop", "contains");
  await pop.locator('input[placeholder="contains…"]').fill("item1");
  await pop.locator('input[placeholder="contains…"]').press("Enter");
  await expect(chips(page)).toHaveCount(2);
  await expect(page.locator("#chips .chip-clear")).toBeVisible();
  // Remove one from its editor, then clear all.
  await page.keyboard.press("Escape");
  await removeChip(page, 0);
  await expect(chips(page)).toHaveText(["name: contains “item1”"]);
  await page.locator("#chips .chip-clear").click();
  await expect(page.locator("#chips")).toBeHidden();
  await expect(page.locator("#counts")).toHaveText("50 rows · 5 columns");
});

test("filters by values picked in the list, and unpicks them", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "k,v\na,1\na,2\nb,3\nc,4\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  const item = (v: string) => page.locator("#colpop .vlist label").filter({ hasText: new RegExp(`^${v}`) });
  await item("a").click();
  await expect(page.locator("#counts")).toHaveText("2 of 4 rows · 2 columns");
  await item("b").click(); // one of several values
  await expect(page.locator("#counts")).toHaveText("3 of 4 rows · 2 columns");
  await expect(chips(page)).toHaveText(["k: a, b"]);
  await item("a").click();
  await item("b").click();
  await expect(page.locator("#counts")).toHaveText("4 rows · 2 columns");
  await expect(chips(page)).toHaveClass(/idle/); // waits for a value
});

test("shows the picked values as pills in the search box, and removes them", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "k\na\na\nb\nc\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  const item = (v: string) => page.locator("#colpop .vlist label").filter({ hasText: new RegExp(`^${v}`) });
  const pills = page.locator("#colpop .vbox .vtag");
  await item("a").click();
  await item("b").click();
  await item("c").click();
  await expect(pills).toHaveText(["a", "b", "c"]);
  await expect(page.locator("#counts")).toHaveText("4 of 4 rows · 1 columns");
  // × removes one; Backspace in the empty box marks the last, then removes it.
  await page.getByRole("button", { name: "Remove b" }).click();
  await expect(pills).toHaveText(["a", "c"]);
  const box = page.locator("#colpop .vbox input");
  await box.press("Backspace");
  await expect(pills.last()).toHaveClass(/armed/);
  await box.press("Backspace");
  await expect(pills).toHaveText(["a"]);
  await expect(page.locator("#counts")).toHaveText("2 of 4 rows · 1 columns");
  // Typing a value not listed adds it.
  await box.fill("zz");
  await box.press("Enter");
  await expect(pills).toHaveText(["a", "zz"]);
  // "is not" strikes the pills through.
  await pickOp(page, "#colpop", "is not");
  await expect(page.locator("#colpop .vbox .vtag.strike")).toHaveCount(2);
  await expect(page.locator("#counts")).toHaveText("2 of 4 rows · 1 columns");
});

test("negates a filter and switches its condition from the menu", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "k,v\na,1\na,2\nb,3\nab,4\n,5\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  // "is not" a value keeps the other values and the missing cell.
  await pickOp(page, "#colpop", "is not");
  await page.locator("#colpop .vlist label").filter({ hasText: /^a\d/ }).click();
  await expect(chips(page)).toHaveText(["k: is not “a”"]);
  await expect(page.locator("#counts")).toHaveText("3 of 5 rows · 2 columns");
  await expect(page.locator("#colpop .vlist .lv.strike")).toHaveCount(1);
  // Text conditions from the same menu; the value carries over.
  await pickOp(page, "#colpop", "does not contain");
  await expect(chips(page)).toHaveText(["k: does not contain “a”"]);
  const box = page.locator('#colpop input[placeholder="contains…"]');
  await box.fill("b");
  await box.press("Enter");
  await expect(chips(page)).toHaveText(["k: does not contain “b”"]);
  await expect(page.locator("#counts")).toHaveText("3 of 5 rows · 2 columns");
  await pickOp(page, "#colpop", "starts with");
  await expect(chips(page)).toHaveText(["k: starts with “b”"]);
  await expect(page.locator("#counts")).toHaveText("1 of 5 rows · 2 columns");
  // "not between" and "≥" on a number column.
  await page.keyboard.press("Escape");
  await page.locator('[data-prof="1"]').click();
  await pickOp(page, "#colpop", "not between");
  await page.locator("#colpop .fed input").first().fill("2");
  await page.locator("#colpop .fed input").nth(1).fill("4");
  await page.locator("#colpop .fed input").nth(1).press("Enter");
  await expect(chips(page).nth(1)).toHaveText("v: not between 2 – 4");
  await pickOp(page, "#colpop", "≥");
  await expect(chips(page).nth(1)).toHaveText("v: ≥ 2");
});

test("joins rules with or and groups them in the advanced filter", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "k,v\na,1\nb,2\nc,3\na,4\nb,5\n");
  await open(page, xxsv.url);
  await page.locator("#filter-btn").click();
  await page.locator("#fmenu").getByRole("button", { name: /^k/ }).click();
  await page.locator("#fedit .vlist label").filter({ hasText: /^a/ }).click();
  await expect(page.locator("#counts")).toHaveText("2 of 5 rows · 2 columns");
  // Advanced: a group of "v ≥ 5" or "v ≤ 1", and-ed with k.
  await page.locator("#chips .f-adv").click();
  await page.locator("#fadv .adv-foot .lnk").first().click();
  await page.locator("#fmenu").getByRole("button", { name: "Add filter group" }).click();
  const g = page.locator("#fadv .adv-group .adv-row");
  await g.first().locator("select").nth(0).selectOption("v");
  await g.first().locator("select").nth(1).selectOption("ge");
  await g.first().locator("input").fill("4");
  await g.first().locator("input").press("Enter");
  await expect(page.locator("#counts")).toHaveText("1 of 5 rows · 2 columns");
  await page.locator("#fadv .adv-group .gfoot .lnk").first().click();
  await g.nth(1).locator("select").nth(1).selectOption("v");
  await g.nth(1).locator("select").nth(2).selectOption("le");
  await g.nth(1).locator("input").fill("1");
  await g.nth(1).locator("input").press("Enter");
  await expect(page.locator("#counts")).toHaveText("2 of 5 rows · 2 columns");
  await expect(page.locator("#chips .fchip.bundle")).toHaveText("k is “a” and (v ≥ 4 or v ≤ 1)");
  // Or at the top: every row that is a or in the group.
  await page.locator("#fadv select.cj").first().selectOption("or");
  await expect(page.locator("#counts")).toHaveText("3 of 5 rows · 2 columns");
  // The view, groups included, survives a reload of the page.
  await page.keyboard.press("Escape");
  await expect.poll(() => decodeURIComponent(page.url())).toContain('"filters":[{"or":[{"column":"k"');
  await page.reload();
  await expect(page.locator("#counts")).toHaveText("3 of 5 rows · 2 columns");
  await expect(page.locator("#chips .fchip.bundle")).toHaveText("k is “a” or (v ≥ 4 or v ≤ 1)");
  // The column popover leaves rules in groups to the advanced filter.
  await page.locator('[data-prof="1"]').click();
  await expect(page.locator("#colpop .inadv")).toContainText("advanced filter");
});

test("clears the filters while a value list of the advanced filter is open", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "k,v\na,1\nb,2\n");
  const view = { filters: [{ or: [{ column: "k", op: "in", values: ["a"] }, { column: "v", op: "range", min: "2" }] }] };
  await open(page, xxsv.url + "#" + encodeURIComponent(JSON.stringify(view)));
  await page.locator("#chips .fchip.bundle").click();
  await page.locator("#fadv .tok").click();
  await expect(page.locator("#fmenu .vlist")).toBeVisible();
  await page.locator("#chips .chip-clear").click();
  await expect(page.locator("#chips")).toBeHidden();
  await expect(page.locator("#counts")).toHaveText("2 rows · 2 columns");
});

test("restores the view from the URL hash", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(100));
  const view = { search: "item1", filters: [{ column: "qty", op: "range", min: "50" }], sort: { column: "qty", desc: true }, top: 0 };
  await open(page, xxsv.url + "#" + encodeURIComponent(JSON.stringify(view)));
  await expect(page.locator("#search")).toHaveValue("item1");
  await expect(chips(page)).toHaveCount(1);
  await expect(page.locator('[data-sort="qty"] .arrow')).toBeVisible();
  const qty = (await column(page, 2, 3)).map(Number);
  expect(qty).toEqual([...qty].sort((a, b) => b - a));
  expect(qty[0]).toBeGreaterThanOrEqual(50);
});

test("ignores a broken hash", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(5));
  await open(page, xxsv.url + "#%7Bnot-json");
  await expect(page.locator("#counts")).toHaveText("5 rows · 5 columns");
});

test("filters missing and not missing cells from the distribution popover", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "k,n\na,1\n,2\nb,\n,4\n");
  await open(page, xxsv.url);
  const pop = page.locator("#colpop");
  // A text column: k has 2 missing, 2 not missing.
  await page.locator('[data-prof="0"]').click();
  await expect(pop.locator('[data-op="null"]')).toContainText("∅ only");
  await expect(pop.locator('[data-op="notnull"]')).toContainText("exclude ∅");
  await expect(pop.locator(".lbl").filter({ hasText: "Missing" })).toBeVisible();
  await pop.locator('[data-op="null"]').click();
  await expect(page.locator("#counts")).toHaveText("2 of 4 rows · 2 columns");
  await expect(chips(page)).toContainText("is missing");
  await expect(pop.locator('[data-op="null"]')).toHaveClass(/on/);
  await pop.locator('[data-op="notnull"]').click(); // replaces it
  await expect(page.locator("#counts")).toHaveText("2 of 4 rows · 2 columns");
  await expect(chips(page)).toContainText("is not missing");
  await expect(cell(page, 0, 0)).toHaveText("a");
  await pop.locator('[data-op="notnull"]').click(); // toggles off
  await expect(page.locator("#chips")).toBeHidden();
  // A number column has them too.
  await page.keyboard.press("Escape");
  await page.locator('[data-prof="1"]').click();
  await pop.locator('[data-op="null"]').click();
  await expect(page.locator("#counts")).toHaveText("1 of 4 rows · 2 columns");
  await expect(cell(page, 0, 0)).toHaveText("b");
});

test("shows no missing buttons for a column without missing cells", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "k\na\nb\n");
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  await expect(page.locator("#colpop .vlist")).toBeVisible(); // the values only
  await expect(page.locator("#colpop .pick")).toHaveCount(0);
  await expect(page.locator("#colpop .lbl").filter({ hasText: "Missing" })).toHaveCount(0);
  await expect(page.locator('#colpop [data-op="null"]')).toHaveCount(0);
});

test("draws missing cells hatched in the distributions and filters by clicking them", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "k,n\na,1\n,2\nb,\n,4\n");
  await open(page, xxsv.url);
  // A text column: a hatched segment, half of the bar.
  const seg = page.locator('[data-prof="0"] .seg .miss');
  await expect(seg).toHaveAttribute("title", /2 of 4 rows \(50%\)/);
  await seg.click();
  await expect(page.locator("#counts")).toHaveText("2 of 4 rows · 2 columns");
  await expect(page.locator("#colpop")).toBeHidden(); // filters without opening the popover
  await seg.click();
  await expect(page.locator("#chips")).toBeHidden();
  // A number column: a hatched column next to the histogram.
  const col = page.locator('[data-prof="1"] .miss-col');
  await expect(col).toHaveAttribute("title", /1 of 4 rows \(25%\)/);
  await col.click();
  await expect(page.locator("#counts")).toHaveText("1 of 4 rows · 2 columns");
  // The popover has a hatched line that toggles the same filter.
  await page.locator('[data-prof="1"] svg').click();
  const line = page.locator("#colpop .bars.missing button");
  await expect(line).toHaveClass(/on/);
  await line.click();
  await expect(page.locator("#counts")).toHaveText("4 rows · 2 columns");
  await expect(page.locator("#colpop .bars.missing button")).not.toHaveClass(/on/);
});

test("filters by the selected cell from the formula bar", async ({ page, serve }) => {
  const long = "w".repeat(600);
  const xxsv = await serve("t.csv", `k,j,t\na,"{""x"":1}",${long}\n,"{""x"":2}",short\nb,,short\na,"[1]",short\n`);
  await open(page, xxsv.url);
  const button = page.locator("#fbar-filter");
  await cell(page, 0, 0).click();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator("#counts")).toHaveText("2 of 4 rows · 3 columns");
  await expect(chips(page)).toHaveText(["k: a"]);
  await removeChip(page);
  // A missing cell filters to missing cells.
  await cell(page, 1, 0).click();
  await button.click();
  await expect(chips(page)).toContainText("is missing");
  await removeChip(page);
  // JSON values cannot be matched; a missing JSON cell can.
  await cell(page, 0, 1).click();
  await expect(button).toBeDisabled();
  await cell(page, 2, 1).click();
  await expect(button).toBeEnabled();
});

test("keeps the formula bar's filter disabled until a cut cell's full value arrives", async ({ page, serve }) => {
  const long = "w".repeat(600);
  const xxsv = await serve("t.csv", `t\n${long}\nshort\n`);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/cell*", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await open(page, xxsv.url);
  await cell(page, 0, 0).click();
  await expect(page.locator("#fbar-filter")).toBeDisabled();
  release();
  await expect(page.locator("#fbar-filter")).toBeEnabled();
  await page.locator("#fbar-filter").click();
  await expect(page.locator("#counts")).toHaveText("1 of 2 rows · 1 columns");
});

test("tells invalid cells from missing ones, and filters them", async ({ page, serve }) => {
  const rows = ["n,country"];
  for (let i = 1; i <= 40; i++) rows.push(`${i},JP`);
  rows.push("pending,NA", ",US");
  const xxsv = await serve("t.csv", rows.join("\n") + "\n");
  await open(page, xxsv.url);
  // "NA" is a country in a text column, not a missing cell.
  await page.locator('[data-prof="1"]').click();
  await expect(page.locator('#colpop [data-op="null"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  // The number column has 1 invalid and 1 missing cell.
  await page.locator('[data-prof="0"] svg').click();
  const pop = page.locator("#colpop");
  await expect(pop.locator(".kv")).toContainText("invalid1");
  await expect(pop.locator('[data-op="invalid"]')).toContainText("not a number");
  await pop.locator('[data-op="null"]').click();
  await expect(page.locator("#counts")).toHaveText("1 of 42 rows · 2 columns");
  await expect(cell(page, 0, 1)).toHaveText("US");
  await pop.locator('[data-op="invalid"]').click();
  await expect(page.locator("#counts")).toHaveText("1 of 42 rows · 2 columns");
  await expect(chips(page)).toContainText("is not a number");
  await expect(cell(page, 0, 0)).toHaveText("pending");
  await expect(cell(page, 0, 0)).toHaveClass(/bad/);
});

test("labels the bins of an integer histogram with whole values", async ({ page, serve }) => {
  const rows = ["rating"];
  for (let i = 0; i < 100; i++) rows.push(String((i % 5) + 1));
  const xxsv = await serve("t.csv", rows.join("\n") + "\n");
  await open(page, xxsv.url);
  const bars = page.locator('[data-prof="0"] rect');
  await expect(bars).toHaveCount(5);
  await expect(bars.first().locator("title")).toHaveText("1: 20");
  await page.locator('[data-prof="0"] svg').click();
  await expect(page.locator("#colpop .axis span").last()).toHaveText("5");
});

test("shows invalid integers as written and updates an open popover on reload", async ({ page, serve }) => {
  const rows = ["n,k"];
  for (let i = 1; i <= 40; i++) rows.push(`${i * 1000},x`);
  rows.push("00097,x", ",x");
  const xxsv = await serve("t.csv", rows.join("\n") + "\n");
  await open(page, xxsv.url);
  await page.locator("#search").fill("00097");
  await expect(cell(page, 0, 0)).toHaveText("00097"); // not 00,097
  await page.locator("#search").fill("");
  await page.locator('[data-prof="0"] svg').click();
  await expect(page.locator('#colpop [data-op="invalid"]')).toContainText("1");
  // The share of missing cells counts every row: 1 of 42.
  await expect(page.locator('[data-prof="0"] .miss-col')).toHaveAttribute("title", /1 of 42 rows/);
  // Fix the invalid value: the open popover follows.
  rows[rows.length - 2] = "97,x";
  await saveAndWait(page, xxsv, rows.join("\n") + "\n");
  await expect(page.locator("#colpop")).toBeVisible();
  await expect(page.locator('#colpop [data-op="invalid"]')).toHaveCount(0);
});
