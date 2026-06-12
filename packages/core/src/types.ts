/**
 * @flowsave/core — Shared TypeScript types
 *
 * This is the SINGLE SOURCE OF TRUTH for all shared types across CLI, agent,
 * and dashboard. Never redefine these types in other packages.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Shape of ~/.flowsave/config.json
 * Fields are defined in spec Section 7 — never add undocumented fields.
 */
export interface FlowsaveConfig {
  instanceUrl: string;
  apiKey: string;
  /** Docker container name for `docker exec` credential export/import. Required for credential backup. */
  containerName?: string;
  /** Absolute path to local snapshot storage. Defaults to ~/.flowsave/backups */
  backupDir: string;
  /** Git remote URL for `flowsave push`. Optional. */
  gitRemote?: string;
  /** Git branch for push. Defaults to "main". */
  gitBranch?: string;
  /** Dashboard token for agent connectivity. Optional. */
  dashboardToken?: string;
}

// ---------------------------------------------------------------------------
// n8n API shapes
// ---------------------------------------------------------------------------

/**
 * Raw n8n workflow as returned by the public REST API.
 * Only the fields we rely on are strongly typed; the rest are preserved as-is
 * so we can round-trip the full JSON without data loss.
 */
export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  staticData?: unknown;
  tags?: Array<{ id: string; name: string }>;
  /** Folder this workflow belongs to. Null = root level. Available on n8n v2.14+. */
  parentFolderId?: string | null;
  /**
   * Project this workflow belongs to (returned by n8n API on GET).
   * Not sent on create/update — use the projectId param on createWorkflow instead.
   * Cross-instance migration does NOT re-create projects; workflows land in the
   * default personal project. Full project placement is Phase 5 scope.
   */
  project?: { id: string; name: string; type: string };
  /**
   * Project sharing info returned by GET /api/v1/workflows.
   * shared[0].projectId is the canonical way to get the project ID for a workflow,
   * used when calling GET /api/v1/projects/{projectId}/folders.
   */
  shared?: Array<{
    role: string;
    workflowId: string;
    projectId: string;
    project?: { id: string; name: string; type: string };
  }>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * n8n folder as returned by the public REST API.
 * Endpoint: GET /api/v1/projects/{projectId}/folders
 * Available from n8n v2.14.0. Returns null from getFolders() on older versions.
 */
export interface N8nFolder {
  id: string;
  name: string;
  /** Null means the folder is at the root level. */
  parentFolderId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Credential metadata as returned by the public REST API.
 * Secret values are NEVER available via the REST API — use credentials.ts for
 * actual secret export/import via docker exec.
 */
export interface CredentialMetadata {
  id: string;
  name: string;
  type: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Safe (non-secret) representation of a credential stored in a snapshot.
 * Written to _credentials.meta.json alongside the encrypted blob so that
 * diff can compare what credentials changed without ever decrypting anything.
 */
export interface CredentialMeta {
  id: string;
  name: string;
  type: string;
}

/**
 * Per-credential result when credentials are imported via the n8n REST API
 * (cross-instance restore without local Docker access to the target container).
 *
 * The `success` field indicates whether POST /api/v1/credentials succeeded.
 * `error` is sanitized — it never contains secret values, only the API error
 * message (e.g. schema validation failures).
 */
export interface CredentialImportResult {
  /** Credential ID on the source instance (not the same on the target). */
  id: string;
  name: string;
  type: string;
  success: boolean;
  /** API error message if import failed. Truncated to 300 chars, no secrets. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * A single entry in ~/.flowsave/index.json — the local snapshot registry.
 */
export interface SnapshotIndexEntry {
  id: number;
  timestamp: string; // ISO 8601
  instanceUrl: string;
  sizeBytes: number;
}

/**
 * Contents of meta.json inside each snapshot directory.
 */
export interface SnapshotMeta {
  snapshotId: number;
  instanceUrl: string;
  /**
   * n8n version string detected via `docker exec n8n --version`.
   * Undefined when no container is configured — n8n's public API does not
   * expose the version, so it cannot be determined without container access.
   */
  n8nVersion?: string;
  timestamp: string; // ISO 8601
  workflowCount: number;
  /** True if _credentials.enc.json is present in this snapshot. */
  credentialsIncluded: boolean;
  /**
   * True if folder hierarchy was successfully fetched and used to place workflow
   * files in subdirectories. False when the API is unavailable (requires n8n
   * Enterprise license — GET /api/v1/projects/{id}/folders is gated).
   * Undefined on snapshots created before this field was added.
   */
  folderStructureIncluded?: boolean;
  /** Total size of all files in this snapshot directory, in bytes. */
  sizeBytes?: number;
}

/**
 * A workflow stored inside a snapshot, with its reconstructed folder path.
 */
export interface WorkflowBackup {
  /** n8n workflow ID from the source instance. */
  id: string;
  name: string;
  /**
   * Folder path relative to snapshot root.
   * Empty array = workflow is at the root level.
   * Example: ['DevOps', 'Deploy'] means the workflow is in DevOps/Deploy/
   */
  folderPath: string[];
  /** Complete workflow data as returned by the n8n API. Used for round-trip restore. */
  data: N8nWorkflow;
}

/**
 * The full in-memory representation of a completed snapshot.
 * Returned by backup() — not persisted as a single object, but reconstructed
 * from the snapshot directory by restore() and diff().
 */
export interface Snapshot {
  id: number;
  meta: SnapshotMeta;
  workflows: WorkflowBackup[];
  /** Absolute path to the snapshot directory on disk. */
  snapshotPath: string;
  /**
   * Mirror of meta.credentialsIncluded — true when the snapshot contains an
   * encrypted credential bundle. Never changes meaning: always "snapshot has creds".
   */
  credentialsIncluded: boolean;
  /**
   * True when credentials from this snapshot were actually restored/migrated to
   * the target instance during this operation. Distinct from credentialsIncluded,
   * which only says the snapshot contains credentials.
   * Undefined on backup() results (restore hasn't happened yet).
   */
  credentialsRestored?: boolean;
  /**
   * True when folder hierarchy was successfully re-created on the target during
   * a restore/migrate. Undefined on backup snapshots or when no folders existed.
   */
  folderStructureRestored?: boolean;
  /**
   * Per-credential import results when credentials were imported via the n8n
   * REST API (cross-instance restore without local Docker access to the target).
   * Absent when credentials were imported via docker exec or not imported at all.
   */
  credentialImportResults?: CredentialImportResult[];
  /**
   * Non-fatal warnings generated during the operation (folder skips, credential
   * skips, activation failures, etc.). The CLI displays these after the spinner
   * so the user sees them clearly without stderr interleaving.
   */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Field-level change within a modified workflow.
 */
export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * A workflow entry within a DiffResult.
 */
export interface WorkflowDiff {
  id?: string;
  name: string;
  folderPath: string[];
  /** Populated only for modified workflows. */
  changes?: FieldChange[];
}

/**
 * Structured result of comparing two local snapshots.
 */
export interface DiffResult {
  snapshotA: number;
  snapshotB: number;
  /** Workflows present in B but not in A. */
  added: WorkflowDiff[];
  /** Workflows present in A but not in B. */
  removed: WorkflowDiff[];
  /** Workflows present in both with at least one changed field. */
  modified: WorkflowDiff[];
  /** Number of workflows identical in both snapshots. */
  unchanged: number;
  /**
   * Credential-level changes between snapshots. Populated only when at least
   * one snapshot has a _credentials.meta.json file. Absent when neither snapshot
   * included a credential backup.
   *
   * Scope: added/removed only (matched by ID).
   * Name and type changes are intentionally not tracked — type changes require
   * delete+recreate (so they appear as removed+added), and name changes are
   * low-stakes and undetectable without decrypting the blob.
   */
  credentials?: {
    added: CredentialMeta[];
    removed: CredentialMeta[];
  };
}

// ---------------------------------------------------------------------------
// Agent / Dashboard job types
// ---------------------------------------------------------------------------

export type BackupJobType = 'backup' | 'restore' | 'git-push';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Job payload as received in the agent poll response from the Dashboard.
 * Treat ALL fields from the Dashboard as untrusted — validate before use.
 */
export interface BackupJobPayload {
  /** Presigned R2 URL for uploading the encrypted backup bundle. */
  uploadUrl?: string;
  /** Presigned R2 URL for downloading a bundle to restore. */
  downloadUrl?: string;
  /** Cloud snapshot UUID (for restore and git-push jobs). */
  snapshotUuid?: string;
}

/**
 * A single job as dispatched by the Dashboard to the agent.
 */
export interface BackupJob {
  /** UUID assigned by the Dashboard. */
  id: string;
  type: BackupJobType;
  payload: BackupJobPayload;
}

/**
 * The full poll response from GET /api/agent/poll.
 */
export interface PollResponse {
  jobs: BackupJob[];
}
