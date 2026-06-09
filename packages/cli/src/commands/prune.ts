/**
 * flowsave prune [--dry-run]
 *
 * Scans all local snapshots and removes any that are identical in workflow
 * content to a newer snapshot. Keeps the most recent snapshot of each
 * distinct state. Prompts for confirmation before deleting.
 *
 * Use --dry-run to see what would be removed without deleting anything.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import type { Command } from 'commander';
import { pruneSnapshots, listSnapshots } from '@flowsave/core';
import { loadConfigOrExit } from '../utils/config';
import { handleError } from '../utils/errors';
import { formatBytes, formatDate } from '../utils/format';

export function register(program: Command): void {
  program
    .command('prune')
    .description('Remove snapshots whose content is identical to a newer snapshot')
    .option('--dry-run', 'Show what would be removed without deleting anything')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (opts: { dryRun?: boolean; yes?: boolean }) => {
      const config = loadConfigOrExit();

      const total = listSnapshots().length;
      if (total < 2) {
        console.log(chalk.gray(`Nothing to prune — only ${total} snapshot${total === 1 ? '' : 's'} found.`));
        return;
      }

      console.log(chalk.gray(`Scanning ${total} snapshots for identical content...`));

      try {
        // Always do a dry run first to show the user what would happen
        const preview = pruneSnapshots(config, true);

        if (preview.removed.length === 0) {
          console.log(chalk.green('✓ All snapshots are distinct — nothing to prune.'));
          return;
        }

        // Show what will be removed
        console.log(chalk.yellow(`\n  Found ${preview.removed.length} redundant snapshot${preview.removed.length !== 1 ? 's' : ''}:`));
        console.log(chalk.gray('  ' + '─'.repeat(52)));
        for (const c of preview.removed.sort((a, b) => a.id - b.id)) {
          console.log(
            `  ${chalk.gray('#' + String(c.id).padEnd(4))}` +
            `  ${chalk.white(formatDate(c.timestamp).padEnd(22))}` +
            `  ${chalk.gray(formatBytes(c.sizeBytes).padEnd(10))}` +
            `  ${chalk.gray('≡ #' + c.identicalTo)}`
          );
        }
        console.log(chalk.gray('  ' + '─'.repeat(52)));
        console.log(`  ${chalk.cyan('Space freed'.padEnd(24))} ${chalk.white(formatBytes(preview.bytesFreed))}`);
        console.log(`  ${chalk.cyan('Snapshots kept'.padEnd(24))} ${chalk.white(String(preview.kept.length))}`);

        if (opts.dryRun) {
          console.log(chalk.gray('\n  Dry run — nothing deleted. Remove --dry-run to apply.'));
          return;
        }

        // Confirm before deleting
        if (!opts.yes) {
          const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
            {
              type: 'confirm',
              name: 'confirmed',
              message: `Delete ${preview.removed.length} snapshot${preview.removed.length !== 1 ? 's' : ''}?`,
              default: false,
            },
          ]);
          if (!confirmed) {
            console.log(chalk.gray('\nAborted. No snapshots deleted.'));
            return;
          }
        }

        // Execute the prune
        pruneSnapshots(config, false);
        console.log(
          chalk.green(
            `\n✓ Pruned ${preview.removed.length} snapshot${preview.removed.length !== 1 ? 's' : ''}.` +
            `  ${preview.kept.length} kept.` +
            `  ${formatBytes(preview.bytesFreed)} freed.`
          )
        );
      } catch (err) {
        handleError(err);
      }
    });
}
