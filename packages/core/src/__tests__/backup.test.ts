import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Hoist mock fns so they're available inside vi.mock() factory closures
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  getWorkflows: vi.fn(),
  getFolders: vi.fn(),
  getVersion: vi.fn(),
  exportCredentials: vi.fn(),
  getFlowsaveHome: vi.fn(),
}));

vi.mock('../n8nClient', () => {
  class MockN8nClient {
    getWorkflows = mocks.getWorkflows;
    getFolders = mocks.getFolders;
    getVersion = mocks.getVersion;
  }
  return {
    N8nClient: MockN8nClient,
    N8nApiError: class N8nApiError extends Error {},
  };
});

vi.mock('../credentials', () => ({
  exportCredentials: mocks.exportCredentials,
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

import { backup, BackupError } from '../backup';
import type { FlowsaveConfig } from '../types';

describe('backup', () => {
  let tmpDir: string;
  let backupDir: string;
  let homeDir: string;

  const baseConfig: FlowsaveConfig = {
    instanceUrl: 'http://localhost:5678',
    apiKey: 'test-key',
    backupDir: '',
    gitBranch: 'main',
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flowsave-backup-test-'));
    backupDir = join(tmpDir, 'backups');
    homeDir = join(tmpDir, 'home');
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    mocks.getFlowsaveHome.mockReturnValue(homeDir);
    mocks.getWorkflows.mockResolvedValue([
      {
        id: 'wf-1',
        name: 'My Workflow',
        active: true,
        nodes: [],
        connections: {},
        parentFolderId: null,
        shared: [{ role: 'workflow:owner', workflowId: 'wf-1', projectId: 'proj-1' }],
      },
    ]);
    mocks.getFolders.mockResolvedValue([]);
    mocks.getVersion.mockResolvedValue('1.0.0');
    mocks.exportCredentials.mockResolvedValue({
      encrypted: Buffer.from('encrypted'),
      meta: [{ id: 'cred-1', name: 'My API Key', type: 'httpHeaderAuth' }],
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('creates snapshot directory and assigns ID 1 for first backup', async () => {
    const config = { ...baseConfig, backupDir };
    const snapshot = await backup({ config });

    expect(snapshot.id).toBe(1);
    expect(existsSync(join(backupDir, '1'))).toBe(true);
  });

  it('increments snapshot ID based on existing index', async () => {
    writeFileSync(
      join(homeDir, 'index.json'),
      JSON.stringify([
        { id: 1, timestamp: '', instanceUrl: '', sizeBytes: 0 },
        { id: 3, timestamp: '', instanceUrl: '', sizeBytes: 0 },
      ])
    );

    const config = { ...baseConfig, backupDir };
    const snapshot = await backup({ config });

    expect(snapshot.id).toBe(4);
  });

  it('writes meta.json with correct fields', async () => {
    const config = { ...baseConfig, backupDir };
    await backup({ config });

    const meta = JSON.parse(readFileSync(join(backupDir, '1', 'meta.json'), 'utf-8'));
    expect(meta.snapshotId).toBe(1);
    expect(meta.instanceUrl).toBe('http://localhost:5678');
    expect(meta.n8nVersion).toBe('1.0.0');
    expect(meta.workflowCount).toBe(1);
    expect(meta.credentialsIncluded).toBe(false);
    expect(typeof meta.timestamp).toBe('string');
    expect(typeof meta.sizeBytes).toBe('number');
    // Folder structure included because default mock returns [] (empty array, not null)
    expect(meta.folderStructureIncluded).toBe(true);
  });

  it('writes workflow JSON file at root level when no folder', async () => {
    const config = { ...baseConfig, backupDir };
    await backup({ config });

    expect(existsSync(join(backupDir, '1', 'My Workflow.json'))).toBe(true);
  });

  it('writes workflow in correct nested folder structure', async () => {
    mocks.getFolders.mockResolvedValue([
      { id: 'folder-1', name: 'DevOps', parentFolderId: null },
    ]);
    mocks.getWorkflows.mockResolvedValue([
      {
        id: 'wf-2',
        name: 'Deploy Pipeline',
        active: true,
        nodes: [],
        connections: {},
        parentFolderId: 'folder-1',
        shared: [{ role: 'workflow:owner', workflowId: 'wf-2', projectId: 'proj-1' }],
      },
    ]);

    const config = { ...baseConfig, backupDir };
    await backup({ config });

    expect(existsSync(join(backupDir, '1', 'DevOps', 'Deploy Pipeline.json'))).toBe(true);
  });

  it('appends a new entry to ~/.flowsave/index.json', async () => {
    const config = { ...baseConfig, backupDir };
    await backup({ config });

    const index = JSON.parse(readFileSync(join(homeDir, 'index.json'), 'utf-8'));
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe(1);
    expect(index[0].instanceUrl).toBe('http://localhost:5678');
    expect(typeof index[0].sizeBytes).toBe('number');
  });

  it('throws BackupError if passphrase is missing when containerName is set', async () => {
    const config = { ...baseConfig, backupDir, containerName: 'n8n' };
    await expect(backup({ config })).rejects.toThrow(BackupError);
  });

  it('includes credentials when containerName and passphrase are provided', async () => {
    const config = { ...baseConfig, backupDir, containerName: 'n8n' };
    const snapshot = await backup({ config, passphrase: 'test-pass' });

    expect(snapshot.credentialsIncluded).toBe(true);
    expect(existsSync(join(backupDir, '1', '_credentials.enc.json'))).toBe(true);
  });

  it('sanitizes unsafe characters in workflow names', async () => {
    mocks.getWorkflows.mockResolvedValue([
      {
        id: 'wf-3',
        name: 'Deploy/Pipeline:v2',
        active: false,
        nodes: [],
        connections: {},
        parentFolderId: null,
      },
    ]);

    const config = { ...baseConfig, backupDir };
    await backup({ config });

    expect(existsSync(join(backupDir, '1', 'Deploy_Pipeline_v2.json'))).toBe(true);
  });
});
