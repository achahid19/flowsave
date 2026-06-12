/**
 * flowsave restore --snap <id>
 *
 * Restores a local snapshot to the configured n8n instance (same-instance mode)
 * or to a different instance (--to / --api-key flags, cross-instance mode).
 *
 * Cross-instance restore always uses forceCreate=true (never updates by ID).
 * Shows a full summary with folder structure status, credential status, and
 * any non-fatal warnings (folder recreation failures, activation skips, etc.)
 */

import ora from 'ora';
import inquirer from 'inquirer';
import chalk from 'chalk';
import type { Command } from 'commander';
import { restore } from '@flowsave/core';
import { loadConfigOrExit } from '../utils/config';
import { handleError } from '../utils/errors';
import { formatBytes, printCredentialImportDetail } from '../utils/format';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('restore')
    .description('Restore a snapshot to an n8n instance')
    .argument('[id]', 'Snapshot ID to restore — e.g. flowsave restore 3')
    .option('--snap <id>', 'Snapshot ID (alternative to positional argument)')
    .option('--to <url>', 'Target instance URL for cross-instance restore')
    .option('--api-key <key>', 'Target instance API key for cross-instance restore')
    .option(
      '--target-container <name>',
      'Docker container on this machine for cross-instance credential import (handles all types including OAuth)'
    )
    .option('--passphrase <key>', 'Passphrase to decrypt credentials')
    .action(async (id: string | undefined, opts: {
      snap?: string;
      to?: string;
      apiKey?: string;
      targetContainer?: string;
      passphrase?: string;
    }) => {
      const config = loadConfigOrExit();

      const rawId = id ?? opts.snap;
      if (!rawId) {
        console.error(chalk.red('✗ Snapshot ID required. Usage: flowsave restore <id>'));
        console.error(chalk.gray('  Run "flowsave list" to see available snapshots.'));
        process.exit(1);
      }

      const snapshotId = parseInt(rawId, 10);
      if (isNaN(snapshotId)) {
        console.error(chalk.red(`✗ Invalid snapshot ID: "${rawId}". Must be an integer.`));
        process.exit(1);
      }

      if ((opts.to && !opts.apiKey) || (!opts.to && opts.apiKey)) {
        console.error(chalk.red('✗ --to and --api-key must be used together for cross-instance restore.'));
        process.exit(1);
      }

      const isCrossInstance = opts.to !== undefined;

      // Prompt for passphrase when credentials can be restored:
      //   same-instance  → config has a containerName
      //   cross-instance → always prompt (API path doesn't need docker;
      //                    --target-container is optional but passphrase is always needed)
      const snapshotMayHaveCredentials = isCrossInstance || config.containerName !== undefined;
      let passphrase = opts.passphrase;
      if (!passphrase && snapshotMayHaveCredentials) {
        const { pass } = await inquirer.prompt<{ pass: string }>([
          {
            type: 'password',
            name: 'pass',
            message: 'Passphrase for credential decryption (leave blank to skip credentials):',
            mask: '*',
          },
        ]);
        passphrase = pass.trim() || undefined;
      }

      const target = opts.to ?? config.instanceUrl;
      const spinner = ora(`Restoring snapshot ${snapshotId} to ${target}...`).start();

      try {
        const snapshot = await restore({
          snapshotId,
          config,
          targetUrl: opts.to,
          targetApiKey: opts.apiKey,
          targetContainerName: opts.targetContainer,
          passphrase,
          forceCreate: isCrossInstance,
        });

        spinner.succeed(chalk.green('✓ Restore complete'));

        // ── Summary table ─────────────────────────────────────────────────────
        const m = snapshot.meta;
        const count = snapshot.workflows.length;
        const results = snapshot.credentialImportResults;
        const apiSucceeded = results ? results.filter((r) => r.success).length : 0;
        const apiTotal     = results ? results.length : 0;

        console.log(chalk.bold('\n  Restore Summary'));
        console.log(chalk.gray('  ' + '─'.repeat(44)));
        console.log(`  ${chalk.cyan('Snapshot ID'.padEnd(22))} ${chalk.white(String(snapshotId))}`);
        console.log(`  ${chalk.cyan('Source instance'.padEnd(22))} ${chalk.white(m.instanceUrl)}`);
        console.log(`  ${chalk.cyan('Target instance'.padEnd(22))} ${chalk.white(target)}`);
        console.log(`  ${chalk.cyan('Mode'.padEnd(22))} ${chalk.white(
          isCrossInstance ? 'cross-instance (always create)' : 'same-instance (update/create)'
        )}`);
        console.log(`  ${chalk.cyan('Workflows restored'.padEnd(22))} ${chalk.white(String(count))}`);
        console.log(`  ${chalk.cyan('Snapshot size'.padEnd(22))} ${chalk.white(formatBytes(m.sizeBytes ?? 0))}`);

        // Folder structure
        const hadFolders = m.folderStructureIncluded === true;
        if (hadFolders) {
          console.log(`  ${chalk.cyan('Folder structure'.padEnd(22))} ${
            snapshot.folderStructureRestored
              ? chalk.green('✓ recreated on target')
              : chalk.yellow('✗ not recreated (target may lack Enterprise)')
          }`);
        } else {
          console.log(`  ${chalk.cyan('Folder structure'.padEnd(22))} ${chalk.gray('— not in snapshot (community backup)')}`);
        }

        // Credentials — different label per path taken
        let credLabel: string;
        if (results) {
          // API path: show count
          credLabel = apiSucceeded === apiTotal
            ? chalk.green(`✓ ${apiSucceeded}/${apiTotal} imported via API`)
            : chalk.yellow(`⚠ ${apiSucceeded}/${apiTotal} imported via API (${apiTotal - apiSucceeded} failed)`);
        } else if (snapshot.credentialsRestored) {
          // Docker path: all-or-nothing success
          credLabel = chalk.green('✓ decrypted & imported (docker)');
        } else if (m.credentialsIncluded) {
          // Snapshot had credentials but they were not imported
          credLabel = chalk.gray('— skipped (no passphrase or no container)');
        } else {
          credLabel = chalk.gray('— snapshot has no credentials');
        }
        console.log(`  ${chalk.cyan('Credentials'.padEnd(22))} ${credLabel}`);

        // ── Per-credential detail (API path) ──────────────────────────────────
        if (results && results.length > 0) {
          printCredentialImportDetail(results);
        }

        // ── Notices ───────────────────────────────────────────────────────────
        if (hadFolders && !snapshot.folderStructureRestored) {
          console.log(
            chalk.yellow('\n  ⚠  Folder structure could not be recreated on the target instance.\n') +
            chalk.gray(
              '     All workflows were placed at the root level instead.\n' +
              '     If the target is community edition, this is expected — folder\n' +
              '     creation via API requires an Enterprise license.\n' +
              '     → Upgrade the target to n8n Enterprise to restore folder layout.'
            )
          );
        }

        if (isCrossInstance) {
          console.log(
            chalk.gray(
              '\n  ℹ  Cross-instance restore always creates new workflows on the target.\n' +
              '     Re-running this command will create duplicates — existing workflows\n' +
              '     on the target are never updated or replaced.\n' +
              '     → Use "flowsave diff" to compare snapshots before restoring again.'
            )
          );
        }

        // ── Non-fatal warnings ────────────────────────────────────────────────
        // Filter out individual credential failure warnings — those are already
        // shown in the per-credential detail block above.
        const nonCredWarnings = (snapshot.warnings ?? []).filter(
          (w) => !w.startsWith('Credential "') || !w.includes('failed to import via API')
        );
        if (nonCredWarnings.length > 0) {
          console.log(chalk.yellow('\n  ⚠  Non-fatal warnings:'));
          for (const w of nonCredWarnings) {
            console.log(chalk.gray(`     • ${w}`));
          }
        }

        console.log('');
      } catch (err) {
        handleError(err, spinner);
      }
    });
}
