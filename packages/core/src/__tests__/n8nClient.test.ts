/**
 * n8nClient contract tests.
 *
 * These tests verify the *outgoing HTTP contract* — method, URL, and body shape.
 * They exist to catch API regressions before they silently break restore/backup
 * against a real n8n instance (the kind of error that unit mocks would never surface).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { N8nClient, N8nApiError } from '../n8nClient';

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeOkResponse(body: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeErrorResponse(status: number, message = 'error'): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ message }),
    text: () => Promise.resolve(JSON.stringify({ message })),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLastCallMethod(): string {
  const init = mockFetch.mock.calls[0][1] as RequestInit;
  return init.method as string;
}

function getLastCallUrl(): string {
  return mockFetch.mock.calls[0][0] as string;
}

function getLastCallBody(): Record<string, unknown> {
  const init = mockFetch.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('N8nClient', () => {
  let client: N8nClient;

  beforeEach(() => {
    client = new N8nClient('http://n8n:5678', 'test-api-key');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe('authentication', () => {
    it('sends X-N8N-API-KEY header on every request', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ data: [], nextCursor: null }));
      await client.getWorkflows();
      const headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-N8N-API-KEY']).toBe('test-api-key');
    });

    it('strips trailing slash from baseUrl', async () => {
      const c = new N8nClient('http://n8n:5678/', 'key');
      mockFetch.mockResolvedValue(makeOkResponse({ data: [], nextCursor: null }));
      await c.getWorkflows();
      expect(getLastCallUrl()).toBe('http://n8n:5678/api/v1/workflows?limit=100');
    });
  });

  // -------------------------------------------------------------------------
  // updateWorkflow — H1: must use PUT (not PATCH)
  // -------------------------------------------------------------------------

  describe('updateWorkflow', () => {
    it('uses PUT, not PATCH', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-1', name: 'Test', active: false, nodes: [], connections: {} })
      );
      await client.updateWorkflow('wf-1', {
        name: 'Test',
        active: false,
        nodes: [],
        connections: {},
      });
      expect(getLastCallMethod()).toBe('PUT');
    });

    it('targets the correct URL', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-1', name: 'Test', active: false, nodes: [], connections: {} })
      );
      await client.updateWorkflow('wf-1', { name: 'Test', active: false, nodes: [], connections: {} });
      expect(getLastCallUrl()).toBe('http://n8n:5678/api/v1/workflows/wf-1');
    });

    it('URL-encodes the workflow ID', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf/special', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.updateWorkflow('wf/special', { name: 'T', active: false, nodes: [], connections: {} });
      expect(getLastCallUrl()).toContain('wf%2Fspecial');
    });

    // H2: payload whitelist — extra fields must be stripped
    it('strips id, active, tags, createdAt, updatedAt from PUT body', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-1', name: 'Test', active: false, nodes: [], connections: {} })
      );
      await client.updateWorkflow('wf-1', {
        name: 'Test',
        active: true,
        nodes: [{ id: 'n1' } as unknown],
        connections: { main: [] },
        tags: [{ id: 'tag1', name: 'important' }],
        createdAt: '2025-01-01',
        updatedAt: '2025-01-02',
      } as Parameters<typeof client.updateWorkflow>[1]);

      const body = getLastCallBody();
      expect(body).not.toHaveProperty('id');
      expect(body).not.toHaveProperty('active');
      expect(body).not.toHaveProperty('tags');
      expect(body).not.toHaveProperty('createdAt');
      expect(body).not.toHaveProperty('updatedAt');
      expect(body).toHaveProperty('name', 'Test');
      expect(body).toHaveProperty('nodes');
      expect(body).toHaveProperty('connections');
    });

    it('includes valid settings fields and strips unknown keys', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-1', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.updateWorkflow('wf-1', {
        name: 'T',
        active: false,
        nodes: [],
        connections: {},
        settings: {
          timezone: 'UTC',
          unknownInternalField: 'value',       // should be stripped
          anotherBogusKey: true,               // should be stripped
        } as Record<string, unknown>,
      });

      const body = getLastCallBody();
      expect(body.settings).toHaveProperty('timezone', 'UTC');
      expect(body.settings).not.toHaveProperty('unknownInternalField');
      expect(body.settings).not.toHaveProperty('anotherBogusKey');
    });

    it('strips enum values outside the valid set (e.g. "DEFAULT")', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-1', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.updateWorkflow('wf-1', {
        name: 'T',
        active: false,
        nodes: [],
        connections: {},
        settings: {
          saveDataErrorExecution: 'DEFAULT',    // invalid enum value — strip it
          saveDataSuccessExecution: 'all',      // valid — keep it
          timezone: 'Europe/Paris',
        } as Record<string, unknown>,
      });

      const body = getLastCallBody();
      expect(body.settings).not.toHaveProperty('saveDataErrorExecution');
      expect(body.settings).toHaveProperty('saveDataSuccessExecution', 'all');
      expect(body.settings).toHaveProperty('timezone', 'Europe/Paris');
    });

    it('always sends settings key (even when empty) since it is required by PUT schema', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-1', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.updateWorkflow('wf-1', { name: 'T', active: false, nodes: [], connections: {} });

      const body = getLastCallBody();
      expect(body).toHaveProperty('settings');
    });

    it('includes optional staticData when present', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-1', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.updateWorkflow('wf-1', {
        name: 'T',
        active: false,
        nodes: [],
        connections: {},
        settings: { timezone: 'UTC' },
        staticData: { counter: 1 },
      });

      const body = getLastCallBody();
      expect(body).toHaveProperty('settings');
      expect(body).toHaveProperty('staticData');
    });
  });

  // -------------------------------------------------------------------------
  // createWorkflow — H2: payload whitelist
  // -------------------------------------------------------------------------

  describe('createWorkflow', () => {
    it('uses POST', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-new', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.createWorkflow({ name: 'T', active: false, nodes: [], connections: {} });
      expect(getLastCallMethod()).toBe('POST');
    });

    it('strips active and tags from POST body', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-new', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.createWorkflow({
        name: 'T',
        active: true,
        nodes: [],
        connections: {},
        tags: [{ id: 'tag1', name: 'x' }],
      });

      const body = getLastCallBody();
      expect(body).not.toHaveProperty('active');
      expect(body).not.toHaveProperty('tags');
      expect(body).toHaveProperty('name', 'T');
    });

    it('never sends parentFolderId — not in POST schema (additionalProperties: false)', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-new', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.createWorkflow({ name: 'T', active: false, nodes: [], connections: {}, parentFolderId: 'folder-1' });
      expect(getLastCallBody()).not.toHaveProperty('parentFolderId');
    });

    it('includes projectId when provided as second argument', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-new', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.createWorkflow({ name: 'T', active: false, nodes: [], connections: {} }, 'proj-1');
      expect(getLastCallBody()).toHaveProperty('projectId', 'proj-1');
    });

    it('always sends settings key on POST (required by schema)', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-new', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.createWorkflow({ name: 'T', active: false, nodes: [], connections: {} });
      expect(getLastCallBody()).toHaveProperty('settings');
    });

    it('strips createdAt and updatedAt from nodes on POST', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-new', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.createWorkflow({
        name: 'T', active: false, connections: {},
        nodes: [{ id: 'n1', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {}, createdAt: '2026-01-01', updatedAt: '2026-01-02' }],
      });
      const body = getLastCallBody();
      const node = (body.nodes as Record<string, unknown>[])[0];
      expect(node).not.toHaveProperty('createdAt');
      expect(node).not.toHaveProperty('updatedAt');
      expect(node).toHaveProperty('type', 'n8n-nodes-base.start');
    });

    it('strips createdAt and updatedAt from nodes on PUT', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-1', name: 'T', active: false, nodes: [], connections: {} })
      );
      await client.updateWorkflow('wf-1', {
        name: 'T', active: false, connections: {},
        nodes: [{ id: 'n1', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {}, createdAt: '2026-01-01', updatedAt: '2026-01-02' }],
      });
      const body = getLastCallBody();
      const node = (body.nodes as Record<string, unknown>[])[0];
      expect(node).not.toHaveProperty('createdAt');
      expect(node).not.toHaveProperty('updatedAt');
    });
  });

  // -------------------------------------------------------------------------
  // activateWorkflow — H3
  // -------------------------------------------------------------------------

  describe('activateWorkflow', () => {
    it('sends POST to /activate endpoint', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-1', active: true, name: 'T', nodes: [], connections: {} })
      );
      await client.activateWorkflow('wf-1');
      expect(getLastCallMethod()).toBe('POST');
      expect(getLastCallUrl()).toBe('http://n8n:5678/api/v1/workflows/wf-1/activate');
    });
  });

  describe('deactivateWorkflow', () => {
    it('sends POST to /deactivate endpoint', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ id: 'wf-1', active: false, name: 'T', nodes: [], connections: {} })
      );
      await client.deactivateWorkflow('wf-1');
      expect(getLastCallMethod()).toBe('POST');
      expect(getLastCallUrl()).toBe('http://n8n:5678/api/v1/workflows/wf-1/deactivate');
    });
  });

  // -------------------------------------------------------------------------
  // updateWorkflowTags — H4
  // -------------------------------------------------------------------------

  describe('updateWorkflowTags', () => {
    it('sends PUT to /tags endpoint', async () => {
      mockFetch.mockResolvedValue(makeOkResponse([{ id: 'tag1', name: 'important' }]));
      await client.updateWorkflowTags('wf-1', [{ id: 'tag1', name: 'important' }]);
      expect(getLastCallMethod()).toBe('PUT');
      expect(getLastCallUrl()).toBe('http://n8n:5678/api/v1/workflows/wf-1/tags');
    });

    it('strips name from each tag — sends id-only objects (422 guard)', async () => {
      mockFetch.mockResolvedValue(makeOkResponse([{ id: 'tag1', name: 'important' }]));
      await client.updateWorkflowTags('wf-1', [
        { id: 'tag1', name: 'important' },
        { id: 'tag2', name: 'prod' },
      ]);
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as unknown[];
      expect(body).toEqual([{ id: 'tag1' }, { id: 'tag2' }]);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('throws N8nApiError on HTTP 4xx/5xx', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(401, 'Unauthorized'));
      await expect(client.getWorkflows()).rejects.toBeInstanceOf(N8nApiError);
    });

    it('includes the status code in the thrown error', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(404, 'Not found'));
      try {
        await client.getWorkflow('missing');
      } catch (err) {
        expect(err).toBeInstanceOf(N8nApiError);
        expect((err as N8nApiError).statusCode).toBe(404);
      }
    });

    it('throws N8nApiError with statusCode=0 on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const err = await client.getWorkflows().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(N8nApiError);
      expect((err as N8nApiError).statusCode).toBe(0);
    });

    it('includes the server error message in the thrown error', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(422, 'must NOT have additional properties'));
      const err = await client.updateWorkflow('wf-1', { name: 'T', active: false, nodes: [], connections: {} })
        .catch((e: unknown) => e);
      expect((err as N8nApiError).message).toContain('must NOT have additional properties');
    });
  });
});
