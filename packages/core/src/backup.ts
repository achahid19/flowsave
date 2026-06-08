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
  statSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { exportCredentials } from './credentials';
import { getFlowsaveHome } from './config';
import { N8nClient } from './n8nClient';
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
  const indexPath = join(getFlowsaveHome(), 'index.json');
  const existingIndex = readIndex(indexPath);
  const snapshotId = nextSnapshotId(existingIndex);
  const snapshotPath = join(backupDir, String(snapshotId));

  if (existsSync(snapshotPath)) {
    throw new BackupError(
      `Snapshot directory ${snapshotPath} already exists. This should not happen — check for index corruption.`
    );
  }

  mkdirSync(snapshotPath, { recursive: true });

  // 3. Fetch data from n8n in parallel
  const [workflows, folders, n8nVersion] = await Promise.all([
    client.getWorkflows(),
    client.getFolders(),
    client.getVersion(),
  ]);

  // 4. Build folder ID → path mapping
  const folderPathMap = buildFolderPathMap(folders);

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
    const encrypted = await exportCredentials(config.containerName, passphrase);
    writeFileSync(join(snapshotPath, '_credentials.enc.json'), encrypted);
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
  };
  writeFileSync(join(snapshotPath, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  // 8. Compute snapshot size
  const sizeBytes = computeDirSize(snapshotPath);

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

  return {
    id: snapshotId,
    meta,
    workflows: workflowBackups,
    snapshotPath,
    credentialsIncluded,
  };
}
