/**
 * flowsave delete <id>
 *
 * Permanently removes a single snapshot from disk and from the local index.
 * Prompts for confirmation before deleting.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import type { Command } from 'commander';
import { deleteSnapshot, DeleteError, listSnapshots } from '@flowsave/core';
import { loadConfigOrExit } from '../utils/config';
import { handleError } from '../utils/errors';
import { formatBytes, formatDate } from '../utils/format';

export function register(program: Command): void {
  program
    .command('delete <id>')
    .description('Permanently delete a snapshot from disk')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }) => {
      const config = loadConfigOrExit();

      const snapshotId = parseInt(id, 10);
      if (isNaN(snapshotId)) {
        console.error(chalk.red(`✗ Invalid snapshot ID: "${id}". Must be an integer.`));
        process.exit(1);
      }

      // Look up snapshot details for the confirmation message
      const entry = listSnapshots().find((s) => s.id === snapshotId);
      if (!entry) {
        console.error(chalk.red(`✗ Snapshot ${snapshotId} not found.`));
        console.error(chalk.gray('  Run "flowsave list" to see available snapshots.'));
        process.exit(1);
      }

      const detail = `#${entry.id}  ${formatDate(entry.timestamp)}  ${formatBytes(entry.sizeBytes)}`;

      if (!opts.yes) {
        const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
          {
            type: 'confirm',
            name: 'confirmed',
            message: `Delete snapshot ${detail}?`,
            default: false,
          },
        ]);
        if (!confirmed) {
          console.log(chalk.gray('Aborted. Snapshot unchanged.'));
          return;
        }
      }

      try {
        deleteSnapshot(snapshotId, config);
        console.log(chalk.green(`✓ Snapshot ${snapshotId} deleted.`));
      } catch (err) {
        if (err instanceof DeleteError) {
          console.error(chalk.red(`✗ ${err.message}`));
          process.exit(1);
        }
        handleError(err);
      }
    });
}
