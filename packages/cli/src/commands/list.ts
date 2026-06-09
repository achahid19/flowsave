/**
 * flowsave list
 *
 * Displays all local snapshots in a table sorted by ID descending (newest first).
 * Reads from ~/.flowsave/index.json via listSnapshots() — no API calls.
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import type { Command } from 'commander';
import { listSnapshots } from '@flowsave/core';
import { formatBytes, formatDate } from '../utils/format';

export function register(program: Command): void {
  program
    .command('list')
    .description('List all local snapshots')
    .action(() => {
      const snapshots = listSnapshots();

      if (snapshots.length === 0) {
        console.log(chalk.yellow("No snapshots yet. Run 'flowsave backup' to take your first snapshot."));
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan('ID'),
          chalk.cyan('Timestamp'),
          chalk.cyan('Size'),
          chalk.cyan('Instance URL'),
        ],
        style: { head: [], border: [] },
      });

      // Newest first
      const sorted = [...snapshots].sort((a, b) => b.id - a.id);

      for (const snap of sorted) {
        const url =
          snap.instanceUrl.length > 40
            ? snap.instanceUrl.slice(0, 37) + '...'
            : snap.instanceUrl;
        table.push([
          String(snap.id),
          formatDate(snap.timestamp),
          formatBytes(snap.sizeBytes),
          url,
        ]);
      }

      console.log(table.toString());
    });
}
