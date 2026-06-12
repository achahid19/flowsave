/**
 * flowsave delete <id> [id...]
 *
 * Permanently removes one or more snapshots from disk and from the local index.
 * Shows a list of what will be deleted and prompts once for confirmation.
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
    .command('delete <ids...>')
    .description('Permanently delete one or more snapshots from disk')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (ids: string[], opts: { yes?: boolean }) => {
      const config = loadConfigOrExit();

      // Parse and validate all IDs
      const parsed: number[] = [];
      for (const raw of ids) {
        const n = parseInt(raw, 10);
        if (isNaN(n)) {
          console.error(chalk.red(`✗ Invalid snapshot ID: "${raw}". Must be an integer.`));
          process.exit(1);
        }
        parsed.push(n);
      }

      // Deduplicate
      const unique = [...new Set(parsed)];

      // Look up each in the index
      const allSnapshots = listSnapshots();
      const toDelete = [];
      const missing = [];

      for (const id of unique) {
        const entry = allSnapshots.find((s) => s.id === id);
        if (entry) {
          toDelete.push(entry);
        } else {
          missing.push(id);
        }
      }

      if (missing.length > 0) {
        for (const id of missing) {
          console.error(chalk.red(`✗ Snapshot ${id} not found.`));
        }
        if (toDelete.length === 0) {
          console.error(chalk.gray('  Run "flowsave list" to see available snapshots.'));
          process.exit(1);
        }
      }

      if (toDelete.length === 0) {
        process.exit(1);
      }

      // Confirmation
      if (!opts.yes) {
        console.log(chalk.yellow(`\n  The following snapshot${toDelete.length > 1 ? 's' : ''} will be permanently deleted:\n`));
        for (const e of toDelete) {
          console.log(chalk.gray(`    #${String(e.id).padEnd(4)} ${formatDate(e.timestamp).padEnd(28)} ${formatBytes(e.sizeBytes)}`));
        }
        console.log('');

        const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
          {
            type: 'confirm',
            name: 'confirmed',
            message: `Delete ${toDelete.length} snapshot${toDelete.length > 1 ? 's' : ''}?`,
            default: false,
          },
        ]);

        if (!confirmed) {
          console.log(chalk.gray('Aborted. No snapshots deleted.'));
          return;
        }
      }

      // Delete all
      let deletedCount = 0;
      let failedCount = 0;
      for (const entry of toDelete) {
        try {
          deleteSnapshot(entry.id, config);
          console.log(chalk.green(`✓ Snapshot ${entry.id} deleted.`));
          deletedCount++;
        } catch (err) {
          failedCount++;
          if (err instanceof DeleteError) {
            console.error(chalk.red(`✗ ${err.message}`));
          } else {
            handleError(err);
          }
        }
      }

      if (deletedCount > 1) {
        console.log(chalk.bold(`\n  ${deletedCount} snapshots deleted.`));
      }

      // Exit 1 when any requested ID was not deleted (partial failure or missing IDs)
      // so scripts can detect the problem.
      if (failedCount > 0 || missing.length > 0) {
        process.exit(1);
      }
    });
}
