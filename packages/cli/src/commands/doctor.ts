/**
 * flowsave doctor
 *
 * Runs 4 health checks and prints a summary. Never throws — all issues are
 * reported as ✗ lines. Exits 1 if any check fails.
 */

import { accessSync, constants, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import chalk from 'chalk';
import type { Command } from 'commander';
import { readConfig, ConfigValidationError, expandHome } from '@flowsave/core';

interface CheckResult {
  label: string;
  detail: string;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkConfig(): CheckResult {
  try {
    const config = readConfig();
    return {
      label: 'Config',
      detail: `${config.instanceUrl}`,
      ok: true,
    };
  } catch (err) {
    const msg = err instanceof ConfigValidationError ? err.message : 'Failed to read config';
    return { label: 'Config', detail: msg, ok: false };
  }
}

async function checkInstance(instanceUrl: string, apiKey: string): Promise<CheckResult> {
  try {
    const res = await fetch(`${instanceUrl}/api/v1/workflows?limit=1`, {
      headers: { 'X-N8N-API-KEY': apiKey },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      return { label: 'n8n instance', detail: `${instanceUrl} (reachable)`, ok: true };
    }
    if (res.status === 401) {
      return {
        label: 'n8n instance',
        detail: `${instanceUrl} — connected but API key is invalid (401)`,
        ok: false,
      };
    }
    return {
      label: 'n8n instance',
      detail: `${instanceUrl} — HTTP ${res.status}`,
      ok: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      label: 'n8n instance',
      detail: `${instanceUrl} — ${msg}`,
      ok: false,
    };
  }
}

function checkDocker(containerName: string): CheckResult {
  try {
    const output = execSync(
      `docker ps --filter "name=^/${containerName}$" --format "{{.Names}}"`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();

    if (output === containerName) {
      return { label: 'Docker', detail: `Container '${containerName}' is running`, ok: true };
    }
    return {
      label: 'Docker',
      detail: `Container '${containerName}' not found (is it running?)`,
      ok: false,
    };
  } catch {
    return {
      label: 'Docker',
      detail: 'docker command failed — is Docker installed and running?',
      ok: false,
    };
  }
}

function checkBackupDir(backupDir: string): CheckResult {
  const expanded = expandHome(backupDir);
  try {
    mkdirSync(expanded, { recursive: true });
    accessSync(expanded, constants.W_OK);
    return { label: 'Backup dir', detail: `${expanded} (writable)`, ok: true };
  } catch {
    return {
      label: 'Backup dir',
      detail: `${expanded} — not writable or cannot be created`,
      ok: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('doctor')
    .description('Check your Flowsave configuration and connectivity')
    .action(async () => {
      console.log(chalk.bold('\nFlowsave Doctor'));
      console.log(chalk.gray('─'.repeat(40)));

      const results: CheckResult[] = [];

      // Check 1: config
      const configResult = checkConfig();
      results.push(configResult);

      // If config is bad, subsequent checks are meaningless
      if (!configResult.ok) {
        printResults(results);
        process.exit(1);
      }

      const config = readConfig();

      // Check 2: n8n instance
      results.push(await checkInstance(config.instanceUrl, config.apiKey));

      // Check 3: Docker (only if containerName configured)
      if (config.containerName) {
        results.push(checkDocker(config.containerName));
      }

      // Check 4: backup directory
      results.push(checkBackupDir(config.backupDir));

      printResults(results);

      const failures = results.filter((r) => !r.ok).length;
      if (failures > 0) {
        console.log(chalk.red(`\n${failures} issue${failures !== 1 ? 's' : ''} found. See above for details.`));
        process.exit(1);
      } else {
        console.log(chalk.green('\n✓ All checks passed. Ready to backup.'));
      }
    });
}

function printResults(results: CheckResult[]): void {
  const labelWidth = Math.max(...results.map((r) => r.label.length)) + 2;
  for (const r of results) {
    const icon = r.ok ? chalk.green('✓') : chalk.red('✗');
    const label = r.label.padEnd(labelWidth);
    const detail = r.ok ? chalk.white(r.detail) : chalk.red(r.detail);
    console.log(`${icon}  ${chalk.cyan(label)} ${detail}`);
  }
}
