import { test, expect, open, cell } from "./fixtures";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// A 1x1 PNG.
const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const uri = `data:image/png;base64,${b64}`;

// put writes the image next to the table, at img/a.png.
function put(table: string) {
  mkdirSync(join(dirname(table), "img"), { recursive: true });
  writeFileSync(join(dirname(table), "img", "a.png"), Buffer.from(b64, "base64"));
}

const drawn = (img: import("@playwright/test").Locator) => expect.poll(() => img.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(1);

test("previews a local image in the popover, the cell tab and the row tab", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "id,pic\n1,img/a.png\n2,plain\n");
  put(xxsv.path);
  await open(page, xxsv.url);
  await cell(page, 0, 1).click();
  await page.keyboard.press(" ");
  await drawn(page.locator("#peek .cellimg img"));
  await expect(page.locator("#peek .vb-pre")).toHaveText("img/a.png");
  await page.locator("#peek").getByRole("button", { name: "Pin to side" }).click();
  await drawn(page.locator("#pinpanel .cellimg img"));
  await page.locator('#pinpanel [data-panel="row"]').click();
  await drawn(page.locator('#pinpanel .rk[data-column="pic"] .cellimg img'));
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('#pinpanel .rk[data-column="pic"] .v')).toHaveText("plain");
  await expect(page.locator("#pinpanel .cellimg")).toHaveCount(0);
});

test("shows an image that an absolute path names", async ({ page, serve }, testInfo) => {
  const pic = testInfo.outputPath("elsewhere", "a.png");
  mkdirSync(dirname(pic), { recursive: true });
  writeFileSync(pic, Buffer.from(b64, "base64"));
  const xxsv = await serve("t.tsv", `id\tpic\n1\t${pic}\n`);
  await open(page, xxsv.url);
  await expect(cell(page, 0, 1).locator(".thumb canvas")).toBeVisible();
});

test("previews a data: image, whole even when the table cuts it", async ({ page, serve }) => {
  // Trailing bytes after the image's end are ignored; they make the value
  // longer than the table shows.
  const big = `data:image/png;base64,${Buffer.concat([Buffer.from(b64, "base64"), Buffer.alloc(1200)]).toString("base64")}`;
  const xxsv = await serve("t.tsv", `id\tpic\n1\t${uri}\n2\t${big}\n`);
  await open(page, xxsv.url);
  for (const r of [0, 1]) {
    await cell(page, r, 1).click();
    await page.keyboard.press(" ");
    await drawn(page.locator("#peek .cellimg img"));
    await page.keyboard.press("Escape");
  }
});

test("says so when there is no image, and loads nothing from URLs", async ({ page, serve }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const xxsv = await serve("t.csv", "id,pic\n1,nope.png\n2,https://example.com/long/enough/for/the/popover/a.png\n");
  await open(page, xxsv.url);
  await cell(page, 0, 1).click();
  await page.keyboard.press(" ");
  await expect(page.locator("#peek .cellimg")).toHaveText("No image at this path");
  await cell(page, 1, 1).click();
  await page.keyboard.press(" ");
  await expect(page.locator("#peek")).toBeVisible();
  await expect(page.locator("#peek .cellimg")).toHaveCount(0);
  expect(requests.filter((u) => !u.startsWith(xxsv.url))).toEqual([]);
  // Names without files make no room for images.
  await expect(page.locator("#rows .thumb:visible")).toHaveCount(0);
});

test("shows a small image in the cell, and a larger one on hover", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "id,pic\n1,img/a.png\n2,nope.png\n3,plain\n");
  put(xxsv.path);
  await open(page, xxsv.url);
  const small = cell(page, 0, 1).locator(".thumb canvas");
  await expect(small).toBeVisible();
  await expect(cell(page, 1, 1).locator(".thumb canvas")).toBeHidden();
  await expect(cell(page, 2, 1).locator(".thumb")).toHaveCount(0);
  await expect(cell(page, 0, 1)).toHaveText("img/a.png");
  expect(await cell(page, 0, 1).evaluate((e) => (e as HTMLElement).offsetHeight)).toBe(26);
  await small.hover();
  await drawn(page.locator("#imgzoom img"));
  await page.mouse.move(5, 5);
  await expect(page.locator("#imgzoom")).toBeHidden();
});

test("keeps the small images while scrolling, and follows a reload", async ({ page, serve }) => {
  const body = (n: number) => "id,pic\n" + Array.from({ length: n }, (_, i) => `${i},img/a.png\n`).join("");
  const xxsv = await serve("t.csv", body(300));
  put(xxsv.path);
  let requests = 0;
  page.on("request", (r) => { if (r.url().includes("/api/image")) requests++; });
  await open(page, xxsv.url);
  await expect(cell(page, 0, 1).locator(".thumb canvas")).toBeVisible();
  await page.waitForTimeout(300);
  const before = requests;
  // A small scroll and a selection rebuild the rows; only new rows ask.
  await page.locator("#grid").evaluate((g) => { g.scrollTop = 52; });
  await cell(page, 5, 1).click();
  await page.waitForTimeout(400);
  expect(requests - before).toBeLessThanOrEqual(3);
  xxsv.save(body(301));
  await expect(page.locator("#counts")).toContainText("301");
  await expect.poll(() => cell(page, 5, 1).locator(".thumb").getAttribute("data-src")).toContain("gen=2");
  await expect(cell(page, 5, 1).locator(".thumb canvas")).toBeVisible();
});
