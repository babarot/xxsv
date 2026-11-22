import { test, expect, open, csv } from "./fixtures";

// The page keeps at most 20 blocks of 200 rows; past that it drops
// the loaded blocks farthest from the view, never the selected cell's block
// (block 0 here) or one still loading.
//
// Each visit scrolls to the first row of a block. The view then shows about
// 25 rows, and the prefetch rule (the block holding the row half a block
// past the view) names the same block, so a visit loads exactly one block.
test("holds 20 blocks and drops the farthest one past that", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", csv(100_000));
  await open(page, xxsv.url);
  const fetched: number[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/rows")) fetched.push(JSON.parse(r.postData() ?? "{}").offset / 200);
  });
  const visit = async (block: number) => {
    await page.locator("#grid").evaluate((g, row) => (g.scrollTop = row * 26), block * 200);
    await expect.poll(() => page.locator("#rows .rh").first().getAttribute("data-row")).toBe(String(block * 200));
    await expect(page.locator("#rows .row.loading")).toHaveCount(0);
  };
  // Block 0 and 19 more: 20 blocks, nothing dropped.
  for (let i = 1; i <= 19; i++) await visit(i * 10);
  expect(fetched).toEqual(Array.from({ length: 19 }, (_, i) => (i + 1) * 10));
  fetched.length = 0;
  await visit(10); // the farthest from the last visit, still held
  await visit(190);
  expect(fetched).toEqual([]);
  // The 21st block drops the one farthest from it: block 10.
  await visit(200);
  expect(fetched).toEqual([200]);
  fetched.length = 0;
  await visit(20); // still held
  expect(fetched).toEqual([]);
  await visit(10); // dropped: fetched again
  expect(fetched).toEqual([10]);
});
