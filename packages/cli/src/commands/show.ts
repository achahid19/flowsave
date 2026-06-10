/**
 * flowsave show <id>
 *
 * Displays full details of a specific local snapshot:
 * metadata (ID, date, instance, n8n version, size, credentials, folder backup)
 * and a table of every workflow (name, active, node count, folder, tags).
 */

import chalk from 'chalk';
import type { Command } from 'commander';
import { readSnapshotDetail, ShowError } from '@flowsave/core';
import { loadConfigOrExit } from '../utils/config';
import { formatBytes, formatDate } from '../utils/format';

/** Pad a plain string to width BEFORE applying chalk color, so ANSI codes don't inflate length. */
function col(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function register(program: Command): void {
  program
    .command('show')
    .description('Show details of a specific snapshot')
    .argument('<id>', 'Snapshot ID — e.g. flowsave show 3')
    .action((rawId: string) => {
      const snapshotId = parseInt(rawId, 10);

      if (isNaN(snapshotId)) {
        console.error(chalk.red(`✗ Invalid snapshot ID: "${rawId}". Must be an integer.`));
        process.exit(1);
      }

      const config = loadConfigOrExit();

      let detail: ReturnType<typeof readSnapshotDetail>;
      try {
        detail = readSnapshotDetail(snapshotId, config);
      } catch (err) {
        if (err instanceof ShowError) {
          console.error(chalk.red(`✗ ${err.message}`));
          process.exit(1);
        }
        throw err;
      }

      const { meta, workflows, hasCredentials, credentialMeta } = detail;

      // ── Header ──────────────────────────────────────────────────────────────
      console.log(chalk.bold(`\n  Snapshot #${snapshotId}`));
      console.log(chalk.gray('  ' + '─'.repeat(52)));
      console.log(`  ${chalk.cyan(col('Date', 24))} ${chalk.white(formatDate(meta.timestamp))}`);
      console.log(`  ${chalk.cyan(col('Instance', 24))} ${chalk.white(meta.instanceUrl)}`);
      if (meta.n8nVersion) {
        console.log(`  ${chalk.cyan(col('n8n version', 24))} ${chalk.white(meta.n8nVersion)}`);
      }
      console.log(`  ${chalk.cyan(col('Workflows', 24))} ${chalk.white(String(workflows.length))}`);
      console.log(`  ${chalk.cyan(col('Size', 24))} ${chalk.white(formatBytes(meta.sizeBytes ?? 0))}`);

      // Credentials — three states
      let credLabel: string;
      if (!hasCredentials) {
        credLabel = chalk.gray('— not included');
      } else if (credentialMeta === null) {
        credLabel = chalk.green('✓ included') + chalk.gray(' (names not available — older snapshot)');
      } else {
        credLabel = chalk.green(`✓ included (${credentialMeta.length} credential${credentialMeta.length !== 1 ? 's' : ''})`);
      }
      console.log(`  ${chalk.cyan(col('Credentials', 24))} ${credLabel}`);

      console.log(`  ${chalk.cyan(col('Folder backup', 24))} ${
        meta.folderStructureIncluded
          ? chalk.green('✓ included')
          : chalk.gray('— not included (community edition)')
      }`);

      // ── Credential table ────────────────────────────────────────────────────
      if (credentialMeta !== null && credentialMeta.length > 0) {
        const sorted = credentialMeta.slice().sort((a, b) => a.name.localeCompare(b.name));

        console.log(chalk.bold(`\n  Credentials (${sorted.length})`));
        console.log(chalk.gray('  ' + '─'.repeat(60)));

        const NAME_MAX = 34;
        const nameWidth = Math.min(NAME_MAX, Math.max(4, ...sorted.map((c) => c.name.length)));

        console.log(
          '  ' +
            chalk.cyan(col('#', 4)) +
            chalk.cyan(col('Name', nameWidth + 2)) +
            chalk.cyan('Type')
        );

        sorted.forEach((cred, i) => {
          const name = cred.name.length > NAME_MAX
            ? cred.name.slice(0, NAME_MAX - 1) + '…'
            : cred.name;
          console.log(
            '  ' +
              chalk.white(col(String(i + 1), 4)) +
              chalk.white(col(name, nameWidth + 2)) +
              chalk.gray(cred.type)
          );
        });

        console.log(chalk.gray('  ' + '─'.repeat(60)));
      }

      if (workflows.length === 0) {
        console.log(chalk.gray('\n  No workflows in this snapshot.\n'));
        return;
      }

      // ── Workflow table ───────────────────────────────────────────────────────
      console.log(chalk.bold(`\n  Workflows (${workflows.length})`));
      console.log(chalk.gray('  ' + '─'.repeat(80)));

      const sorted = workflows.slice().sort((a, b) => a.name.localeCompare(b.name));

      // Compute column widths from data
      const NAME_MAX = 34;
      const nameWidth = Math.min(NAME_MAX, Math.max(4, ...sorted.map((w) => w.name.length)));
      const ACTIVE_W = 8;
      const NODES_W  = 7;
      const FOLDER_MAX = 22;
      const folderWidth = Math.min(
        FOLDER_MAX,
        Math.max(6, ...sorted.map((w) => (w.folderPath.length > 0 ? w.folderPath.join(' / ').length : 1)))
      );

      // Header row — pad plain strings, then color
      console.log(
        '  ' +
          chalk.cyan(col('#', 4)) +
          chalk.cyan(col('Name', nameWidth + 2)) +
          chalk.cyan(col('Active', ACTIVE_W)) +
          chalk.cyan(col('Nodes', NODES_W)) +
          chalk.cyan(col('Folder', folderWidth + 2)) +
          chalk.cyan('Tags')
      );

      sorted.forEach((wf, i) => {
        // Truncate name if needed
        const name = wf.name.length > NAME_MAX
          ? wf.name.slice(0, NAME_MAX - 1) + '…'
          : wf.name;

        // Active — pad the raw symbol BEFORE applying color
        const activeSym = wf.data.active ? '✓' : '✗';
        const activeStr = col(activeSym, ACTIVE_W);
        const activeCol = wf.data.active ? chalk.green(activeStr) : chalk.gray(activeStr);

        // Node count
        const nodeCount = Array.isArray(wf.data.nodes) ? String(wf.data.nodes.length) : '?';

        // Folder
        const folderRaw = wf.folderPath.length > 0 ? wf.folderPath.join(' / ') : '—';
        const folderTrunc = folderRaw.length > FOLDER_MAX
          ? folderRaw.slice(0, FOLDER_MAX - 1) + '…'
          : folderRaw;

        // Tags
        const tagsRaw = wf.data.tags && wf.data.tags.length > 0
          ? wf.data.tags.map((t) => t.name).join(', ')
          : '—';
        const tagsStr = tagsRaw.length > 40 ? tagsRaw.slice(0, 39) + '…' : tagsRaw;

        console.log(
          '  ' +
            chalk.white(col(String(i + 1), 4)) +
            chalk.white(col(name, nameWidth + 2)) +
            activeCol +
            chalk.white(col(nodeCount, NODES_W)) +
            chalk.gray(col(folderTrunc, folderWidth + 2)) +
            chalk.gray(tagsStr)
        );
      });

      console.log(chalk.gray('  ' + '─'.repeat(80)));
      console.log('');
    });
}
