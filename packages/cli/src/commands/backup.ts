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
            message: 'Passphrase to encrypt credentials (leave blank to skip credentials):',
            mask: '*',
          },
        ]);
        passphrase = pass.trim() || undefined;
      }

      const spinner = ora('Backing up workflows...').start();

      try {
        const snapshot = await backup({ config, passphrase });
        spinner.succeed(
          chalk.green(
            `✓ Backup complete — Snapshot ID: ${snapshot.id} ` +
            `(${snapshot.meta.workflowCount} workflow${snapshot.meta.workflowCount !== 1 ? 's' : ''}` +
            `${snapshot.credentialsIncluded ? ', credentials included' : ''})`
          )
        );
      } catch (err) {
        handleError(err, spinner);
      }
    });
}
