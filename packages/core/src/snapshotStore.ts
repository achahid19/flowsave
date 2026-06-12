/**
 * @flowsave/core — Snapshot store
 *
 * Single source of truth for the on-disk snapshot format:
 *   <backupDir>/<id>/meta.json
 *   <backupDir>/<id>/<WorkflowName>.json
 *   <backupDir>/<id>/_credentials.enc.json   (excluded from git)
 *   <backupDir>/<id>/_credentials.meta.json
 *
 * All modules that read or write snapshot directories (backup, restore, diff)
 * must go through this module rather than reimplementing the layout.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, relative, resolve, sep } from 'path';
import { getIndexPath } from './config';
import type {
  CredentialMeta,
  FlowsaveConfig,
  N8nWorkflow,
  SnapshotIndexEntry,
  SnapshotMeta,
  WorkflowBackup,
} from './types';

// ---------------------------------------------------------------------------
// Reserved filenames — never parsed as workflow JSON
// ---------------------------------------------------------------------------

/**
 * Filenames that exist in a snapshot directory but are not workflow backups.
 * Any code that walks a snapshot directory and collects workflow JSON files
 * must skip these.
 */
export const RESERVED_FILES = new Set([
  'meta.json',
  '_credentials.enc.json',
  '_credentials.meta.json',
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeleteError';
  }
}

export class ShowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShowError';
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to a snapshot directory.
 * This is the canonical way to build snapshot paths — never inline this join.
 */
export function getSnapshotPath(backupDir: string, id: number): string {
  return join(resolve(backupDir), String(id));
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

/**
 * Read the snapshot index, returning an empty array on any error or if the
 * file does not exist. backup() must NOT use this — use readIndexStrict in
 * backup.ts to prevent silent data loss on a corrupt index.
 */
export function readIndex(indexPath: string): SnapshotIndexEntry[] {
  if (!existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed as SnapshotIndexEntry[];
  } catch {
    return [];
  }
}

/**
 * Write entries to the snapshot index file.
 */
export function writeIndex(indexPath: string, entries: SnapshotIndexEntry[]): void {
  writeFileSync(indexPath, JSON.stringify(entries, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Workflow file reader
// ---------------------------------------------------------------------------

/**
 * Walk a snapshot directory and collect all workflow JSON files, reconstructing
 * each workflow's folder path from the relative directory structure.
 *
 * Skips RESERVED_FILES. Throws on unparseable JSON.
 */
export function readWorkflowsFromDisk(snapshotPath: string): WorkflowBackup[] {
  const result: WorkflowBackup[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.json') && !RESERVED_FILES.has(entry)) {
        let workflow: N8nWorkflow;
        try {
          workflow = JSON.parse(readFileSync(full, 'utf-8')) as N8nWorkflow;
        } catch {
          throw new Error(`Failed to parse workflow file: ${full}`);
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

// ---------------------------------------------------------------------------
// Public read helpers
// ---------------------------------------------------------------------------

/**
 * Return all entries from the local snapshot registry.
 * Used by `flowsave list`. Returns an empty array if no backups exist yet.
 */
export function listSnapshots(): SnapshotIndexEntry[] {
  return readIndex(getIndexPath());
}

/**
 * Delete a single snapshot: removes its directory from disk and its entry
 * from the index. Throws DeleteError if the ID is not in the index.
 */
export function deleteSnapshot(snapshotId: number, config: FlowsaveConfig): void {
  const indexPath = getIndexPath();
  const entries = readIndex(indexPath);

  if (!entries.find((e) => e.id === snapshotId)) {
    throw new DeleteError(
      `Snapshot ${snapshotId} not found. Run "flowsave list" to see available snapshots.`
    );
  }

  const snapshotPath = getSnapshotPath(config.backupDir, snapshotId);
  if (existsSync(snapshotPath)) {
    rmSync(snapshotPath, { recursive: true, force: true });
  }

  writeIndex(indexPath, entries.filter((e) => e.id !== snapshotId));
}

// ---------------------------------------------------------------------------
// Snapshot detail reader
// ---------------------------------------------------------------------------

export interface SnapshotDetail {
  meta: SnapshotMeta;
  workflows: WorkflowBackup[];
  /** True when _credentials.enc.json is present on disk (cross-checks meta). */
  hasCredentials: boolean;
  /**
   * Credential metadata from _credentials.meta.json (id, name, type — no secrets).
   * null when the file is absent (snapshot predates meta file support).
   */
  credentialMeta: CredentialMeta[] | null;
  snapshotPath: string;
}

/**
 * Read the full detail of a snapshot from disk: meta.json + all workflow JSON files.
 * Used by `flowsave show <id>`.
 *
 * Throws ShowError if the snapshot directory or meta.json is missing.
 */
export function readSnapshotDetail(snapshotId: number, config: FlowsaveConfig): SnapshotDetail {
  const snapshotPath = getSnapshotPath(config.backupDir, snapshotId);

  if (!existsSync(snapshotPath)) {
    throw new ShowError(
      `Snapshot ${snapshotId} not found. Run "flowsave list" to see available snapshots.`
    );
  }

  const metaPath = join(snapshotPath, 'meta.json');
  if (!existsSync(metaPath)) {
    throw new ShowError(`Snapshot ${snapshotId} is missing meta.json — it may be corrupt.`);
  }

  let meta: SnapshotMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as SnapshotMeta;
  } catch {
    throw new ShowError(`Failed to parse meta.json for snapshot ${snapshotId}.`);
  }

  const hasCredentials = existsSync(join(snapshotPath, '_credentials.enc.json'));

  const credMetaPath = join(snapshotPath, '_credentials.meta.json');
  let credentialMeta: CredentialMeta[] | null = null;
  if (existsSync(credMetaPath)) {
    try {
      credentialMeta = JSON.parse(readFileSync(credMetaPath, 'utf-8')) as CredentialMeta[];
    } catch {
      credentialMeta = null;
    }
  }

  const workflows = readWorkflowsFromDisk(snapshotPath);

  return { meta, workflows, hasCredentials, credentialMeta, snapshotPath };
}
