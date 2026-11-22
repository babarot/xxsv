import { readFileSync } from "node:fs";
import { test, expect, open } from "./fixtures";

test("exports the current view as CSV, TSV and JSONL", async ({ page, serve }) => {
  const xxsv = await serve("orders.csv", "id,name,qty\n1,alice,3\n2,\"b, ob\",\n3,carol,5\n");
  const view = { search: "", filters: [{ column: "qty", op: "notnull" }], sorts: [{ column: "id", desc: true }], columns: ["name", "id"], top: 0 };
  await page.goto(xxsv.url + "#" + encodeURIComponent(JSON.stringify(view)));
  await expect(page.locator("#counts")).toHaveText("2 of 3 rows · 2 columns · 1 hidden");
  const get = async (format: string) => {
    await page.locator("#export-btn").click();
    await expect(page.locator("#expmenu")).toContainText("2 rows × 2 columns");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(`#expmenu [data-format="${format}"]`).click()]);
    await expect(page.locator("#expmenu")).toBeHidden();
    return { name: dl.suggestedFilename(), text: readFileSync((await dl.path())!, "utf8") };
  };
  expect(await get("csv")).toEqual({ name: "orders-view.csv", text: "name,id\ncarol,3\nalice,1\n" });
  expect(await get("tsv")).toEqual({ name: "orders-view.tsv", text: "name\tid\ncarol\t3\nalice\t1\n" });
  expect(await get("jsonl")).toEqual({ name: "orders-view.jsonl", text: '{"name":"carol","id":3}\n{"name":"alice","id":1}\n' });
});

test("closes the Export menu with Escape or a press outside", async ({ page, serve }) => {
  const xxsv = await serve("t.csv", "a\n1\n");
  await open(page, xxsv.url);
  await page.locator("#export-btn").click();
  await expect(page.locator("#expmenu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#expmenu")).toBeHidden();
  await page.locator("#export-btn").click();
  await page.locator("#rows").click({ position: { x: 200, y: 10 } });
  await expect(page.locator("#expmenu")).toBeHidden();
});
