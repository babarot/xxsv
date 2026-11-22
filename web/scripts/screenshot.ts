// Takes docs/screenshot-light.png and docs/screenshot-dark.png for the
// README: builds xxsv, opens a generated table of orders (no real data),
// selects a range so the status bar shows its sum, opens a column's
// distribution, and captures the page in the light and the dark theme
// (the page follows the browser's color scheme by default).
//
//	cd web && npm run build && npm run screenshot
//
// Like the E2E tests it uses the installed Chrome; XXSV_E2E_BROWSER=chromium
// uses Playwright's Chromium instead.
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "xxsv-shot-"));
const bin = join(dir, "xxsv");
execFileSync("go", ["build", "-o", bin, "./cmd/xxsv"], { cwd: root, stdio: "inherit" });

// A small deterministic generator, so the picture is the same every time.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const countries = ["JP", "US", "DE", "FR", "GB", "BR", "IN", "CA"];
const products = ["Keyboard", "Mouse", "Monitor", "Cable", "Dock", "Headset", "Webcam", "Stand"];
const statuses = ["shipped", "shipped", "shipped", "delivered", "delivered", "pending", "returned"];
const lines = ["order_id,ordered_at,customer,country,product,qty,unit_price,amount,status"];
for (let i = 0; i < 2400; i++) {
  const qty = 1 + Math.floor(rand() * 8);
  const price = Math.round((5 + rand() * 400) * 100) / 100;
  const day = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 300) * 86400000 + Math.floor(rand() * 86400) * 1000);
  const customer = `cust-${String(1000 + Math.floor(rand() * 900))}`;
  const country = rand() < 0.04 ? "" : pick(countries);
  lines.push([10001 + i, day.toISOString().slice(0, 19).replace("T", " "), customer, country, pick(products), qty, price.toFixed(2), (qty * price).toFixed(2), pick(statuses)].join(","));
}
const csv = join(dir, "orders.csv");
writeFileSync(csv, lines.join("\n") + "\n");

const xxsv = spawn(bin, ["--no-open", "-p", "0", csv], { stdio: ["ignore", "ignore", "pipe"] });
const url = await new Promise<string>((ok, fail) => {
  let err = "";
  xxsv.stderr!.on("data", (b: Buffer) => {
    err += b.toString();
    const m = /at (http:\/\/\S+)/.exec(err);
    if (m) ok(m[1]);
  });
  xxsv.on("exit", (code) => fail(new Error(`xxsv exited with ${code}: ${err}`)));
});

const browser = await chromium.launch({ channel: process.env.XXSV_E2E_BROWSER === "chromium" ? undefined : "chrome" });
try {
  for (const scheme of ["light", "dark"] as const) await shoot(scheme);
} finally {
  await browser.close();
  xxsv.kill();
}

async function shoot(scheme: "light" | "dark") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, colorScheme: scheme });
  await page.goto(url);
  await page.locator("#rows .row:not(.loading)").first().waitFor();
  const cell = (r: number, c: number) => page.locator(`#rows [data-r="${r}"][data-c="${c}"]`);
  await cell(2, 7).click();
  await cell(9, 7).click({ modifiers: ["Shift"] });
  await page.locator("#agg b").first().waitFor();
  await page.locator('[data-prof="3"]').click();
  await page.locator("#colpop").waitFor();
  await page.mouse.move(1200, 700); // no hover marks
  const out = join(root, "docs", `screenshot-${scheme}.png`);
  await page.screenshot({ path: out });
  console.log("wrote", out);
  await page.close();
}
