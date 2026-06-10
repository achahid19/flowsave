/**
 * flowsave backup
 *
 * Snapshots workflows, folder structure, and (optionally) credentials
 * from the configured n8n instance.
 *
 * If a Docker container is configured, prompts for a passphrase to encrypt
 * the credentials bundle. The passphrase never leaves the local machine.
 */

import ora from 'ora';
import inquirer from 'inquirer';
import chalk from 'chalk';
import type { Command } from 'commander';
import { backup } from '@flowsave/core';
import { loadConfigOrExit } from '../utils/config';
import { handleError } from '../utils/errors';
import { formatBytes } from '../utils/format';

export function register(program: Command): void {
  program
    .command('backup')
    .description('Snapshot workflows and credentials from your n8n instance')
    .action(async () => {
      const config = loadConfigOrExit();

      // Prompt for passphrase only when credential backup is possible
      let passphrase: string | undefined;
      if (config.containerName) {
        const { pass } = await inquirer.prompt<{ pass: string }>([
          {
            type: 'password',
            name: 'pass',
            message: `Passphrase to encrypt credentials for container "${config.containerName}" (leave blank to skip):`,
            mask: '*',
          },
        ]);
        passphrase = pass.trim() || undefined;
      }

      const spinner = ora(`Connecting to ${config.instanceUrl}...`).start();

      try {
        spinner.text = 'Fetching workflows...';
        const snapshot = await backup({ config, passphrase });
        spinner.succeed(chalk.green('✓ Backup complete'));

        // ── Full summary ────────────────────────────────────────────────────
        const m = snapshot.meta;
        console.log(chalk.bold('\n  Snapshot Summary'));
        console.log(chalk.gray('  ' + '─'.repeat(44)));
        console.log(`  ${chalk.cyan('Snapshot ID'.padEnd(20))} ${chalk.white(String(m.snapshotId))}`);
        console.log(`  ${chalk.cyan('Instance'.padEnd(20))} ${chalk.white(m.instanceUrl)}`);
        if (m.n8nVersion) {
          console.log(`  ${chalk.cyan('n8n version'.padEnd(20))} ${chalk.white(m.n8nVersion)}`);
        }
        console.log(`  ${chalk.cyan('Timestamp'.padEnd(20))} ${chalk.white(new Date(m.timestamp).toLocaleString())}`);
        console.log(`  ${chalk.cyan('Workflows'.padEnd(20))} ${chalk.white(String(m.workflowCount))}`);
        console.log(`  ${chalk.cyan('Folder structure'.padEnd(20))} ${
          m.folderStructureIncluded
            ? chalk.green('✓ included')
            : chalk.yellow('✗ not included')
        }`);
        console.log(`  ${chalk.cyan('Credentials'.padEnd(20))} ${
          m.credentialsIncluded
            ? chalk.green('✓ encrypted & included')
            : chalk.gray('— not included')
        }`);
        console.log(`  ${chalk.cyan('Snapshot size'.padEnd(20))} ${chalk.white(formatBytes(m.sizeBytes ?? 0))}`);
        console.log(`  ${chalk.cyan('Saved to'.padEnd(20))} ${chalk.white(snapshot.snapshotPath)}`);

        // ── Notices ─────────────────────────────────────────────────────────
        if (!m.folderStructureIncluded) {
          console.log(
            chalk.yellow('\n  ⚠  Folder structure was NOT backed up.\n') +
            chalk.gray(
              '     n8n\'s folder API requires an Enterprise license.\n' +
              '     Your workflows are fully backed up and restorable,\n' +
              '     but subdirectory layout is not preserved.\n' +
              '     → Upgrade to n8n Enterprise to enable folder-aware backups.'
            )
          );
        }

        if (!m.credentialsIncluded && config.containerName) {
          console.log(
            chalk.gray('\n  ℹ  Credentials were skipped (no passphrase entered).')
          );
        }

        if (!config.containerName) {
          console.log(
            chalk.gray(
              '\n  ℹ  Credential backup is disabled.\n' +
              '     Set a Docker container name in your config to enable it:\n' +
              '     flowsave config set containerName <your-n8n-container>'
            )
          );
        }

        console.log('');
      } catch (err) {
        handleError(err, spinner);
      }
    });
}
