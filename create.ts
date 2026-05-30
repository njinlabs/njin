import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename } from "path";
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = (question: string, fallback?: string): Promise<string> =>
  new Promise((resolve) => {
    const hint = fallback ? ` (${fallback})` : "";
    rl.question(`  ${question}${hint}: `, (answer) => resolve(answer.trim() || fallback || ""));
  });

const cwd = process.cwd();
const defaultName = basename(cwd);

console.log("\n  ┌─────────────────────────────┐");
console.log("  │   njin — project setup      │");
console.log("  └─────────────────────────────┘\n");

const name        = await ask("Project name       ", defaultName);
const description = await ask("Description        ");
const author      = await ask("Author             ");

rl.close();

// Update package.json
const pkgPath = `${cwd}/package.json`;
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

pkg.name    = name;
pkg.version = "0.1.0";

if (description) pkg.description = description;
else delete pkg.description;

if (author) pkg.author = author;

delete pkg.repository;
delete pkg.homepage;
delete pkg.keywords;

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Create .env from .env.example
if (existsSync(`${cwd}/.env.example`) && !existsSync(`${cwd}/.env`)) {
  copyFileSync(`${cwd}/.env.example`, `${cwd}/.env`);
}

// Remove create.ts (not needed in user project)
unlinkSync(`${cwd}/create.ts`);

console.log(`\n  ✓ Project "${name}" is ready.\n`);
console.log(`  Open .env and configure your environment, then:\n`);
console.log(`    bun dev\n`);
