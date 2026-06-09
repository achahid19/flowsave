/**
 * flowsave migrate --to <url> --api-key <key>
 *
 * Two-step operation: backup source → restore to destination (forceCreate).
 * Delegates entirely to core.migrate().
 *
 * --to and --api-key are both required. If source instance has credentials
 * configured (containerName), prompts for a passphrase to encrypt+decrypt.
 */

import ora from 'ora';
import inquirer from 'inquirer';
import chalk from 'chalk';
import type { Command } from 'commander';
import { migrate } from '@flowsave/core';
import { loadConfigOrExit } from '../utils/config';
import { handleError } from '../utils/errors';

export function register(program: Command): void {
  program
    .command('migrate')
    .description('Migrate all workflows from source to a new n8n instance')
    .requiredOption('--to <url>', 'Destination n8n instance URL')
    .requiredOption('--api-key <key>', 'Destination n8n API key')
    .option('--passphrase <key>', 'Passphrase for credential migration')
    .action(async (opts: { to: string; apiKey: string; passphrase?: string }) => {
      const config = loadConfigOrExit();

      let passphrase = opts.passphrase;
      if (!passphrase && config.containerName) {
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
          passphrase,
        });

        clearTimeout(labelTimer);
        const count = snapshot.meta.workflowCount;
        spinner.succeed(
          chalk.green(
            `✓ Migration complete — Snapshot ID: ${snapshot.id}, ` +
            `${count} workflow${count !== 1 ? 's' : ''} migrated to ${opts.to}`
          )
        );
      } catch (err) {
        clearTimeout(labelTimer);
        handleError(err, spinner);
      }
    });
}
