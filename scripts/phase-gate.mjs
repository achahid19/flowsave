#!/usr/bin/env node
/**
 * Flowsave Phase Gate
 *
 * Run before marking any phase as done: pnpm phase:done
 *
 * Checks:
 *   1. pnpm build       — zero TypeScript errors
 *   2. pnpm test        — all tests pass
 *   3. pnpm lint        — zero lint errors
 *   4. pnpm audit       — zero high/critical vulnerabilities
 *
 * All checks must pass. Any failure blocks phase completion.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync } from "fs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function run(cmd) {
  try {
    execSync(cmd, { stdio: "pipe" });
    return { passed: true, output: "" };
  } catch (err) {
    const output = err.stdout?.toString() || err.stderr?.toString() || "";
    return { passed: false, output };
  }
}

console.log(`\n${BOLD}Flowsave Phase Gate${RESET}`);
console.log("Running all checks — every one must pass before marking phase done.\n");

// Sanity check — ensure deps are installed
if (!existsSync("node_modules")) {
  console.log(`${RED}✗ node_modules not found. Run pnpm install first.${RESET}\n`);
  process.exit(1);
}

const CHECKS = [
  { label: "Build (TypeScript)", cmd: "pnpm build" },
  { label: "Tests", cmd: "pnpm test" },
  { label: "Lint", cmd: "pnpm lint" },
  { label: "Security audit", cmd: "pnpm audit --audit-level=high" },
];

const results = [];

for (const check of CHECKS) {
  process.stdout.write(`  ${YELLOW}→${RESET} ${check.label} ... `);
  const { passed, output } = run(check.cmd);

  if (passed) {
    console.log(`${GREEN}✓ passed${RESET}`);
  } else {
    console.log(`${RED}✗ failed${RESET}`);
    if (output) {
      console.log(
        output
          .split("\n")
          .slice(0, 30) // cap output — don't flood the terminal
          .map((l) => `      ${l}`)
          .join("\n")
      );
    }
  }

  results.push({ ...check, passed });
}

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;

console.log(`\n${BOLD}Results: ${passed}/${results.length} checks passed${RESET}`);

if (failed > 0) {
  console.log(
    `\n${RED}${BOLD}✗ Phase gate failed.${RESET} Fix the ${failed} failing check(s) above before marking this phase done.\n`
  );
  process.exit(1);
} else {
  console.log(
    `\n${GREEN}${BOLD}✓ All checks passed.${RESET} Safe to mark this phase done in PHASES.md.\n`
  );
  process.exit(0);
}
