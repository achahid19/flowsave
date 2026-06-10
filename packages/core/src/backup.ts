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
import { join, relative, resolve, sep } from 'path';
import { exportCredentials } from './credentials';
import { getFlowsaveHome, getIndexPath } from './config';
import { N8nClient } from './n8nClient';
import type {
  CredentialMeta,
  FlowsaveConfig,
  N8nFolder,
  N8nWorkflow,
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
// Backup options
// ---------------------------------------------------------------------------

export interface BackupOptions {
  config: FlowsaveConfig;
  /**
   * Passphrase for credential encryption.
   * Required when config.containerName is set (credential backup is enabled).
   * Ignored otherwise.
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
 * Read the local snapshot index, returning an empty array if it doesn't exist.
 */
function readIndex(indexPath: string): SnapshotIndexEntry[] {
  if (!existsSync(indexPath)) return [];
  try {
    const content = readFileSync(indexPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed as SnapshotIndexEntry[];
  } catch {
    return [];
  }
}

/**
 * Determine the next snapshot ID (max existing ID + 1, starting at 1).
 */
function nextSnapshotId(entries: SnapshotIndexEntry[]): number {
  if (entries.length === 0) return 1;
  return Math.max(...entries.map((e) => e.id)) + 1;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Return all entries from the local snapshot registry (~/.flowsave/index.json).
 * Used by `flowsave list` in the CLI. Returns an empty array if no backups exist yet.
 */
export function listSnapshots(): SnapshotIndexEntry[] {
  return readIndex(getIndexPath());
}

/**
 * Delete a single snapshot: removes its directory from disk and removes its
 * entry from ~/.flowsave/index.json.
 *
 * Throws DeleteError if the ID is not in the index.
 */
export function deleteSnapshot(snapshotId: number, config: FlowsaveConfig): void {
  const indexPath = getIndexPath();
  const entries = readIndex(indexPath);

  if (!entries.find((e) => e.id === snapshotId)) {
    throw new DeleteError(
      `Snapshot ${snapshotId} not found. Run "flowsave list" to see available snapshots.`
    );
  }

  const snapshotPath = join(resolve(config.backupDir), String(snapshotId));
  if (existsSync(snapshotPath)) {
    rmSync(snapshotPath, { recursive: true, force: true });
  }

  const updated = entries.filter((e) => e.id !== snapshotId);
  writeFileSync(indexPath, JSON.stringify(updated, null, 2), 'utf-8');
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
  const snapshotPath = join(resolve(config.backupDir), String(snapshotId));

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

  const workflows: WorkflowBackup[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (
        entry.endsWith('.json') &&
        entry !== 'meta.json' &&
        entry !== '_credentials.enc.json' &&
        entry !== '_credentials.meta.json'
      ) {
        let workflow: N8nWorkflow;
        try {
          workflow = JSON.parse(readFileSync(full, 'utf-8')) as N8nWorkflow;
        } catch {
          throw new ShowError(`Failed to parse workflow file: ${full}`);
        }
        const relDir = relative(snapshotPath, dir);
        const folderPath = relDir ? relDir.split(sep).filter((p) => p.length > 0) : [];
        workflows.push({ id: workflow.id, name: workflow.name, folderPath, data: workflow });
      }
    }
  }

  walk(snapshotPath);

  return { meta, workflows, hasCredentials, credentialMeta, snapshotPath };
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

  // 2. Determine next snapshot ID
  const indexPath = getIndexPath();
  const existingIndex = readIndex(indexPath);
  const snapshotId = nextSnapshotId(existingIndex);
  const snapshotPath = join(backupDir, String(snapshotId));

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

  // 3. Fetch workflows and version in parallel (folders need projectId from workflows first)
  const [workflows, n8nVersion] = await Promise.all([
    client.getWorkflows(),
    client.getVersion(),
  ]);

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
    const fileName = `${sanitizeName(workflow.name)}.json`;
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

  // 6. Export and write credentials (if containerName is configured)
  let credentialsIncluded = false;

  if (config.containerName) {
    if (!passphrase) {
      throw new BackupError(
        'Credential backup requires a passphrase. Provide one or omit containerName to skip credentials.'
      );
    }
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
  writeFileSync(
    indexPath,
    JSON.stringify([...existingIndex, newEntry], null, 2),
    'utf-8'
  );

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
