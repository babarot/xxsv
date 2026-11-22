import { test, expect, open, csv } from "./fixtures";

test("keeps the theme, accent, number color and histogram scale across a reload", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(50));
  await open(page, xxsv.url);
  const html = page.locator("html");
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings")).toBeVisible();
  await page.locator('#scheme-choice [data-scheme="dark"]').click();
  await page.locator('#accent-choice [data-accent="teal"]').click();
  await page.locator('#numcolor-choice [data-numcolor="off"]').click();
  const bars = () => page.locator('[data-prof="2"] rect').evaluateAll((rs) => rs.map((r) => r.getAttribute("height")).join());
  const linear = await bars();
  await page.locator('#histscale-choice [data-histscale="log"]').click();
  await expect.poll(bars).not.toBe(linear);
  await expect(html).toHaveAttribute("data-scheme", "dark");
  await expect(html).toHaveAttribute("data-accent", "teal");
  await expect(html).toHaveAttribute("data-numcolor", "off");
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings")).toBeHidden();
  await page.reload();
  await expect(html).toHaveAttribute("data-scheme", "dark");
  await expect(html).toHaveAttribute("data-accent", "teal");
  await expect(html).toHaveAttribute("data-numcolor", "off");
  await page.locator("#settings-btn").click();
  await expect(page.locator('#histscale-choice [data-histscale="log"]')).toHaveClass(/on/);
  await expect(page.locator('#scheme-choice [data-scheme="dark"]')).toHaveClass(/on/);
});

test("describes the view, copies a link to it, and lists the file", async ({ page, serve, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const xxsv = await serve("t.csv", csv(50));
  await open(page, xxsv.url);
  await page.locator('[data-sort="qty"]').click();
  await page.locator("#settings-btn").click();
  await expect(page.locator("#about-view")).toHaveText("50 of 50 rows, sorted by qty ascending.");
  await expect(page.locator("#about-list")).toContainText("t.csv");
  await page.locator("#copy-link").click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(decodeURIComponent(new URL(link).hash.slice(1))).sort).toEqual({ column: "qty" });
});

test("turns digit grouping off and on, and keeps the choice across a reload", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "n,x\n1234567,1234.5\n-9007199254740993,7\n");
  await open(page, xxsv.url);
  const n = page.locator('#rows [data-r="0"][data-c="0"]');
  await expect(n).toHaveText("1,234,567");
  await page.locator("#settings-btn").click();
  await expect(page.locator('#numgroup-choice [data-numgroup="on"]')).toHaveClass(/on/);
  await page.locator('#numgroup-choice [data-numgroup="off"]').click();
  await expect(n).toHaveText("1234567");
  await expect(page.locator('#rows [data-r="1"][data-c="0"]')).toHaveText("-9007199254740993");
  await page.reload();
  await expect(n).toHaveText("1234567");
  await page.locator("#settings-btn").click();
  await expect(page.locator('#numgroup-choice [data-numgroup="off"]')).toHaveClass(/on/);
  await page.locator('#numgroup-choice [data-numgroup="on"]').click();
  await expect(n).toHaveText("1,234,567");
  // Numbers with a fraction are never grouped.
  await expect(page.locator('#rows [data-r="0"][data-c="1"]')).toHaveText("1234.5");
});
