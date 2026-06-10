/**
 * flowsave migrate --to <url> --api-key <key>
 *
 * Two-step operation: backup source → restore to destination (forceCreate).
 * Delegates entirely to core.migrate().
 *
 * Credentials are imported via the n8n REST API by default (no Docker required
 * on the destination). Use --target-container if the destination container is
 * accessible locally — that path handles OAuth credentials without schema limits.
 *
 * Shows a full summary after migration with folder structure status, per-credential
 * import detail, and any non-fatal warnings from both steps (backup and restore).
 */

import ora from 'ora';
import inquirer from 'inquirer';
import chalk from 'chalk';
import type { Command } from 'commander';
import { migrate } from '@flowsave/core';
import { loadConfigOrExit } from '../utils/config';
import { handleError } from '../utils/errors';
import { formatBytes } from '../utils/format';
import { printCredentialImportDetail } from './restore';

export function register(program: Command): void {
  program
    .command('migrate')
    .description('Migrate all workflows from source to a new n8n instance')
    .requiredOption('--to <url>', 'Destination n8n instance URL')
    .requiredOption('--api-key <key>', 'Destination n8n API key')
    .option(
      '--target-container <name>',
      'Docker container on this machine for credential import (handles OAuth and all types)'
    )
    .option('--passphrase <key>', 'Passphrase for credential migration')
    .action(async (opts: { to: string; apiKey: string; targetContainer?: string; passphrase?: string }) => {
      const config = loadConfigOrExit();

      // Always prompt for passphrase — migrate always attempts credentials
      // (either via docker on the source for backup, or via API for restore)
      let passphrase = opts.passphrase;
      if (!passphrase) {
        const { pass } = await inquirer.prompt<{ pass: string }>([
          {
            type: 'password',
            name: 'pass',
            message: 'Passphrase for credential migration (leave blank to skip credentials):',
            mask: '*',
          },
        ]);
        passphrase = pass.trim() || undefined;
      }

      const spinner = ora('Step 1/2: Backing up source instance...').start();

      // Switch spinner label partway through — core doesn't emit events yet,
      // so we approximate the boundary with a short timeout.
      const labelTimer = setTimeout(() => {
        if (spinner.isSpinning) {
          spinner.text = 'Step 2/2: Restoring to destination instance...';
        }
      }, 800);

      try {
        const snapshot = await migrate({
          config,
          targetUrl: opts.to,
          targetApiKey: opts.apiKey,
          targetContainerName: opts.targetContainer,
          passphrase,
        });

        clearTimeout(labelTimer);
        spinner.succeed(chalk.green('✓ Migration complete'));

        // ── Summary table ─────────────────────────────────────────────────────
        const m = snapshot.meta;
        const count = m.workflowCount;
        const results = snapshot.credentialImportResults;
        const apiSucceeded = results ? results.filter((r) => r.success).length : 0;
        const apiTotal     = results ? results.length : 0;

        console.log(chalk.bold('\n  Migration Summary'));
        console.log(chalk.gray('  ' + '─'.repeat(44)));
        console.log(`  ${chalk.cyan('Snapshot ID'.padEnd(22))} ${chalk.white(String(snapshot.id))}`);
        console.log(`  ${chalk.cyan('Source instance'.padEnd(22))} ${chalk.white(m.instanceUrl)}`);
        console.log(`  ${chalk.cyan('Destination'.padEnd(22))} ${chalk.white(opts.to)}`);
        console.log(`  ${chalk.cyan('n8n version (source)'.padEnd(22))} ${chalk.white(m.n8nVersion)}`);
        console.log(`  ${chalk.cyan('Workflows migrated'.padEnd(22))} ${chalk.white(String(count))}`);
        console.log(`  ${chalk.cyan('Snapshot size'.padEnd(22))} ${chalk.white(formatBytes(m.sizeBytes ?? 0))}`);

        // Folder — backup side
        console.log(`  ${chalk.cyan('Folder backup'.padEnd(22))} ${
          m.folderStructureIncluded
            ? chalk.green('✓ included in snapshot')
            : chalk.yellow('✗ not included (source: community edition)')
        }`);

        // Folder — restore side
        if (m.folderStructureIncluded) {
          console.log(`  ${chalk.cyan('Folder restore'.padEnd(22))} ${
            snapshot.folderStructureRestored
              ? chalk.green('✓ recreated on destination')
              : chalk.yellow('✗ not recreated (destination may lack Enterprise)')
          }`);
        }

        // Credentials — different label per path taken
        let credLabel: string;
        if (results) {
          credLabel = apiSucceeded === apiTotal
            ? chalk.green(`✓ ${apiSucceeded}/${apiTotal} migrated via API`)
            : chalk.yellow(`⚠ ${apiSucceeded}/${apiTotal} migrated via API (${apiTotal - apiSucceeded} failed)`);
        } else if (snapshot.credentialsIncluded) {
          credLabel = chalk.green('✓ migrated (docker)');
        } else if (m.credentialsIncluded) {
          credLabel = chalk.gray('— skipped (no passphrase or container not configured)');
        } else {
          credLabel = chalk.gray('— no credentials in snapshot');
        }
        console.log(`  ${chalk.cyan('Credentials'.padEnd(22))} ${credLabel}`);

        // ── Per-credential detail (API path) ──────────────────────────────────
        if (results && results.length > 0) {
          printCredentialImportDetail(results);
        }

        // ── Notices ───────────────────────────────────────────────────────────
        if (!m.folderStructureIncluded) {
          console.log(
            chalk.yellow('\n  ⚠  Folder structure was NOT backed up from the source.\n') +
            chalk.gray(
              '     The source is running community edition — the folder API\n' +
              '     requires an Enterprise license. Workflows were migrated flat\n' +
              '     (all at root level).\n' +
              '     → Upgrade to n8n Enterprise on both instances for folder-aware migration.'
            )
          );
        } else if (m.folderStructureIncluded && !snapshot.folderStructureRestored) {
          console.log(
            chalk.yellow('\n  ⚠  Folder structure could not be recreated on the destination.\n') +
            chalk.gray(
              '     The source snapshot includes folder layout, but the destination\n' +
              '     instance rejected folder creation. All workflows were placed at\n' +
              '     the root level on the destination.\n' +
              '     → Upgrade the destination to n8n Enterprise to restore folder layout.'
            )
          );
        }

        if (!snapshot.credentialsIncluded && !results) {
          // Credentials were skipped entirely (no passphrase or source has no container)
          if (config.containerName && !passphrase) {
            console.log(
              chalk.gray('\n  ℹ  Credentials were skipped (no passphrase entered).')
            );
          } else if (!config.containerName) {
            console.log(
              chalk.gray(
                '\n  ℹ  Credential migration requires a Docker container on the source.\n' +
                '     Set the source container name in your config to enable credential backup:\n' +
                '     flowsave config set containerName <your-n8n-container>'
              )
            );
          }
        }

        // ── Duplicate notice ─────────────────────────────────────────────────
        console.log(
          chalk.gray(
            '\n  ℹ  Each migration creates new workflows on the destination.\n' +
            '     Re-running this command will create duplicates — existing workflows\n' +
            '     on the destination are never updated or replaced.\n' +
            '     → Use "flowsave diff" to compare snapshots before migrating again.'
          )
        );

        // ── Non-fatal warnings ────────────────────────────────────────────────
        // Filter out per-credential failures — already shown in the detail block.
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
        clearTimeout(labelTimer);
        handleError(err, spinner);
      }
    });
}
