import { test, expect, open, cell, csv, saveAndWait, holdResponses, type Xxsv } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

/** The opacity of the glow layer over an element, or null if it has none. */
const glow = (l: Locator) => l.evaluate((e) => (e.classList.contains("chg") || e.closest(".added") ? Number(getComputedStyle(e, "::after").opacity) : null));

/** The display rows that are marked: "+" for added, else the changed columns. */
async function marks(page: Page, n: number) {
  return page.evaluate((n) => {
    const out: Record<number, string> = {};
    document.querySelectorAll<HTMLElement>("#rows .row").forEach((row) => {
      const r = Number(row.querySelector<HTMLElement>(".rh")?.dataset.row);
      if (!(r < n)) return;
      if (row.classList.contains("added")) out[r] = "+";
      const chg = [...row.querySelectorAll<HTMLElement>(".chg")].map((c) => c.dataset.c).join("");
      if (chg) out[r] = chg;
    });
    return out;
  }, n);
}

async function setup(page: Page, serve: (n: string, c: string) => Promise<Xxsv>) {
  const xxsv = await serve("t.csv", csv(20));
  await open(page, xxsv.url);
  return xxsv;
}

test("marks changed cells and added rows, says what changed, and fades in 3 seconds", async ({ page, serve }) => {
  const xxsv = await setup(page, serve);
  // Row 2: qty changed. A row inserted after row 4. Row 7 removed. One appended.
  const lines = csv(20).trimEnd().split("\n");
  lines[2] = lines[2].replace(",74,", ",99,");
  lines.splice(5, 0, "100,new,1,1.00,2024-01-01");
  lines.splice(8, 1);
  lines.push("21,appended,1,1.00,2024-01-01");
  await saveAndWait(page, xxsv, lines.join("\n") + "\n");
  await expect(page.locator("#gen")).toContainText("· 1 changed, 2 added, 1 removed");
  await expect.poll(() => marks(page, 30)).toEqual({ 1: "2", 4: "+", 20: "+" });
  expect(await glow(cell(page, 1, 2))).toBeGreaterThan(0.5);
  // After 3 seconds the glow is gone; the summary stays until the next save.
  await page.waitForTimeout(3300);
  expect(await glow(cell(page, 1, 2))).toBe(0);
  await page.locator("#grid").evaluate((g) => g.dispatchEvent(new Event("scroll")));
  await expect.poll(() => marks(page, 30)).toEqual({});
  await expect(page.locator("#gen")).toContainText("1 changed, 2 added, 1 removed");
});

test("says no changes for a save that changes nothing", async ({ page, serve }) => {
  const xxsv = await setup(page, serve);
  await saveAndWait(page, xxsv, csv(20));
  await expect(page.locator("#gen")).toContainText("· no changes");
});

test("does not glow or summarize after a browser reload", async ({ page, serve }) => {
  const xxsv = await setup(page, serve);
  await saveAndWait(page, xxsv, csv(20, (r, i) => (i === 1 ? [r[0], "changed", r[2], r[3], r[4]] : r)));
  await expect.poll(() => marks(page, 5)).toEqual({ 0: "1" });
  await page.reload();
  await expect(page.locator("#gen")).toContainText("generation 2");
  await expect(page.locator("#rows .row:not(.loading)").first()).toBeVisible();
  await expect(page.locator("#gen")).toHaveText(/^generation 2 · loaded [^·]+$/); // no summary
  expect(await marks(page, 5)).toEqual({});
});

test("marks the right rows while sorted", async ({ page, serve }) => {
  const xxsv = await setup(page, serve);
  await page.locator('[data-sort="qty"]').click();
  await page.locator('[data-sort="qty"]').click(); // descending
  await expect(page.locator('[data-sort="qty"] .arrow')).toBeVisible();
  // id 10 has qty 70; make it 100 so it sorts first.
  await saveAndWait(page, xxsv, csv(20, (r, i) => (i === 10 ? [r[0], r[1], "100", r[3], r[4]] : r)));
  await expect(cell(page, 0, 0)).toHaveText("10");
  await expect.poll(() => marks(page, 20)).toEqual({ 0: "2" });
});

test("a row scrolled into view late glows for the time left", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(500));
  await open(page, xxsv.url);
  await saveAndWait(page, xxsv, csv(500, (r, i) => (i === 400 ? [r[0], "far", r[2], r[3], r[4]] : r)));
  await page.waitForTimeout(800);
  await page.locator("#grid").evaluate((g) => (g.scrollTop = 395 * 26));
  await expect(cell(page, 399, 1)).toHaveClass(/chg/);
  // The rebuilt rows resume the animation: its delay is the time already
  // spent glowing, not 0.
  const delay = await page.locator("#rows").evaluate((r) => parseFloat(r.style.getPropertyValue("--flash-delay")));
  expect(delay).toBeLessThan(-500);
  expect(delay).toBeGreaterThan(-3000);
});

test("starts the glow when the current rows arrive, not on a stale response", async ({ page, serve }) => {
  const xxsv = await setup(page, serve);
  const rows = await holdResponses(page, "**/api/rows");
  rows.start();
  await saveAndWait(page, xxsv, csv(20, (r, i) => (i === 1 ? [r[0], "changed", r[2], r[3], r[4]] : r)));
  await rows.waitFor(1); // the reloaded rows, held
  // Change the query before they arrive; its rows are held too.
  await page.locator('[data-sort="id"]').click();
  await rows.waitFor(2);
  rows.release(0); // stale: dropped
  await page.waitForTimeout(3500);
  rows.stop();
  rows.release(1);
  await expect.poll(() => marks(page, 5)).toEqual({ 0: "1" });
  expect(await glow(cell(page, 0, 1))).toBeGreaterThan(0.5);
});
