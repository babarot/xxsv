import { test, expect, open, cell, csv } from "./fixtures";
import type { Page } from "@playwright/test";

const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const at = async (page: Page, r: number, c: number) => {
  const b = (await cell(page, r, c).boundingBox())!;
  return [b.x + 20, b.y + b.height / 2] as const;
};

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("copies the selected cell, whole", async ({ page, serve }) => {
  const long = "x".repeat(3000);
  const xxsv = await serve("t.csv", `id,s\n1234567,${long}\n2,y\n`);
  await open(page, xxsv.url);
  await cell(page, 0, 0).click();
  await page.keyboard.press("ControlOrMeta+c");
  await expect(page.locator("#copied")).toHaveText("Copied 1 cell");
  expect(await clip(page)).toBe("1234567"); // as the file has it, not 1,234,567
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => clip(page)).toBe(long);
});

test("selects a range by dragging, in any direction, and copies it", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b,c\n1,x,p\n2,,q\n3,z,r\n");
  await open(page, xxsv.url);
  await page.mouse.move(...(await at(page, 2, 1)));
  await page.mouse.down();
  await page.mouse.move(...(await at(page, 1, 0)), { steps: 4 });
  await page.mouse.move(...(await at(page, 0, 0)), { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#namebox")).toHaveText("A1:B3");
  expect(await page.evaluate(() => String(getSelection()))).toBe("");
  // Released: moving the mouse no longer extends the range.
  await page.mouse.move(...(await at(page, 2, 2)), { steps: 3 });
  await expect(page.locator("#namebox")).toHaveText("A1:B3");
  await page.keyboard.press("ControlOrMeta+c");
  await expect(page.locator("#copied")).toHaveText("Copied 6 cells (3 × 2)");
  expect(await clip(page)).toBe("1\tx\n2\t\n3\tz");
});

test("copies rows the page has not loaded, in the order shown", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(3000));
  await open(page, xxsv.url);
  await page.locator('[data-sort="id"]').click();
  await page.locator('[data-sort="id"]').click(); // descending
  await expect(cell(page, 0, 0)).toHaveText("3,000");
  await page.locator('[data-col="0"]').click();
  await page.keyboard.press("ControlOrMeta+c");
  await expect(page.locator("#copied")).toHaveText("Copied 3,000 cells (3,000 × 1)");
  expect(await clip(page)).toBe(Array.from({ length: 3000 }, (_, i) => 3000 - i).join("\n"));
});

test("scrolls while dragging past the bottom edge", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(500));
  await open(page, xxsv.url);
  const box = (await page.locator("#grid").boundingBox())!;
  const [x, y] = await at(page, 3, 1);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, box.y + box.height + 8, { steps: 4 });
  await expect.poll(async () => Number(/B4:B(\d+)/.exec((await page.locator("#namebox").textContent())!)?.[1] ?? 0)).toBeGreaterThan(40);
  await page.mouse.up();
  const name = await page.locator("#namebox").textContent();
  await page.waitForTimeout(200);
  await expect(page.locator("#namebox")).toHaveText(name!);
});

test("leaves text selected in the page, and text boxes, to the browser", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a,b\nhello,world\n");
  await open(page, xxsv.url);
  await cell(page, 0, 0).click();
  await page.locator("#fval .v").dblclick(); // selects the word
  await cell(page, 0, 1).hover();
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => clip(page)).toBe("hello");
  await page.locator("#search").fill("wor");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => clip(page)).toBe("wor");
  await expect(page.locator("#counts")).toContainText("1 of 1");
  // A press on a cell, with Shift too, takes over from both.
  await cell(page, 0, 1).click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => clip(page)).toBe("hello\tworld");
});

test("shows the default cursor over cells", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a\n1\n");
  await open(page, xxsv.url);
  expect(await cell(page, 0, 0).evaluate((e) => getComputedStyle(e).cursor)).toBe("default");
});
