// Builds the UI into internal/server/ui/dist and then the xxsv binary, which
// embeds dist. Building only the binary would test the UI from the last
// build instead of web/src. Either failure stops the run.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export default function globalSetup() {
  const web = resolve(import.meta.dirname, "..");
  execFileSync("npm", ["run", "build"], { cwd: web, stdio: "inherit" });
  const bin = join(mkdtempSync(join(tmpdir(), "xxsv-e2e-")), "xxsv");
  execFileSync("go", ["build", "-o", bin, "./cmd/xxsv"], { cwd: resolve(web, ".."), stdio: "inherit" });
  process.env.XXSV_E2E_BIN = bin;
}
