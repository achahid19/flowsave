/**
 * @flowsave/core — Public API
 *
 * Export only what CLI, agent, and dashboard need.
 * Internal helpers stay private to their modules.
 */

// Types
export type {
  CredentialImportResult,
  CredentialMeta,
  CredentialMetadata,
  DiffResult,
  FieldChange,
  FlowsaveConfig,
  N8nFolder,
  N8nWorkflow,
  Snapshot,
  SnapshotIndexEntry,
  SnapshotMeta,
  WorkflowBackup,
  WorkflowDiff,
} from './types';

// Config
export {
  ConfigValidationError,
  expandHome,
  getConfigPath,
  getDefaultBackupDir,
  getFlowsaveHome,
  getIndexPath,
  readConfig,
  validateConfig,
  writeConfig,
} from './config';

// Encryption
export { decrypt, encrypt, EncryptionError, MIN_PASSPHRASE_LENGTH, validatePassphrase } from './encrypt';

// n8n API client
export { N8nApiError, N8nClient } from './n8nClient';

// Credentials
export { CredentialError, exportCredentials, importCredentials, importCredentialsViaApi } from './credentials';

// Backup
export { backup, BackupError, deleteSnapshot, DeleteError, listSnapshots, readSnapshotDetail, ShowError } from './backup';
export type { BackupOptions, SnapshotDetail } from './backup';

// Prune
export { pruneSnapshots } from './prune';
export type { PruneCandidate, PruneResult } from './prune';

// Restore
export { restore, RestoreError } from './restore';
export type { RestoreOptions } from './restore';

// Migrate
export { migrate } from './migrate';
export type { MigrateOptions } from './migrate';

// Diff
export { diff, DiffError } from './diff';

// Git sync
export { GitSyncError, pushToGit } from './gitSync';
