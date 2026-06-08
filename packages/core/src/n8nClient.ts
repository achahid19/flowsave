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

interface WorkflowCreatePayload {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  staticData?: unknown;
  tags?: Array<{ id: string; name: string }>;
  parentFolderId?: string | null;
  projectId?: string;
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
    const payload: WorkflowCreatePayload = {
      name: data.name,
      nodes: data.nodes,
      connections: data.connections,
      ...(data.settings !== undefined && { settings: data.settings }),
      ...(data.staticData !== undefined && { staticData: data.staticData }),
      ...(data.tags !== undefined && { tags: data.tags }),
      ...(data.parentFolderId !== undefined && { parentFolderId: data.parentFolderId }),
      ...(projectId !== undefined && { projectId }),
    };
    return this.request<N8nWorkflow>('POST', '/api/v1/workflows', payload);
  }

  /**
   * Update an existing workflow by ID.
   * Uses PATCH — only sends the fields provided.
   */
  async updateWorkflow(id: string, data: Partial<N8nWorkflow>): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>(
      'PATCH',
      `/api/v1/workflows/${encodeURIComponent(id)}`,
      data
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
   * List all folders via the public API.
   * Returns an empty array (with a warning) if the endpoint is not available
   * on older n8n instances — callers must handle the flat fallback.
   */
  async getFolders(): Promise<N8nFolder[]> {
    try {
      return await this.fetchAllPages<N8nFolder>('/api/v1/folders');
    } catch (err) {
      if (err instanceof N8nApiError && (err.statusCode === 404 || err.statusCode === 405)) {
        // Older n8n version — folder list endpoint not available
        return [];
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
