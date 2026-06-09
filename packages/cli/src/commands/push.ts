/**
 * flowsave push
 *
 * Pushes the latest local snapshot to the configured Git remote.
 * Requires gitRemote to be set in config (flowsave config init).
 */

import { join } from 'path';
import ora from 'ora';
import chalk from 'chalk';
import type { Command } from 'commander';
import { pushToGit, listSnapshots } from '@flowsave/core';
import { loadConfigOrExit } from '../utils/config';
import { handleError } from '../utils/errors';

export function register(program: Command): void {
  program
    .command('push')
    .description('Push the latest snapshot to the configured Git remote')
    .action(async () => {
      const config = loadConfigOrExit();

      if (!config.gitRemote) {
        console.error(chalk.red('✗ No gitRemote configured.'));
        console.error(chalk.gray("  Add one with 'flowsave config init' or edit ~/.flowsave/config.json."));
        process.exit(1);
      }

      const snapshots = listSnapshots();
      if (snapshots.length === 0) {
        console.error(chalk.red("✗ No snapshots to push. Run 'flowsave backup' first."));
        process.exit(1);
      }

      // Newest snapshot (index.json is appended — last entry is newest)
      const latest = snapshots[snapshots.length - 1];
      const snapshotPath = join(config.backupDir, String(latest.id));
      const branch = config.gitBranch ?? 'main';

      const spinner = ora(`Pushing to ${config.gitRemote}...`).start();

      try {
        await pushToGit(snapshotPath, config.gitRemote, branch);
        spinner.succeed(
          chalk.green(`✓ Pushed snapshot ${latest.id} to ${config.gitRemote} (${branch})`)
        );
      } catch (err) {
        handleError(err, spinner);
      }
    });
}
