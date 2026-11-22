import { test, expect, open, cell } from "./fixtures";

const long = "x".repeat(600); // cut by the server (400 bytes in the table)
const json = '{"k":[1,2,3],"s":"v"}';

function file() {
  return `id,text,obj\n1,${long},"${json.replace(/"/g, '""')}"\n2,short,"{""a"":1}"\n`;
}

test("opens the cell popover for a long cell, fetches the full value, and closes", async ({ page, serve, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const xxsv = await serve("t.csv", file());
  await open(page, xxsv.url);
  await cell(page, 0, 1).click();
  await expect(cell(page, 0, 1).locator(".xmark")).toBeVisible();
  // The formula bar shows the full value once fetched.
  await expect(page.locator("#fval .v")).toHaveText(long);
  await page.keyboard.press(" ");
  const peek = page.locator("#peek");
  await expect(peek).toBeVisible();
  await expect(peek.locator(".vb-pre")).toHaveText(long);
  const copy = peek.getByRole("button", { name: "Copy" });
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(long);
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  // Moving away closes it.
  await page.keyboard.press(" ");
  await expect(peek).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(peek).toBeHidden();
});

test("opens the cell popover on a double-click", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", file());
  await open(page, xxsv.url);
  await cell(page, 0, 1).dblclick();
  await expect(page.locator("#peek")).toBeVisible({ timeout: 3000 });
});

test("pretty-prints JSON and filters by the value", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", file());
  await open(page, xxsv.url);
  await cell(page, 0, 2).click();
  await cell(page, 0, 2).locator(".xmark").click();
  await expect(page.locator("#peek .vb-pre")).toHaveText(JSON.stringify(JSON.parse(json), null, 2));
  // JSON cannot be filtered by value; text can.
  await expect(page.locator("#peek").getByRole("button", { name: "Filter by this value" })).toBeDisabled();
  await cell(page, 1, 1).click(); // short: no popover
  await expect(cell(page, 1, 1).locator(".xmark")).toHaveCount(0);
  await cell(page, 0, 1).click();
  await page.keyboard.press(" ");
  await page.locator("#peek").getByRole("button", { name: "Filter by this value" }).click();
  await expect(page.locator("#counts")).toHaveText("1 of 2 rows · 3 columns");
  await expect(page.locator("#chips .chip")).toHaveCount(1);
});

test("keeps Copy and Filter disabled until the full value arrives", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", file());
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/cell*", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await open(page, xxsv.url);
  await cell(page, 0, 1).click();
  await page.keyboard.press(" ");
  const peek = page.locator("#peek");
  await expect(peek.getByRole("button", { name: "Copy" })).toBeDisabled();
  await expect(peek.getByRole("button", { name: "Filter by this value" })).toBeDisabled();
  release();
  await expect(peek.getByRole("button", { name: "Copy" })).toBeEnabled();
  await expect(peek.locator(".vb-pre")).toHaveText(long);
});

test("pins the value to the side panel, follows the selection, and unpins", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", file());
  await open(page, xxsv.url);
  await cell(page, 0, 1).click();
  await page.keyboard.press(" ");
  await page.locator("#peek").getByRole("button", { name: "Pin to side" }).click();
  const panel = page.locator("#pinpanel");
  await expect(panel).toBeVisible();
  await expect(page.locator("#peek")).toBeHidden();
  await expect(panel.locator(".vb-pre")).toHaveText(long);
  await cell(page, 1, 1).click();
  await expect(panel.locator(".vb-pre")).toHaveText("short");
  // The panel stays open when the query changes.
  await page.locator('[data-sort="id"]').click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Unpin" }).click();
  await expect(panel).toBeHidden();
});

test("closes the distribution popover on Escape and on a click outside", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", file());
  await open(page, xxsv.url);
  await page.locator('[data-prof="0"]').click();
  await expect(page.locator("#colpop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#colpop")).toBeHidden();
  await page.locator('[data-prof="0"]').click();
  await page.locator("#status").click();
  await expect(page.locator("#colpop")).toBeHidden();
});
