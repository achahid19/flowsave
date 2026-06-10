import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Hoist mock fns
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  getFlowsaveHome: vi.fn(),
}));

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return {
    ...actual,
    getFlowsaveHome: mocks.getFlowsaveHome,
    // getIndexPath must be mocked too: it calls getFlowsaveHome() internally (same-module
    // scope), so the export-level mock above doesn't affect it.
    getIndexPath: () => join(mocks.getFlowsaveHome(), 'index.json'),
  };
});

import { diff, DiffError } from '../diff';
import type { FlowsaveConfig, N8nWorkflow, SnapshotMeta } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(id: string, name: string, overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id,
    name,
    active: true,
    nodes: [{ id: 'node-1', type: 'n8n-nodes-base.start' }],
    connections: {},
    ...overrides,
  };
}

function writeSnapshot(
  homeDir: string,
  backupDir: string,
  snapshotId: number,
  workflows: Array<{ wf: N8nWorkflow; folder?: string }>
): void {
  // Read existing index entries if present
  const indexPath = join(homeDir, 'index.json');
  let existing: Array<{ id: number }> = [];
  if (existsSync(indexPath)) {
    try {
      existing = JSON.parse(readFileSync(indexPath, 'utf-8')) as Array<{ id: number }>;
    } catch {
      existing = [];
    }
  }

  writeFileSync(
    indexPath,
    JSON.stringify([
      ...existing,
      { id: snapshotId, timestamp: '', instanceUrl: '', sizeBytes: 0 },
    ])
  );

  const snapshotPath = join(backupDir, String(snapshotId));
  mkdirSync(snapshotPath, { recursive: true });

  const meta: SnapshotMeta = {
    snapshotId,
    instanceUrl: 'http://localhost:5678',
    n8nVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    workflowCount: workflows.length,
    credentialsIncluded: false,
  };
  writeFileSync(join(snapshotPath, 'meta.json'), JSON.stringify(meta));

  for (const { wf, folder } of workflows) {
    const dir = folder ? join(snapshotPath, folder) : snapshotPath;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${wf.name}.json`), JSON.stringify(wf));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diff', () => {
  let tmpDir: string;
  let backupDir: string;
  let homeDir: string;
  let config: FlowsaveConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flowsave-diff-test-'));
    backupDir = join(tmpDir, 'backups');
    homeDir = join(tmpDir, 'home');
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    mocks.getFlowsaveHome.mockReturnValue(homeDir);

    config = {
      instanceUrl: 'http://localhost:5678',
      apiKey: 'test-key',
      backupDir,
      gitBranch: 'main',
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('throws DiffError when comparing a snapshot against itself', () => {
    expect(() => diff(1, 1, config)).toThrow(DiffError);
  });

  it('throws DiffError when a snapshot ID does not exist', () => {
    writeFileSync(join(homeDir, 'index.json'), JSON.stringify([]));
    expect(() => diff(1, 2, config)).toThrow(DiffError);
  });

  it('reports added workflows (in B but not A)', () => {
    writeSnapshot(homeDir, backupDir, 1, [{ wf: makeWorkflow('wf-1', 'Alpha') }]);
    writeSnapshot(homeDir, backupDir, 2, [
      { wf: makeWorkflow('wf-1', 'Alpha') },
      { wf: makeWorkflow('wf-2', 'Beta') },
    ]);

    const result = diff(1, 2, config);

    expect(result.added).toHaveLength(1);
    expect(result.added[0].name).toBe('Beta');
    expect(result.removed).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });

  it('reports removed workflows (in A but not B)', () => {
    writeSnapshot(homeDir, backupDir, 1, [
      { wf: makeWorkflow('wf-1', 'Alpha') },
      { wf: makeWorkflow('wf-2', 'Beta') },
    ]);
    writeSnapshot(homeDir, backupDir, 2, [{ wf: makeWorkflow('wf-1', 'Alpha') }]);

    const result = diff(1, 2, config);

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].name).toBe('Beta');
    expect(result.added).toHaveLength(0);
  });

  it('reports modified workflows with field-level changes', () => {
    writeSnapshot(homeDir, backupDir, 1, [
      { wf: makeWorkflow('wf-1', 'Alpha', { active: true }) },
    ]);
    writeSnapshot(homeDir, backupDir, 2, [
      { wf: makeWorkflow('wf-1', 'Alpha', { active: false }) },
    ]);

    const result = diff(1, 2, config);

    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].changes).toBeDefined();
    const activeChange = result.modified[0].changes?.find((c) => c.field === 'active');
    expect(activeChange?.before).toBe(true);
    expect(activeChange?.after).toBe(false);
    expect(result.unchanged).toBe(0);
  });

  it('reports unchanged count correctly', () => {
    const wf = makeWorkflow('wf-1', 'Alpha');
    writeSnapshot(homeDir, backupDir, 1, [{ wf }]);
    writeSnapshot(homeDir, backupDir, 2, [{ wf }]);

    const result = diff(1, 2, config);

    expect(result.unchanged).toBe(1);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
  });

  it('correctly identifies the snapshotA and snapshotB IDs', () => {
    const wf = makeWorkflow('wf-1', 'Alpha');
    writeSnapshot(homeDir, backupDir, 3, [{ wf }]);
    writeSnapshot(homeDir, backupDir, 7, [{ wf }]);

    const result = diff(3, 7, config);

    expect(result.snapshotA).toBe(3);
    expect(result.snapshotB).toBe(7);
  });

  it('preserves folderPath in diff results', () => {
    writeSnapshot(homeDir, backupDir, 1, []);
    writeSnapshot(homeDir, backupDir, 2, [
      { wf: makeWorkflow('wf-1', 'Deploy'), folder: 'DevOps' },
    ]);

    const result = diff(1, 2, config);

    expect(result.added[0].folderPath).toEqual(['DevOps']);
  });

  // ── Credential diff ────────────────────────────────────────────────────────

  it('credentials is undefined when neither snapshot has _credentials.meta.json', () => {
    const wf = makeWorkflow('wf-1', 'Alpha');
    writeSnapshot(homeDir, backupDir, 1, [{ wf }]);
    writeSnapshot(homeDir, backupDir, 2, [{ wf }]);

    const result = diff(1, 2, config);

    expect(result.credentials).toBeUndefined();
  });

  it('reports removed credential when it appears in A but not B', () => {
    const wf = makeWorkflow('wf-1', 'Alpha');
    writeSnapshot(homeDir, backupDir, 1, [{ wf }]);
    writeSnapshot(homeDir, backupDir, 2, [{ wf }]);

    const credsA = [{ id: 'cred-1', name: 'My API Key', type: 'httpHeaderAuth' }];
    writeFileSync(join(backupDir, '1', '_credentials.meta.json'), JSON.stringify(credsA));
    writeFileSync(join(backupDir, '2', '_credentials.meta.json'), JSON.stringify([]));

    const result = diff(1, 2, config);

    expect(result.credentials?.removed).toHaveLength(1);
    expect(result.credentials?.removed[0].name).toBe('My API Key');
    expect(result.credentials?.added).toHaveLength(0);
  });

  it('reports added credential when it appears in B but not A', () => {
    const wf = makeWorkflow('wf-1', 'Alpha');
    writeSnapshot(homeDir, backupDir, 1, [{ wf }]);
    writeSnapshot(homeDir, backupDir, 2, [{ wf }]);

    writeFileSync(join(backupDir, '1', '_credentials.meta.json'), JSON.stringify([]));
    const credsB = [{ id: 'cred-2', name: 'Slack Token', type: 'slackOAuth2Api' }];
    writeFileSync(join(backupDir, '2', '_credentials.meta.json'), JSON.stringify(credsB));

    const result = diff(1, 2, config);

    expect(result.credentials?.added).toHaveLength(1);
    expect(result.credentials?.added[0].name).toBe('Slack Token');
    expect(result.credentials?.removed).toHaveLength(0);
  });

  it('reports unchanged when credential meta is present but identical', () => {
    const wf = makeWorkflow('wf-1', 'Alpha');
    writeSnapshot(homeDir, backupDir, 1, [{ wf }]);
    writeSnapshot(homeDir, backupDir, 2, [{ wf }]);

    const creds = [{ id: 'cred-1', name: 'My API Key', type: 'httpHeaderAuth' }];
    writeFileSync(join(backupDir, '1', '_credentials.meta.json'), JSON.stringify(creds));
    writeFileSync(join(backupDir, '2', '_credentials.meta.json'), JSON.stringify(creds));

    const result = diff(1, 2, config);

    expect(result.credentials?.added).toHaveLength(0);
    expect(result.credentials?.removed).toHaveLength(0);
  });

  it('does not return "identical" when only credentials changed', () => {
    const wf = makeWorkflow('wf-1', 'Alpha');
    writeSnapshot(homeDir, backupDir, 1, [{ wf }]);
    writeSnapshot(homeDir, backupDir, 2, [{ wf }]);

    const credsA = [{ id: 'cred-1', name: 'My API Key', type: 'httpHeaderAuth' }];
    writeFileSync(join(backupDir, '1', '_credentials.meta.json'), JSON.stringify(credsA));
    writeFileSync(join(backupDir, '2', '_credentials.meta.json'), JSON.stringify([]));

    const result = diff(1, 2, config);

    // Workflows unchanged but credential was removed — should not be "identical"
    expect(result.unchanged).toBe(1);
    expect(result.credentials?.removed).toHaveLength(1);
  });

  it('treats missing meta in one snapshot as empty list', () => {
    const wf = makeWorkflow('wf-1', 'Alpha');
    writeSnapshot(homeDir, backupDir, 1, [{ wf }]);
    writeSnapshot(homeDir, backupDir, 2, [{ wf }]);

    // Only B has credential metadata
    const credsB = [{ id: 'cred-1', name: 'My API Key', type: 'httpHeaderAuth' }];
    writeFileSync(join(backupDir, '2', '_credentials.meta.json'), JSON.stringify(credsB));

    const result = diff(1, 2, config);

    expect(result.credentials?.added).toHaveLength(1);
    expect(result.credentials?.removed).toHaveLength(0);
  });
});
