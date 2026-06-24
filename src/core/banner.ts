import { existsSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "./config";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

const PKG_VERSION: string = (() => {
  try {
    // Safe to use import.meta.dir here — this looks up njin's OWN version,
    // not anything project-specific (unlike view.ts's views lookup).
    return (require(join(import.meta.dir, "../../package.json")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

export type BootSummary = {
  mode: "development" | "production";
};

// Printed once boot finishes — plain console.log (not pino) on purpose: this is a
// human-facing startup summary, not a structured log line.
export const printBanner = ({ mode }: BootSummary): void => {
  const config = getConfig();
  const port = config.port;
  const adminEntry = join(process.cwd(), "_admin", "index.html");
  const hasAdmin = existsSync(adminEntry);

  const rows: [string, string][] = [
    ["Local", `http://localhost:${port}`],
    ["Database", `${config.db.path} ${c.dim}(${config.db.namespace}/${config.db.database})${c.reset}`],
    ["Models", `${config.models.length} registered`],
    hasAdmin ? ["Admin", `http://localhost:${port}/_admin`] : ["Admin", `${c.dim}not found — drop a built admin panel into /_admin${c.reset}`],
  ];

  const label = (text: string) => `${c.dim}${text.padEnd(9)}${c.reset}`;

  const lines = [
    "",
    `  ${c.bold}${c.cyan}njin${c.reset} ${c.dim}v${PKG_VERSION}${c.reset}  ${mode === "production" ? c.green : c.yellow}${mode}${c.reset}`,
    "",
    ...rows.map(([key, value]) => `  ${c.green}➜${c.reset}  ${label(key)} ${value}`),
    "",
  ];

  console.log(lines.join("\n"));
};
