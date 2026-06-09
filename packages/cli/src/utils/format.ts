/**
 * @flowsave/cli — Formatting utilities
 *
 * Pure functions for displaying data in the terminal.
 * No side effects, no imports from core beyond types.
 */

import chalk from 'chalk';
import type { DiffResult } from '@flowsave/core';

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

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.modified.length === 0
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

  return lines.join('\n');
}
