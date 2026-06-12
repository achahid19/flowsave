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

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getIndexPath } from './config';
import { getSnapshotPath, readIndex, readWorkflowsFromDisk } from './snapshotStore';
import type {
  CredentialMeta,
  DiffResult,
  FieldChange,
  FlowsaveConfig,
  N8nWorkflow,
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

function ensureSnapshotExists(snapshotId: number, backupDir: string): string {
  const index = readIndex(getIndexPath());
  if (!index.find((e) => e.id === snapshotId)) {
    throw new DiffError(
      `Snapshot ${snapshotId} not found. Run "flowsave list" to see available snapshots.`
    );
  }
  const snapshotPath = getSnapshotPath(backupDir, snapshotId);
  if (!existsSync(snapshotPath)) {
    throw new DiffError(
      `Snapshot ${snapshotId} directory not found at ${snapshotPath}.`
    );
  }
  return snapshotPath;
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
      changes.push({ field: field as string, before, after });
    }
  }

  return changes;
}

/**
 * Read _credentials.meta.json from a snapshot directory.
 * Returns null when the file doesn't exist (old snapshot or no cred backup).
 */
function readCredentialMeta(snapshotPath: string): CredentialMeta[] | null {
  const metaPath = join(snapshotPath, '_credentials.meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8')) as CredentialMeta[];
  } catch {
    return null;
  }
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

  const workflowsA = readWorkflowsFromDisk(pathA);
  const workflowsB = readWorkflowsFromDisk(pathB);
  const credsA = readCredentialMeta(pathA);
  const credsB = readCredentialMeta(pathB);

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

  // Credential diff — only when at least one snapshot has metadata
  let credentials: DiffResult['credentials'];
  if (credsA !== null || credsB !== null) {
    const listA = credsA ?? [];
    const listB = credsB ?? [];
    const mapA = new Map(listA.map((c) => [c.id, c]));
    const mapB = new Map(listB.map((c) => [c.id, c]));
    credentials = {
      added:   listB.filter((c) => !mapA.has(c.id)),
      removed: listA.filter((c) => !mapB.has(c.id)),
    };
  }

  return {
    snapshotA: snapshotIdA,
    snapshotB: snapshotIdB,
    added,
    removed,
    modified,
    unchanged,
    credentials,
  };
}
