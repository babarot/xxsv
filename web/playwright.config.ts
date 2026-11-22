// E2E tests: each test starts the real xxsv binary on a file of its own and
// drives the page in a browser. `npm run e2e` builds the UI and the binary
// first (e2e/global-setup.ts), so the tests always run the current web/src.
//
// The browser is the installed Google Chrome, so nothing is downloaded. Set
// XXSV_E2E_BROWSER=chromium to use Playwright's own Chromium instead (after
// `npx playwright install chromium`), as a CI would.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  // The Mac this runs on is often busy; keep the workers few and the
  // timeouts generous rather than flaky.
  workers: 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    channel: process.env.XXSV_E2E_BROWSER === "chromium" ? undefined : "chrome",
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
});
