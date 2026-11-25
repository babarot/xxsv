import { test, expect, open, cell, column, saveAndWait } from "./fixtures";

const lines = ["time:2024-01-02T10:00:00Z\thost:127.0.0.1\tstatus:200", "status:404\tua:a: b\thost:::1", "broken\tstatus:500"];

test("reads LTSV by its labels, and follows the file", async ({ page, serve }) => {
  const xxsv = await serve("access.log", lines.join("\n") + "\n");
  await open(page, xxsv.url);
  await expect(page.locator("#format")).toHaveText("ltsv");
  await expect(page.locator("#counts")).toHaveText("2 rows · 4 columns");
  expect(await column(page, 2, 2)).toEqual(["200", "404"]);
  await expect(page.locator('[data-sort="status"] .typ')).toHaveText("int");
  await expect(page.locator('[data-sort="time"] .typ')).toHaveText("time");
  await expect(cell(page, 1, 3)).toHaveText("a: b");
  await expect(cell(page, 0, 3)).toHaveText("∅");
  const skipped = page.locator("#notices span");
  await expect(skipped).toHaveText("1 lines skipped");
  await expect(skipped).toHaveAttribute("title", "Lines with a field that is not label:value");
  await saveAndWait(page, xxsv, [...lines.slice(0, 2), "host:10.0.0.1\tstatus:301"].join("\n") + "\n");
  await expect(page.locator("#counts")).toHaveText("3 rows · 4 columns");
  await expect(cell(page, 2, 2)).toHaveText("301");
  await expect(skipped).toHaveCount(0);
});
