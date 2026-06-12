/**
 * @flowsave/core — Snapshot builder
 *
 * Fetches all workflows and folder structure from n8n, writes them to disk
 * as a folder-aware snapshot, and registers the snapshot in the local index.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { exportCredentials, getContainerVersion } from './credentials';
import { getFlowsaveHome, getIndexPath } from './config';
import { N8nClient } from './n8nClient';
import { getSnapshotPath, writeIndex } from './snapshotStore';
export { deleteSnapshot, DeleteError, listSnapshots, readSnapshotDetail, ShowError } from './snapshotStore';
export type { SnapshotDetail } from './snapshotStore';
import type {
  FlowsaveConfig,
  N8nFolder,
  Snapshot,
  SnapshotIndexEntry,
  SnapshotMeta,
  WorkflowBackup,
} from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

// ---------------------------------------------------------------------------
// Backup options
// ---------------------------------------------------------------------------

export interface BackupOptions {
  config: FlowsaveConfig;
  /**
   * Passphrase for credential encryption.
   * When config.containerName is set, providing a passphrase enables credential
   * backup; omitting it skips credentials (workflows are still backed up).
   * Ignored when no container is configured.
   */
  passphrase?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use as a file or directory name.
 * Replaces characters unsafe for file systems with underscores.
 */
function sanitizeName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '_') // unsafe chars
    .replace(/\.{2,}/g, '_')        // prevent path traversal via ..
    .trim()
    .replace(/^\.+/, '_')           // no leading dots
    .substring(0, 200);             // cap length
}

/**
 * Build a map from folder ID to its full path as an array of names.
 * Example: { 'fid-123': ['DevOps', 'Deploy'] }
 */
function buildFolderPathMap(folders: N8nFolder[]): Map<string, string[]> {
  const pathMap = new Map<string, string[]>();
  const folderById = new Map<string, N8nFolder>(folders.map((f) => [f.id, f]));

  function getPath(id: string, visited = new Set<string>()): string[] {
    if (visited.has(id)) return []; // cycle guard
    visited.add(id);

    const folder = folderById.get(id);
    if (!folder) return [];

    if (folder.parentFolderId === null) {
      return [sanitizeName(folder.name)];
    }

    const parentPath = getPath(folder.parentFolderId, visited);
    return [...parentPath, sanitizeName(folder.name)];
  }

  for (const folder of folders) {
    pathMap.set(folder.id, getPath(folder.id));
  }

  return pathMap;
}

/**
 * Recursively compute the total byte size of all files in a directory.
 */
function computeDirSize(dirPath: string): number {
  let total = 0;
  for (const entry of readdirSync(dirPath)) {
    const full = join(dirPath, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      total += computeDirSize(full);
    } else {
      total += stat.size;
    }
  }
  return total;
}

/**
 * Like readIndex, but a corrupt (unparseable) index file is an error rather
 * than an empty array. backup() MUST use this: treating a corrupt index as
 * empty would restart snapshot IDs at 1 and the orphan-directory cleanup
 * would then DELETE the real snapshot #1 before overwriting it.
 */
function readIndexStrict(indexPath: string): SnapshotIndexEntry[] {
  if (!existsSync(indexPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
  } catch {
    throw new BackupError(
      `Snapshot index at ${indexPath} is corrupt and cannot be parsed. ` +
      `Refusing to back up — fix or remove the index file first ` +
      `(your snapshot directories are untouched).`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new BackupError(
      `Snapshot index at ${indexPath} is not a JSON array. ` +
      `Refusing to back up — fix or remove the index file first.`
    );
  }
  return parsed as SnapshotIndexEntry[];
}

/**
 * Determine the next snapshot ID (max existing ID + 1, starting at 1).
 */
function nextSnapshotId(entries: SnapshotIndexEntry[]): number {
  if (entries.length === 0) return 1;
  return Math.max(...entries.map((e) => e.id)) + 1;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Create a new local snapshot of the n8n instance.
 *
 * @returns The completed Snapshot object with the assigned integer ID
 */
export async function backup(options: BackupOptions): Promise<Snapshot> {
  const { config, passphrase } = options;

  const client = new N8nClient(config.instanceUrl, config.apiKey);

  // 1. Resolve and create backup directory
  const backupDir = resolve(config.backupDir);
  mkdirSync(backupDir, { recursive: true });

  // 2. Determine next snapshot ID (strict read — corrupt index must abort, not reset IDs)
  const indexPath = getIndexPath();
  const existingIndex = readIndexStrict(indexPath);
  const snapshotId = nextSnapshotId(existingIndex);
  const snapshotPath = getSnapshotPath(backupDir, snapshotId);

  if (existsSync(snapshotPath)) {
    // Orphaned directory from a previously-failed backup (created but never indexed).
    // Clean it up so this run can proceed cleanly.
    rmSync(snapshotPath, { recursive: true, force: true });
  }

  mkdirSync(snapshotPath, { recursive: true });

  // Guard: clean up the partially-created snapshot directory if anything below fails,
  // so the next backup run doesn't encounter an orphaned directory.
  let completed = false;
  try {

  // 3. Fetch workflows and detect n8n version.
  //    getContainerVersion() uses spawnSync (blocking), so these run sequentially
  //    despite the separate awaits. True parallelism would require an async spawn;
  //    left sequential for simplicity since the docker call is fast (<200ms).
  const workflows = await client.getWorkflows();
  const n8nVersion = config.containerName ? getContainerVersion(config.containerName) : undefined;

  // 4. Resolve folder structure.
  //    Correct endpoint: GET /api/v1/projects/{projectId}/folders (n8n v2.14+).
  //    We extract projectId from the first workflow's shared[] field — available
  //    on the same n8n version that exposes the folders endpoint.
  //    folders === null means the API is unavailable on this n8n version.
  const projectId = workflows[0]?.shared?.[0]?.projectId;
  const folders = projectId ? await client.getFolders(projectId) : null;

  // folders === null → API unavailable (community edition limitation)
  // folders === [] → API available but no folders created yet
  const folderStructureIncluded = folders !== null;
  const folderPathMap = buildFolderPathMap(folders ?? []);

  // 5. Write workflow files in folder-aware structure
  const workflowBackups: WorkflowBackup[] = [];

  // n8n allows duplicate workflow names (and different names can sanitize to the
  // same string). Track used filenames per directory and disambiguate with the
  // workflow ID so no file silently overwrites another.
  const usedFileNames = new Map<string, Set<string>>();

  for (const workflow of workflows) {
    const folderPath: string[] =
      workflow.parentFolderId && folderPathMap.has(workflow.parentFolderId)
        ? folderPathMap.get(workflow.parentFolderId) ?? []
        : [];

    // Create nested directory for this workflow's folder
    const workflowDir = folderPath.length > 0
      ? join(snapshotPath, ...folderPath)
      : snapshotPath;

    mkdirSync(workflowDir, { recursive: true });

    // Write workflow JSON
    let taken = usedFileNames.get(workflowDir);
    if (!taken) {
      taken = new Set();
      usedFileNames.set(workflowDir, taken);
    }
    const baseName = sanitizeName(workflow.name);
    const fileName = taken.has(`${baseName}.json`)
      ? `${baseName}_${sanitizeName(workflow.id)}.json`
      : `${baseName}.json`;
    taken.add(fileName);

    writeFileSync(
      join(workflowDir, fileName),
      JSON.stringify(workflow, null, 2),
      'utf-8'
    );

    workflowBackups.push({
      id: workflow.id,
      name: workflow.name,
      folderPath,
      data: workflow,
    });
  }

  // 6. Export and write credentials (if containerName is configured AND a
  //    passphrase was provided). No passphrase = skip credentials — this matches
  //    the CLI's "leave blank to skip" prompt; workflows are still backed up.
  let credentialsIncluded = false;

  if (config.containerName && passphrase) {
    const { encrypted, meta } = await exportCredentials(config.containerName, passphrase);
    writeFileSync(join(snapshotPath, '_credentials.enc.json'), encrypted, { mode: 0o600 });
    // Safe metadata written in plaintext — enables diff without decrypting
    writeFileSync(
      join(snapshotPath, '_credentials.meta.json'),
      JSON.stringify(meta, null, 2),
      { mode: 0o644 }
    );
    credentialsIncluded = true;
  }

  // 7. Write meta.json
  const timestamp = new Date().toISOString();
  const meta: SnapshotMeta = {
    snapshotId,
    instanceUrl: config.instanceUrl,
    n8nVersion,
    timestamp,
    workflowCount: workflows.length,
    credentialsIncluded,
    folderStructureIncluded,
  };
  writeFileSync(join(snapshotPath, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  // 8. Compute snapshot size and write final size back into meta
  const sizeBytes = computeDirSize(snapshotPath);
  meta.sizeBytes = sizeBytes;
  writeFileSync(join(snapshotPath, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  // 9. Append entry to ~/.flowsave/index.json
  const newEntry: SnapshotIndexEntry = {
    id: snapshotId,
    timestamp,
    instanceUrl: config.instanceUrl,
    sizeBytes,
  };

  // Ensure flowsave home exists before writing index
  mkdirSync(getFlowsaveHome(), { recursive: true });
  writeIndex(indexPath, [...existingIndex, newEntry]);

  completed = true;
  return {
    id: snapshotId,
    meta,
    workflows: workflowBackups,
    snapshotPath,
    credentialsIncluded,
  };

  } finally {
    if (!completed && existsSync(snapshotPath)) {
      rmSync(snapshotPath, { recursive: true, force: true });
    }
  }
}
