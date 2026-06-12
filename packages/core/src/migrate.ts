/**
 * @flowsave/core — Migration wrapper
 *
 * Migration is a two-step operation:
 *   1. backup() — snapshot the source instance
 *   2. restore() — push the snapshot to the destination instance (forceCreate=true)
 *
 * It is intentionally a thin wrapper. All business logic lives in backup.ts
 * and restore.ts. This module exists to make the two-step intent explicit and
 * give the CLI a single entry point for `flowsave migrate`.
 *
 * Folder creation on the destination uses POST /rest/folders with the same
 * try/catch + flat-restore fallback inherited from restore.ts.
 */

import { backup } from './backup';
import { restore } from './restore';
import type { FlowsaveConfig, Snapshot } from './types';

// ---------------------------------------------------------------------------
// Migrate options
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  /** Source instance config (instanceUrl, apiKey, containerName, backupDir). */
  config: FlowsaveConfig;
  /** Destination n8n instance URL. */
  targetUrl: string;
  /** Destination n8n API key. */
  targetApiKey: string;
  /** Destination container name for credential import. Optional. */
  targetContainerName?: string;
  /**
   * Passphrase for credential encryption (backup) and decryption (restore).
   * Required when config.containerName is set (credential migration enabled).
   */
  passphrase?: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Migrate all workflows, folder structure, and credentials from the source
 * instance to the destination instance.
 *
 * @returns The snapshot created from the source instance
 */
export async function migrate(options: MigrateOptions): Promise<Snapshot> {
  const {
    config,
    targetUrl,
    targetApiKey,
    targetContainerName,
    passphrase,
  } = options;

  // Step 1: backup source instance
  const snapshot = await backup({ config, passphrase });

  // Step 2: restore to destination (always create new — never update by ID
  // since the destination has different IDs or is a fresh instance)
  const restoreResult = await restore({
    snapshotId: snapshot.id,
    config,
    targetUrl,
    targetApiKey,
    targetContainerName,
    passphrase,
    forceCreate: true,
  });

  // Merge warnings from both steps so the CLI can display them in one place
  const allWarnings = [
    ...(snapshot.warnings ?? []),
    ...(restoreResult.warnings ?? []),
  ];

  return {
    ...snapshot,
    credentialsRestored: restoreResult.credentialsRestored,
    folderStructureRestored: restoreResult.folderStructureRestored,
    credentialImportResults: restoreResult.credentialImportResults,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
  };
}
