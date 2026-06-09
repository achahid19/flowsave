/**
 * @flowsave/core — Restore engine
 *
 * Reads a local snapshot by integer ID and pushes its workflows, folder
 * structure, and credentials to a target n8n instance.
 *
 * Folder creation uses POST /rest/folders (n8n internal API).
 * If folder creation fails for any reason, we fall back to a flat restore
 * (all workflows at root level) and emit a clear warning. This is the
 * documented fallback — see DECISIONS.md.
 *
 * Restore supports two modes:
 *   - Same-instance: updates existing workflows by ID, creates missing ones
 *   - Cross-instance (migrate): always creates new workflows
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { join, relative, sep } from 'path';
import { importCredentials } from './credentials';
import { getIndexPath } from './config';
import { N8nClient, N8nApiError } from './n8nClient';
import type {
  FlowsaveConfig,
  N8nWorkflow,
  Snapshot,
  SnapshotIndexEntry,
  SnapshotMeta,
  WorkflowBackup,
} from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

// ---------------------------------------------------------------------------
// Restore options
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  /** Snapshot integer ID to restore. */
  snapshotId: number;
  /** Source config — used to locate the snapshot on disk. */
  config: FlowsaveConfig;
  /**
   * Override target instance URL for cross-instance restore (migration).
   * Defaults to config.instanceUrl.
   */
  targetUrl?: string;
  /**
   * Override target API key for cross-instance restore.
   * Defaults to config.apiKey.
   */
  targetApiKey?: string;
  /**
   * Override target container name for credential import.
   * Defaults to config.containerName.
   */
  targetContainerName?: string;
  /** Passphrase for credential decryption. Required if snapshot has credentials. */
  passphrase?: string;
  /**
   * If true, always create new workflows (never update by ID).
   * Used by migrate.ts for cross-instance migration.
   * @default false
   */
  forceCreate?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read the snapshot index and find the entry for a given ID.
 */
function findSnapshotEntry(snapshotId: number): SnapshotIndexEntry {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) {
    throw new RestoreError(`No snapshots found. Run "flowsave backup" first.`);
  }

  let entries: SnapshotIndexEntry[];
  try {
    entries = JSON.parse(readFileSync(indexPath, 'utf-8')) as SnapshotIndexEntry[];
  } catch {
    throw new RestoreError('Failed to read snapshot index. The index file may be corrupt.');
  }

  const entry = entries.find((e) => e.id === snapshotId);
  if (!entry) {
    throw new RestoreError(
      `Snapshot ${snapshotId} not found. Run "flowsave list" to see available snapshots.`
    );
  }
  return entry;
}

/**
 * Read meta.json from a snapshot directory.
 */
function readSnapshotMeta(snapshotPath: string): SnapshotMeta {
  const metaPath = join(snapshotPath, 'meta.json');
  if (!existsSync(metaPath)) {
    throw new RestoreError(`Snapshot at ${snapshotPath} is missing meta.json. It may be corrupt.`);
  }
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8')) as SnapshotMeta;
  } catch {
    throw new RestoreError(`Failed to parse meta.json at ${snapshotPath}.`);
  }
}

/**
 * Walk a snapshot directory and collect all workflow JSON files.
 * Returns an array of WorkflowBackup objects with reconstructed folder paths.
 */
function readWorkflowsFromDisk(snapshotPath: string): WorkflowBackup[] {
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
          throw new RestoreError(`Failed to parse workflow file: ${full}`);
        }

        // Reconstruct folder path from the relative directory
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
 * Create the folder hierarchy on the target instance.
 *
 * Returns a map from folder path string (e.g. "DevOps/Deploy") to the new
 * folder ID on the target instance.
 *
 * If folder creation fails (undocumented API may break), returns null to
 * signal that the caller should fall back to a flat restore.
 */
async function createFolderHierarchy(
  client: N8nClient,
  workflows: WorkflowBackup[]
): Promise<Map<string, string> | null> {
  // Collect unique folder paths from all workflows
  const uniquePaths = new Set<string>();
  for (const wf of workflows) {
    if (wf.folderPath.length > 0) {
      // Add all ancestor paths too (e.g. for DevOps/Deploy, also add DevOps)
      for (let depth = 1; depth <= wf.folderPath.length; depth++) {
        uniquePaths.add(wf.folderPath.slice(0, depth).join('/'));
      }
    }
  }

  if (uniquePaths.size === 0) {
    return new Map(); // No folders needed
  }

  const folderIdMap = new Map<string, string>(); // path → new folder ID

  // Sort by depth so parents are created before children
  const sortedPaths = Array.from(uniquePaths).sort(
    (a, b) => a.split('/').length - b.split('/').length
  );

  try {
    for (const pathStr of sortedPaths) {
      const parts = pathStr.split('/');
      const name = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join('/');
      const parentId = parentPath ? folderIdMap.get(parentPath) : undefined;

      const folder = await client.createFolder(name, parentId ?? null);
      folderIdMap.set(pathStr, folder.id);
    }

    return folderIdMap;
  } catch (err) {
    if (err instanceof N8nApiError) {
      // Expected failure — internal API might not be available
      process.stderr.write(
        `[flowsave] Warning: folder creation failed (${err.message}). ` +
        `Falling back to flat restore — all workflows will be placed at root level.\n`
      );
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Restore a local snapshot to a target n8n instance.
 */
export async function restore(options: RestoreOptions): Promise<Snapshot> {
  const {
    snapshotId,
    config,
    targetUrl,
    targetApiKey,
    targetContainerName,
    passphrase,
    forceCreate = false,
  } = options;

  // 1. Validate snapshot exists in index (throws RestoreError if not found)
  findSnapshotEntry(snapshotId);
  const snapshotPath = join(config.backupDir, String(snapshotId));

  if (!existsSync(snapshotPath)) {
    throw new RestoreError(
      `Snapshot directory not found at ${snapshotPath}. ` +
      `The index entry exists but the files are missing.`
    );
  }

  // 2. Read snapshot metadata and workflows
  const meta = readSnapshotMeta(snapshotPath);
  const workflows = readWorkflowsFromDisk(snapshotPath);

  // 3. Set up client for target instance
  const resolvedUrl = targetUrl ?? config.instanceUrl;
  const resolvedApiKey = targetApiKey ?? config.apiKey;
  const client = new N8nClient(resolvedUrl, resolvedApiKey);

  // 4. Attempt folder hierarchy creation on target
  const folderIdMap = await createFolderHierarchy(client, workflows);
  const useFlatRestore = folderIdMap === null;

  // 5. Restore workflows
  for (const wf of workflows) {
    // Determine the folder ID on the target instance
    let targetFolderId: string | null = null;
    if (!useFlatRestore && wf.folderPath.length > 0) {
      const pathStr = wf.folderPath.join('/');
      targetFolderId = folderIdMap?.get(pathStr) ?? null;
    }

    const payload: Omit<N8nWorkflow, 'id'> = {
      ...wf.data,
      parentFolderId: targetFolderId,
    };

    // Update or create, capturing the resulting workflow for post-restore steps.
    // updateWorkflow uses PUT (full replacement) with a whitelisted payload.
    // createWorkflow also uses a whitelisted payload — no extra fields.
    // Neither endpoint changes active state, so result.active reflects the
    // workflow's CURRENT state on the target (false for newly-created workflows).
    const result = await (async (): Promise<N8nWorkflow> => {
      if (forceCreate) {
        return client.createWorkflow(payload);
      }
      // Same-instance restore: update by ID, fall back to create on 404
      try {
        return await client.updateWorkflow(wf.id, payload);
      } catch (err) {
        if (err instanceof N8nApiError && err.statusCode === 404) {
          return client.createWorkflow(payload);
        }
        throw err;
      }
    })();

    // Enforce the backed-up active state for full fidelity — but only call the
    // API when the current state actually differs, to avoid redundant requests
    // and noisy "already (in)active" warnings.
    const desiredActive = wf.data.active === true;
    const currentActive = result.active === true;
    if (desiredActive && !currentActive) {
      try {
        await client.activateWorkflow(result.id);
      } catch {
        process.stderr.write(
          `[flowsave] Warning: could not activate workflow "${wf.name}" (id: ${result.id}).\n`
        );
      }
    } else if (!desiredActive && currentActive) {
      try {
        await client.deactivateWorkflow(result.id);
      } catch {
        process.stderr.write(
          `[flowsave] Warning: could not deactivate workflow "${wf.name}" (id: ${result.id}).\n`
        );
      }
    }

    // Restore tags on same-instance restore only.
    // Cross-instance (forceCreate): tag IDs differ across instances — skip with a warning.
    if (!forceCreate && wf.data.tags && wf.data.tags.length > 0) {
      try {
        await client.updateWorkflowTags(result.id, wf.data.tags);
      } catch {
        process.stderr.write(
          `[flowsave] Warning: could not restore tags for workflow "${wf.name}".\n`
        );
      }
    }
  }

  // 6. Restore credentials if present
  const credentialsPath = join(snapshotPath, '_credentials.enc.json');
  if (existsSync(credentialsPath)) {
    const containerName = targetContainerName ?? config.containerName;
    if (!containerName) {
      process.stderr.write(
        `[flowsave] Warning: snapshot contains credentials but no containerName is configured. ` +
        `Skipping credential restore.\n`
      );
    } else if (!passphrase) {
      process.stderr.write(
        `[flowsave] Warning: snapshot contains credentials but no passphrase provided. ` +
        `Skipping credential restore.\n`
      );
    } else {
      const encryptedData = readFileSync(credentialsPath);
      await importCredentials(containerName, encryptedData, passphrase);
    }
  }

  return {
    id: snapshotId,
    meta,
    workflows,
    snapshotPath,
    credentialsIncluded: meta.credentialsIncluded,
  };
}
