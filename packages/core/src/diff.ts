/**
 * @flowsave/core — Snapshot diff engine
 *
 * Compares two local snapshots by integer ID and returns a structured
 * DiffResult: which workflows were added, removed, or modified.
 *
 * Matching strategy:
 * - Primary key: workflow ID (stable across backups of the same instance)
 * - If IDs match, compare name + nodes + connections + settings to detect changes
 *
 * All operations are local (disk reads only) — no API calls.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { getFlowsaveHome } from './config';
import type {
  DiffResult,
  FieldChange,
  FlowsaveConfig,
  N8nWorkflow,
  SnapshotIndexEntry,
  WorkflowBackup,
  WorkflowDiff,
} from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readIndex(): SnapshotIndexEntry[] {
  const indexPath = join(getFlowsaveHome(), 'index.json');
  if (!existsSync(indexPath)) return [];
  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8')) as SnapshotIndexEntry[];
  } catch {
    return [];
  }
}

function ensureSnapshotExists(snapshotId: number, backupDir: string): string {
  const index = readIndex();
  const entry = index.find((e) => e.id === snapshotId);
  if (!entry) {
    throw new DiffError(
      `Snapshot ${snapshotId} not found. Run "flowsave list" to see available snapshots.`
    );
  }
  const snapshotPath = join(backupDir, String(snapshotId));
  if (!existsSync(snapshotPath)) {
    throw new DiffError(
      `Snapshot ${snapshotId} directory not found at ${snapshotPath}.`
    );
  }
  return snapshotPath;
}

/**
 * Walk a snapshot directory and collect all workflow JSON files.
 */
function readWorkflows(snapshotPath: string): WorkflowBackup[] {
  const result: WorkflowBackup[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        walk(full);
      } else if (
        entry.endsWith('.json') &&
        entry !== 'meta.json' &&
        entry !== '_credentials.enc.json'
      ) {
        let workflow: N8nWorkflow;
        try {
          workflow = JSON.parse(readFileSync(full, 'utf-8')) as N8nWorkflow;
        } catch {
          throw new DiffError(`Failed to parse workflow file: ${full}`);
        }

        const relDir = relative(snapshotPath, dir);
        const folderPath = relDir
          ? relDir.split(sep).filter((p) => p.length > 0)
          : [];

        result.push({
          id: workflow.id,
          name: workflow.name,
          folderPath,
          data: workflow,
        });
      }
    }
  }

  walk(snapshotPath);
  return result;
}

/**
 * Compare two workflow objects and return field-level changes.
 * Only compares semantically meaningful fields — not metadata like createdAt.
 */
function computeChanges(a: N8nWorkflow, b: N8nWorkflow): FieldChange[] {
  const changes: FieldChange[] = [];
  const fields: (keyof N8nWorkflow)[] = [
    'name',
    'active',
    'nodes',
    'connections',
    'settings',
  ];

  for (const field of fields) {
    const before = a[field];
    const after = b[field];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ field, before, after });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compare two local snapshots and return a structured diff.
 *
 * @param snapshotIdA - The "before" snapshot
 * @param snapshotIdB - The "after" snapshot
 * @param config      - Used to locate the backupDir
 */
export function diff(
  snapshotIdA: number,
  snapshotIdB: number,
  config: FlowsaveConfig
): DiffResult {
  if (snapshotIdA === snapshotIdB) {
    throw new DiffError('Cannot diff a snapshot against itself.');
  }

  const pathA = ensureSnapshotExists(snapshotIdA, config.backupDir);
  const pathB = ensureSnapshotExists(snapshotIdB, config.backupDir);

  const workflowsA = readWorkflows(pathA);
  const workflowsB = readWorkflows(pathB);

  const mapA = new Map(workflowsA.map((w) => [w.id, w]));
  const mapB = new Map(workflowsB.map((w) => [w.id, w]));

  const added: WorkflowDiff[] = [];
  const removed: WorkflowDiff[] = [];
  const modified: WorkflowDiff[] = [];
  let unchanged = 0;

  // Workflows in B — check against A
  for (const [id, wfB] of mapB) {
    const wfA = mapA.get(id);
    if (!wfA) {
      added.push({ id: wfB.id, name: wfB.name, folderPath: wfB.folderPath });
    } else {
      const changes = computeChanges(wfA.data, wfB.data);
      if (changes.length > 0) {
        modified.push({
          id: wfB.id,
          name: wfB.name,
          folderPath: wfB.folderPath,
          changes,
        });
      } else {
        unchanged++;
      }
    }
  }

  // Workflows in A but not in B
  for (const [id, wfA] of mapA) {
    if (!mapB.has(id)) {
      removed.push({ id: wfA.id, name: wfA.name, folderPath: wfA.folderPath });
    }
  }

  return {
    snapshotA: snapshotIdA,
    snapshotB: snapshotIdB,
    added,
    removed,
    modified,
    unchanged,
  };
}
