/**
 * @flowsave/cli — Formatting utilities
 *
 * Pure functions for displaying data in the terminal.
 * No side effects, no imports from core beyond types.
 */

import chalk from 'chalk';
import type { CredentialImportResult, DiffResult } from '@flowsave/core';

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

/**
 * Format a byte count into a human-readable string.
 * Examples: 512 → "512 B", 1536 → "1.5 KB", 2097152 → "2.0 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Format an ISO 8601 timestamp into a short locale string.
 * Example: "2026-06-09T08:00:00Z" → "6/9/2026, 8:00:00 AM"
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable description of a single field change.
 * - Scalar fields (name, active): show before → after
 * - Array fields (nodes, connections): show count delta
 */
function describeChange(field: string, before: unknown, after: unknown): string {
  // Active toggle: show the exact state change
  if (field === 'active') {
    return `active: ${before} → ${after}`;
  }

  // Name rename: show old → new
  if (field === 'name' && typeof before === 'string' && typeof after === 'string') {
    const bTrunc = before.length > 30 ? before.slice(0, 30) + '…' : before;
    const aTrunc = after.length > 30 ? after.slice(0, 30) + '…' : after;
    return `name: "${bTrunc}" → "${aTrunc}"`;
  }

  // Nodes: show count and delta
  if (field === 'nodes' && Array.isArray(before) && Array.isArray(after)) {
    const delta = after.length - before.length;
    const sign = delta > 0 ? `+${delta}` : String(delta);
    const deltaStr = delta !== 0 ? ` (${sign})` : '';
    return `nodes: ${before.length} → ${after.length}${deltaStr}`;
  }

  // Connections: count changed connections
  if (field === 'connections' && typeof before === 'object' && typeof after === 'object' && before !== null && after !== null) {
    const keysB = Object.keys(before as object).length;
    const keysA = Object.keys(after as object).length;
    if (keysB !== keysA) {
      const delta = keysA - keysB;
      const sign = delta > 0 ? `+${delta}` : String(delta);
      return `connections: ${keysB} → ${keysA} connections (${sign})`;
    }
    return `connections: updated`;
  }

  // Settings and anything else
  return `${field}: updated`;
}

/**
 * Render a DiffResult as a chalk-colored multi-line string suitable for
 * printing directly to stdout. Returns empty string if no diff to show.
 */
export function renderDiff(result: DiffResult): string {
  const lines: string[] = [];

  const hasCredentialChanges =
    result.credentials !== undefined &&
    (result.credentials.added.length > 0 || result.credentials.removed.length > 0);

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.modified.length === 0 &&
    !hasCredentialChanges
  ) {
    return chalk.gray('Snapshots are identical.');
  }

  if (result.added.length > 0) {
    lines.push(chalk.green(`+ Added (${result.added.length})`));
    for (const wf of result.added) {
      const folder = wf.folderPath.length > 0 ? ` [${wf.folderPath.join('/')}]` : '';
      lines.push(chalk.green(`  + ${wf.name}${folder}`));
    }
  }

  if (result.removed.length > 0) {
    lines.push(chalk.red(`- Removed (${result.removed.length})`));
    for (const wf of result.removed) {
      const folder = wf.folderPath.length > 0 ? ` [${wf.folderPath.join('/')}]` : '';
      lines.push(chalk.red(`  - ${wf.name}${folder}`));
    }
  }

  if (result.modified.length > 0) {
    lines.push(chalk.yellow(`~ Modified (${result.modified.length})`));
    for (const wf of result.modified) {
      const folder = wf.folderPath.length > 0 ? ` [${wf.folderPath.join('/')}]` : '';
      lines.push(chalk.yellow(`  ~ ${wf.name}${folder}`));
      if (wf.changes && wf.changes.length > 0) {
        for (const change of wf.changes) {
          lines.push(chalk.gray(`      ${describeChange(change.field, change.before, change.after)}`));
        }
      }
    }
  }

  if (result.unchanged > 0) {
    lines.push(chalk.gray(`  Unchanged: ${result.unchanged} workflow${result.unchanged !== 1 ? 's' : ''}`));
  }

  // Credential section
  if (result.credentials) {
    const { added: credsAdded, removed: credsRemoved } = result.credentials;
    if (credsAdded.length > 0 || credsRemoved.length > 0) {
      lines.push('');
      lines.push(chalk.bold('Credentials'));
      for (const c of credsAdded) {
        lines.push(chalk.green(`  + ${c.name}`) + chalk.gray(` (${c.type})`));
      }
      for (const c of credsRemoved) {
        lines.push(chalk.red(`  - ${c.name}`) + chalk.gray(` (${c.type})`));
      }
    } else {
      lines.push(chalk.gray('  Credentials: unchanged'));
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Credential import detail
// ---------------------------------------------------------------------------

/**
 * Print a verbose per-credential import breakdown.
 * Called after the summary table when credentials were imported via the REST API.
 */
export function printCredentialImportDetail(results: CredentialImportResult[]): void {
  const succeeded = results.filter((r) => r.success);
  const failed    = results.filter((r) => !r.success);

  console.log(chalk.bold('\n  Credential Import Detail'));
  console.log(chalk.gray('  ' + '─'.repeat(44)));

  for (const r of succeeded) {
    console.log(
      `  ${chalk.green('✓')} ${chalk.white(r.name.padEnd(35))} ${chalk.gray(r.type)}`
    );
  }

  for (const r of failed) {
    console.log(
      `  ${chalk.red('✗')} ${chalk.white(r.name.padEnd(35))} ${chalk.gray(r.type)}`
    );
  }

  if (failed.length > 0) {
    console.log(
      chalk.yellow(
        `\n  ⚠  ${failed.length} credential${failed.length !== 1 ? 's' : ''} could not be imported automatically.\n`
      ) +
      chalk.gray(
        '     This usually happens with OAuth credentials because their exported data\n' +
        '     includes internal token fields that the n8n API schema rejects.\n' +
        '     You can re-add them manually in the n8n UI on the target instance,\n' +
        '     or use --target-container if the target container is accessible locally\n' +
        '     (the Docker path handles all credential types without schema restrictions).'
      )
    );
  }
}
