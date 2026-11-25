import { test, expect, open, column } from "./fixtures";

test("reads a web server's log times as datetimes", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "at,n\n[10/Oct/2000:13:55:36 -0700],1\n[01/Nov/2000:00:00:00 +0900],2\n[09/Oct/2000:23:00:00 +0000],3\n");
  await open(page, xxsv.url);
  await expect(page.locator('[data-sort="at"] .typ')).toHaveText("time");
  // Shown as written, whole; sorted by time, not by text.
  expect(await column(page, 0, 1)).toEqual(["[10/Oct/2000:13:55:36 -0700]"]);
  expect(await page.locator('#rows [data-r="0"][data-c="0"]').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.locator('[data-sort="at"]').click();
  await expect.poll(() => column(page, 1, 3)).toEqual(["3", "1", "2"]);
  // Filters by a range given in ISO 8601.
  await page.locator('[data-prof="0"]').click();
  const min = page.locator("#colpop .ff input").first();
  await min.fill("2000-10-10");
  await min.press("Enter");
  await expect(page.locator("#counts")).toContainText("2 of 3 rows");
});
