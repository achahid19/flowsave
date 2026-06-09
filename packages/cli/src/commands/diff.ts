/**
 * flowsave diff <id1> <id2>
 *
 * Compares two local snapshots and renders a colored diff to stdout.
 * Purely local — no API calls.
 */

import chalk from 'chalk';
import type { Command } from 'commander';
import { diff } from '@flowsave/core';
import { loadConfigOrExit } from '../utils/config';
import { renderDiff } from '../utils/format';
import { handleError } from '../utils/errors';

export function register(program: Command): void {
  program
    .command('diff <id1> <id2>')
    .description('Show differences between two snapshots')
    .action((id1: string, id2: string) => {
      const config = loadConfigOrExit();

      const snapA = parseInt(id1, 10);
      const snapB = parseInt(id2, 10);

      if (isNaN(snapA) || isNaN(snapB)) {
        console.error(chalk.red('✗ Both arguments must be integer snapshot IDs.'));
        process.exit(1);
      }

      try {
        const result = diff(snapA, snapB, config);
        console.log(`\nDiff: snapshot ${snapA} → ${snapB}\n`);
        console.log(renderDiff(result));
      } catch (err) {
        handleError(err);
      }
    });
}
