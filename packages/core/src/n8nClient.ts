/**
 * @flowsave/core — n8n REST API client
 *
 * Two API surfaces:
 *   - Public API  (/api/v1/)   — all stable operations
 *   - Internal API (/rest/)    — ONLY for POST /rest/folders (folder creation)
 *
 * The internal API usage is the ONLY documented exception in this codebase.
 * See DECISIONS.md and CLAUDE.md for the rationale and required fallback.
 *
 * Authentication: X-N8N-API-KEY header on all requests.
 * Credential secret values are NEVER fetched here — see credentials.ts.
 */

import type {
  CredentialMetadata,
  N8nFolder,
  N8nWorkflow,
} from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class N8nApiError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'N8nApiError';
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Internal types for paginated responses
// ---------------------------------------------------------------------------

interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Settings sanitisation
// ---------------------------------------------------------------------------

/**
 * Keys the n8n public API accepts inside the workflow `settings` object.
 * Source: PUT /api/v1/workflows/{id} JSON Schema (additionalProperties: false).
 * Any other key returned by GET causes a 400 "must NOT have additional properties".
 */
const ALLOWED_SETTINGS_KEYS = new Set([
  'saveExecutionProgress',
  'saveManualExecutions',
  'saveDataErrorExecution',
  'saveDataSuccessExecution',
  'executionTimeout',
  'errorWorkflow',
  'timezone',
  'executionOrder',
  'callerPolicy',
  'callerIds',
  'timeSavedPerExecution',
  'redactionPolicy',
  'availableInMCP',
  'customTelemetryTags',
]);

/**
 * For enum-typed settings fields, the valid string values.
 * n8n returns 'DEFAULT' for fields that inherit the instance setting — that
 * value is NOT in the enum and will cause a 400 if sent back.
 */
const SETTINGS_ENUM_VALUES: Record<string, ReadonlySet<string>> = {
  saveDataErrorExecution:    new Set(['all', 'none']),
  saveDataSuccessExecution:  new Set(['all', 'none']),
  callerPolicy:              new Set(['any', 'none', 'workflowsFromAList', 'workflowsFromSameOwner']),
  redactionPolicy:           new Set(['none', 'non-manual', 'manual-only', 'all']),
};

/**
 * Strip any key that the POST/PUT workflow schema does not allow,
 * and drop enum values that are outside the valid set (e.g. 'DEFAULT').
 * Returns an empty object if settings is null / undefined.
 */
function sanitizeSettings(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!settings) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) continue;
    const validEnum = SETTINGS_ENUM_VALUES[key];
    if (validEnum) {
      // Skip values not in the valid enum (covers 'DEFAULT' and any future strays)
      if (typeof value !== 'string' || !validEnum.has(value)) continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Strip readOnly fields from node objects returned by GET before sending to POST/PUT.
 * Nodes have `additionalProperties: false` — `createdAt` and `updatedAt` are readOnly
 * and rejected by the schema even though n8n includes them in GET responses.
 */
const NODE_READONLY_KEYS = new Set(['createdAt', 'updatedAt']);

function sanitizeNodes(nodes: unknown[]): unknown[] {
  return nodes.map((node) => {
    if (typeof node !== 'object' || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!NODE_READONLY_KEYS.has(key)) out[key] = value;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/**
 * Fields the n8n public API accepts on POST /api/v1/workflows.
 * Confirmed via n8n docs MCP (2026-06-10).
 * `active`, `tags`, `parentFolderId` are NOT accepted — use dedicated endpoints or projectId.
 * `settings` is in required[] — always send it, even as {}.
 */
interface WorkflowCreatePayload {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  staticData?: unknown;
  projectId?: string;
}

/**
 * Fields the n8n public API accepts on PUT /api/v1/workflows/{id}.
 * `settings` is in the required[] array of the schema — always send it.
 * No id, no active, no tags, no parentFolderId on update.
 * (Folder reassignment via PUT is not supported; use a dedicated move endpoint if added.)
 */
interface WorkflowUpdatePayload {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;   // required by PUT schema; use {} if no settings
  staticData?: unknown;
}

interface FolderCreatePayload {
  name: string;
  parentFolderId?: string | null;
}

// ---------------------------------------------------------------------------
// N8nClient class
// ---------------------------------------------------------------------------

export class N8nClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  // -------------------------------------------------------------------------
  // HTTP primitives
  // -------------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    return {
      'X-N8N-API-KEY': this.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new N8nApiError(
        `Network error connecting to n8n at ${this.baseUrl}: ${message}`,
        0
      );
    }

    if (!response.ok) {
      let detail = '';
      try {
        const text = await response.text();
        // Only include safe, non-sensitive parts of the error response
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed['message'] === 'string') {
          detail = `: ${parsed['message']}`;
        }
      } catch {
        // ignore parse errors — we already have the status code
      }
      throw new N8nApiError(
        `n8n API ${method} ${path} returned ${response.status}${detail}`,
        response.status
      );
    }

    // 204 No Content
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return response.json() as unknown as Promise<T>;
  }

  /**
   * Fetch all pages of a paginated endpoint.
   * Follows nextCursor until exhausted.
   */
  private async fetchAllPages<T>(basePath: string): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | null = null;

    do {
      const url: string = cursor
        ? `${basePath}?cursor=${encodeURIComponent(cursor)}&limit=100`
        : `${basePath}?limit=100`;

      const page: PaginatedResponse<T> = await this.request<PaginatedResponse<T>>('GET', url);
      results.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);

    return results;
  }

  // -------------------------------------------------------------------------
  // Workflows
  // -------------------------------------------------------------------------

  /** List all workflows across all pages. */
  async getWorkflows(): Promise<N8nWorkflow[]> {
    return this.fetchAllPages<N8nWorkflow>('/api/v1/workflows');
  }

  /** Get a single workflow by ID. */
  async getWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('GET', `/api/v1/workflows/${encodeURIComponent(id)}`);
  }

  /**
   * Create a new workflow.
   * @param data - Workflow data (without id)
   * @param projectId - Optional team project ID
   */
  async createWorkflow(
    data: Omit<N8nWorkflow, 'id'>,
    projectId?: string
  ): Promise<N8nWorkflow> {
    // Whitelist only fields accepted by POST /api/v1/workflows (additionalProperties: false).
    // - nodes: strip readOnly createdAt/updatedAt from each node object
    // - settings: always required by schema — send {} if nothing survives sanitization
    // - parentFolderId: NOT in the POST schema; folder assignment uses projectId only
    // - active/tags: managed via dedicated endpoints after creation
    const payload: WorkflowCreatePayload = {
      name: data.name,
      nodes: sanitizeNodes(data.nodes),
      connections: data.connections,
      settings: sanitizeSettings(data.settings as Record<string, unknown> | undefined),
      ...(data.staticData !== undefined && { staticData: data.staticData }),
      ...(projectId !== undefined && { projectId }),
    };
    return this.request<N8nWorkflow>('POST', '/api/v1/workflows', payload);
  }

  /**
   * Replace an existing workflow by ID (full update).
   *
   * Uses PUT (full replacement) — n8n public API does not support PATCH.
   * Only whitelisted fields are sent; extra fields cause 422 validation errors.
   * `active` state and `tags` are managed via their dedicated endpoints.
   */
  async updateWorkflow(id: string, data: Omit<N8nWorkflow, 'id'>): Promise<N8nWorkflow> {
    const payload: WorkflowUpdatePayload = {
      name: data.name,
      nodes: sanitizeNodes(data.nodes),
      connections: data.connections,
      settings: sanitizeSettings(data.settings as Record<string, unknown> | undefined),
      ...(data.staticData !== undefined && { staticData: data.staticData }),
    };
    return this.request<N8nWorkflow>(
      'PUT',
      `/api/v1/workflows/${encodeURIComponent(id)}`,
      payload
    );
  }

  /**
   * Activate a workflow.
   * Must be called explicitly after create/restore — workflows start inactive.
   */
  async activateWorkflow(id: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/api/v1/workflows/${encodeURIComponent(id)}/activate`
    );
  }

  /**
   * Replace the full tag set on a workflow.
   * Tags are not accepted on create or update — must be set via this endpoint.
   * On cross-instance restore, tag IDs differ, so callers should skip this.
   *
   * The endpoint accepts an array of `{ id }` only — any extra field (e.g. name)
   * triggers a 422 "must NOT have additional properties", so we send IDs alone.
   */
  async updateWorkflowTags(
    id: string,
    tags: Array<{ id: string; name?: string }>
  ): Promise<void> {
    const payload = tags.map((t) => ({ id: t.id }));
    await this.request<unknown>(
      'PUT',
      `/api/v1/workflows/${encodeURIComponent(id)}/tags`,
      payload
    );
  }

  /**
   * Deactivate a workflow.
   * Used on same-instance restore to match a snapshot that had the workflow inactive.
   */
  async deactivateWorkflow(id: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/api/v1/workflows/${encodeURIComponent(id)}/deactivate`
    );
  }

  /** Delete a workflow by ID. */
  async deleteWorkflow(id: string): Promise<void> {
    return this.request<void>('DELETE', `/api/v1/workflows/${encodeURIComponent(id)}`);
  }

  // -------------------------------------------------------------------------
  // Folders — READ via public API
  // -------------------------------------------------------------------------

  /**
   * List all folders for a given project.
   *
   * Correct endpoint: GET /api/v1/projects/{projectId}/folders
   * Available from n8n v2.14.0. Returns null on older versions (404/403/405),
   * so callers can distinguish "no folders" from "API not supported".
   *
   * The projectId can be extracted from workflow.shared[0].projectId.
   * This endpoint uses skip/take pagination (not cursor-based).
   */
  async getFolders(projectId: string): Promise<N8nFolder[] | null> {
    const pageSize = 100;
    const results: N8nFolder[] = [];
    let skip = 0;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const page = await this.request<{ count: number; data: N8nFolder[] }>(
          'GET',
          `/api/v1/projects/${encodeURIComponent(projectId)}/folders?take=${pageSize}&skip=${skip}`
        );
        results.push(...page.data);
        if (results.length >= page.count || page.data.length === 0) break;
        skip += pageSize;
      }
      return results;
    } catch (err) {
      if (
        err instanceof N8nApiError &&
        (err.statusCode === 404 || err.statusCode === 403 || err.statusCode === 405)
      ) {
        return null; // API not available on this n8n version
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Folders — WRITE via internal API (⚠️ undocumented, see DECISIONS.md)
  // -------------------------------------------------------------------------

  /**
   * Create a folder using the n8n internal API (POST /rest/folders).
   *
   * ⚠️  UNDOCUMENTED API — the only intentional exception in this codebase.
   *     See DECISIONS.md for rationale.
   *     MUST be called inside a try/catch in restore.ts and migrate.ts.
   *     SWAP TO POST /api/v1/folders as soon as it ships in the public API.
   *
   * @param name - Folder name
   * @param parentFolderId - Parent folder ID, or undefined for root-level
   */
  async createFolder(name: string, parentFolderId?: string | null): Promise<N8nFolder> {
    const payload: FolderCreatePayload = {
      name,
      ...(parentFolderId !== undefined && { parentFolderId }),
    };
    return this.request<N8nFolder>('POST', '/rest/folders', payload);
  }

  // -------------------------------------------------------------------------
  // Credentials (metadata only — no secret values)
  // -------------------------------------------------------------------------

  /**
   * List credential metadata. Secret values are NEVER included.
   * Actual credential export/import uses credentials.ts via docker exec.
   */
  async getCredentials(): Promise<CredentialMetadata[]> {
    return this.fetchAllPages<CredentialMetadata>('/api/v1/credentials');
  }

  // -------------------------------------------------------------------------
  // Instance info
  // -------------------------------------------------------------------------

  /**
   * Attempt to retrieve the n8n instance version.
   * Returns "unknown" if the endpoint is not available.
   */
  async getVersion(): Promise<string> {
    try {
      const info = await this.request<Record<string, unknown>>('GET', '/api/v1/');
      if (typeof info['version'] === 'string') {
        return info['version'];
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Test connectivity to the n8n instance.
   * Resolves if reachable and authenticated, throws N8nApiError otherwise.
   */
  async ping(): Promise<void> {
    // A lightweight call that requires auth
    await this.request<unknown>('GET', '/api/v1/workflows?limit=1');
  }
}
