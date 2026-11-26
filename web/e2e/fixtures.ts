// Fixtures for the E2E tests.
//
// xxsv: starts the binary on a file in the test's output directory and gives
// the page URL and a way to save new content (written to a temporary file
// and renamed over the old one, as many editors do).
//
// Every test also fails on a console error or a CSP violation in the page.
import { test as base, expect, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

export interface Xxsv {
  url: string;
  path: string;
  save(content: string): void;
}

type Fixtures = {
  serve: (name: string, content: string, args?: string[]) => Promise<Xxsv>;
  consoleErrors: string[];
};

export const test = base.extend<Fixtures>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(String(e)));
      await use(errors);
      expect(errors, "console errors and CSP violations").toEqual([]);
    },
    { auto: true },
  ],
  serve: async ({}, use, testInfo) => {
    const procs: ChildProcess[] = [];
    await use(async (name, content, args = []) => {
      const path = testInfo.outputPath(name);
      writeFileSync(path, content);
      const bin = process.env.XXSV_E2E_BIN;
      if (!bin) throw new Error("XXSV_E2E_BIN is not set; run the tests with npm run e2e");
      const p = spawn(bin, ["--no-open", "-p", "0", ...args, path], { stdio: ["ignore", "ignore", "pipe"] });
      procs.push(p);
      const url = await new Promise<string>((ok, fail) => {
        let err = "";
        p.stderr!.on("data", (b: Buffer) => {
          err += b.toString();
          const m = /at (http:\/\/\S+)/.exec(err);
          if (m) ok(m[1]);
        });
        p.on("exit", (code) => fail(new Error(`xxsv exited with ${code}: ${err}`)));
      });
      return {
        url,
        path,
        save(text: string) {
          writeFileSync(path + ".tmp", text);
          renameSync(path + ".tmp", path);
        },
      };
    });
    for (const p of procs) p.kill();
  },
});

export { expect };

// ---- page helpers ----

/** Opens the page and waits for the first rows. */
export async function open(page: Page, url: string) {
  await page.goto(url);
  await loaded(page);
}

/** Waits until the table shows rows of the current load. */
export async function loaded(page: Page) {
  await expect(page.locator("#gen")).toContainText("generation");
  await expect(page.locator("#rows .row:not(.loading)").first()).toBeVisible();
}

/** The cell at a display position (row and column from 0). */
export const cell = (page: Page, r: number, c: number) => page.locator(`#rows [data-r="${r}"][data-c="${c}"]`);

/** The texts of a column for the first n displayed rows. */
export async function column(page: Page, c: number, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let r = 0; r < n; r++) out.push((await cell(page, r, c).textContent()) ?? "");
  return out;
}

/** The generation the status bar shows. */
export async function generation(page: Page): Promise<number> {
  const m = /generation (\d+)/.exec((await page.locator("#gen").textContent()) ?? "");
  return m ? Number(m[1]) : 0;
}

/** Saves new content and waits until the page shows the next generation. */
export async function saveAndWait(page: Page, xxsv: Xxsv, content: string) {
  const g = await generation(page);
  xxsv.save(content);
  await expect.poll(() => generation(page), { timeout: 15_000 }).toBeGreaterThan(g);
}

/**
 * Holds the responses of requests matching a URL pattern until released, to
 * make a response arrive late. Requests made while holding is off pass.
 */
export async function holdResponses(page: Page, pattern: string | RegExp) {
  const held: { route: Route; release: () => void }[] = [];
  let on = false;
  await page.route(pattern, async (route) => {
    if (!on) return route.continue();
    const response = await route.fetch();
    await new Promise<void>((release) => held.push({ route, release }));
    await route.fulfill({ response });
  });
  return {
    start() { on = true; },
    stop() { on = false; },
    count: () => held.length,
    async waitFor(n: number) { await expect.poll(() => held.length).toBeGreaterThanOrEqual(n); },
    /** Releases the i-th held response (in arrival order). */
    release(i: number) { held[i].release(); },
    releaseAll() { for (const h of held) h.release(); },
  };
}

/** A CSV with a header and n rows: id, name, qty, price, day. */
export function csv(n: number, edit?: (row: string[], i: number) => string[]): string {
  const lines = ["id,name,qty,price,day"];
  for (let i = 1; i <= n; i++) {
    let row = [String(i), `item${i}`, String((i * 37) % 100), ((i * 7919) % 10000 / 100).toFixed(2), `2024-01-${String((i % 28) + 1).padStart(2, "0")}`];
    if (edit) row = edit(row, i);
    lines.push(row.join(","));
  }
  return lines.join("\n") + "\n";
}

/** The filter chips above the table. */
export const chips = (page: Page) => page.locator("#chips .fchip");

/** Removes the i-th filter chip's rule from its editor. */
export async function removeChip(page: Page, i = 0) {
  await chips(page).nth(i).click();
  await page.locator('#fedit [aria-label="Delete filter"]').click();
}

/** Picks a rule's condition from the menu of the editor in scope. */
export async function pickOp(page: Page, scope: string, label: string) {
  await page.locator(`${scope} .op-btn`).click();
  await page.locator("#fmenu").getByRole("button", { name: label, exact: true }).click();
}
