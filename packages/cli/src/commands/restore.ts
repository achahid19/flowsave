/**
 * flowsave restore --snap <id>
 *
 * Restores a local snapshot to the configured n8n instance (same-instance mode)
 * or to a different instance (--to / --api-key flags, cross-instance mode).
 *
 * Cross-instance restore always uses forceCreate=true (never updates by ID).
 */

import ora from 'ora';
import inquirer from 'inquirer';
import chalk from 'chalk';
import type { Command } from 'commander';
import { restore } from '@flowsave/core';
import { loadConfigOrExit } from '../utils/config';
import { handleError } from '../utils/errors';

export function register(program: Command): void {
  program
    .command('restore')
    .description('Restore a snapshot to an n8n instance')
    .requiredOption('--snap <id>', 'Snapshot ID to restore (see "flowsave list")')
    .option('--to <url>', 'Target instance URL for cross-instance restore')
    .option('--api-key <key>', 'Target instance API key for cross-instance restore')
    .option('--passphrase <key>', 'Passphrase to decrypt credentials')
    .action(async (opts: { snap: string; to?: string; apiKey?: string; passphrase?: string }) => {
      const config = loadConfigOrExit();
      const snapshotId = parseInt(opts.snap, 10);

      if (isNaN(snapshotId)) {
        console.error(chalk.red(`✗ Invalid snapshot ID: "${opts.snap}". Must be an integer.`));
        process.exit(1);
      }

      if ((opts.to && !opts.apiKey) || (!opts.to && opts.apiKey)) {
        console.error(chalk.red('✗ --to and --api-key must be used together for cross-instance restore.'));
        process.exit(1);
      }

      // Prompt for passphrase if cross-instance or config has container and no passphrase given
      let passphrase = opts.passphrase;
      if (!passphrase && (opts.to || config.containerName)) {
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

      const spinner = ora(`Restoring snapshot ${snapshotId}...`).start();

      try {
        const snapshot = await restore({
          snapshotId,
          config,
          targetUrl: opts.to,
          targetApiKey: opts.apiKey,
          passphrase,
          forceCreate: opts.to !== undefined,
        });

        const count = snapshot.workflows.length;
        const target = opts.to ?? config.instanceUrl;
        spinner.succeed(
          chalk.green(
            `✓ Restored snapshot ${snapshotId} — ` +
            `${count} workflow${count !== 1 ? 's' : ''} to ${target}`
          )
        );
      } catch (err) {
        handleError(err, spinner);
      }
    });
}
