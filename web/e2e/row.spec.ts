import { test, expect, open, cell, chips } from "./fixtures";

const rowItems = (page: import("@playwright/test").Page) =>
  page.locator("#pinpanel .rk").evaluateAll((els) => els.map((e) => `${e.querySelector("b")!.textContent}=${e.querySelector(".v")!.textContent}${e.classList.contains("hid") ? " (hidden)" : ""}`));

test("shows the selected cell's row with Enter, following the selection", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", 'a,b,c,j\nx,1,,"{""k"":[1]}"\ny,2,z,\n');
  const view = { search: "", filters: [], sorts: [], columns: ["c", "a", "j"], top: 0 };
  await page.goto(xxsv.url + "#" + encodeURIComponent(JSON.stringify(view)));
  await cell(page, 0, 1).click();
  await page.keyboard.press("Enter");
  await expect(page.locator('#pinpanel [data-panel="row"]')).toHaveClass(/on/);
  // The shown columns in their order, then the hidden one, dimmed.
  await expect.poll(() => rowItems(page)).toEqual(["c=∅ (missing)", "a=x", 'j={\n  "k": [\n    1\n  ]\n}', "b=1 (hidden)"]);
  await expect(page.locator("#pinpanel .rk.sel b")).toHaveText("a");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => rowItems(page)).toEqual(["c=z", "a=y", "j=∅ (missing)", "b=2 (hidden)"]);
  // A value filters the table; a hidden column's too.
  await page.locator('#pinpanel .rk[data-column="b"] .btn-icon').click();
  await expect(chips(page)).toHaveText(["b: 2"]);
  await expect(page.locator("#counts")).toHaveText("1 of 2 rows · 3 columns · 1 hidden");
  await page.keyboard.press("Enter"); // closes it
  await expect(page.locator("#pinpanel")).toBeHidden();
});

test("opens the row from the formula bar and switches tabs", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b\nx,1\n");
  await open(page, xxsv.url);
  await page.locator("#fbar-row").click();
  await expect.poll(() => rowItems(page)).toEqual(["a=x", "b=1"]);
  await page.locator('#pinpanel [data-panel="cell"]').click();
  await expect(page.locator("#pinpanel .vb-pre")).toHaveText("x");
  await page.locator('#pinpanel [data-panel="row"]').click();
  await expect.poll(() => rowItems(page)).toEqual(["a=x", "b=1"]);
});
