import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Hoist mock fns
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  updateWorkflow: vi.fn(),
  createWorkflow: vi.fn(),
  createFolder: vi.fn(),
  importCredentials: vi.fn(),
  getFlowsaveHome: vi.fn(),
}));

vi.mock('../n8nClient', () => {
  class MockN8nClient {
    updateWorkflow = mocks.updateWorkflow;
    createWorkflow = mocks.createWorkflow;
    createFolder = mocks.createFolder;
  }

  class N8nApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = 'N8nApiError';
      this.statusCode = statusCode;
    }
  }

  return { N8nClient: MockN8nClient, N8nApiError };
});

vi.mock('../credentials', () => ({
  importCredentials: mocks.importCredentials,
}));

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return { ...actual, getFlowsaveHome: mocks.getFlowsaveHome };
});

import { restore, RestoreError } from '../restore';
import { N8nApiError } from '../n8nClient';
import type { FlowsaveConfig, SnapshotMeta } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeSnapshot(
  homeDir: string,
  backupDir: string,
  snapshotId: number,
  workflows: { name: string; folder?: string }[],
  includeCreds = false
): void {
  writeFileSync(
    join(homeDir, 'index.json'),
    JSON.stringify([{ id: snapshotId, timestamp: '', instanceUrl: 'http://localhost:5678', sizeBytes: 0 }])
  );

  const snapshotPath = join(backupDir, String(snapshotId));
  mkdirSync(snapshotPath, { recursive: true });

  const meta: SnapshotMeta = {
    snapshotId,
    instanceUrl: 'http://localhost:5678',
    n8nVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    workflowCount: workflows.length,
    credentialsIncluded: includeCreds,
  };
  writeFileSync(join(snapshotPath, 'meta.json'), JSON.stringify(meta));

  for (const wf of workflows) {
    const dir = wf.folder ? join(snapshotPath, wf.folder) : snapshotPath;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${wf.name}.json`),
      JSON.stringify({ id: `wf-${wf.name}`, name: wf.name, active: true, nodes: [], connections: {} })
    );
  }

  if (includeCreds) {
    writeFileSync(join(snapshotPath, '_credentials.enc.json'), Buffer.from('encrypted'));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('restore', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'flowsave-restore-test-'));
    backupDir = join(tmpDir, 'backups');
    homeDir = join(tmpDir, 'home');
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    mocks.getFlowsaveHome.mockReturnValue(homeDir);
    mocks.updateWorkflow.mockResolvedValue({ id: 'wf-1', name: 'Test' });
    mocks.createWorkflow.mockResolvedValue({ id: 'wf-new', name: 'Test' });
    mocks.createFolder.mockResolvedValue({ id: 'folder-new', name: 'DevOps', parentFolderId: null });
    mocks.importCredentials.mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('throws RestoreError if snapshot ID is not in index', async () => {
    writeFileSync(join(homeDir, 'index.json'), JSON.stringify([]));
    const config = { ...baseConfig, backupDir };
    await expect(restore({ snapshotId: 99, config })).rejects.toThrow(RestoreError);
  });

  it('throws RestoreError if index file is missing', async () => {
    const config = { ...baseConfig, backupDir };
    await expect(restore({ snapshotId: 1, config })).rejects.toThrow(RestoreError);
  });

  it('calls updateWorkflow for each workflow (same-instance mode)', async () => {
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'My Workflow' }]);

    await restore({ snapshotId: 1, config });

    expect(mocks.updateWorkflow).toHaveBeenCalledOnce();
  });

  it('falls back to createWorkflow when updateWorkflow returns 404', async () => {
    mocks.updateWorkflow.mockRejectedValue(new N8nApiError('not found', 404));

    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'My Workflow' }]);

    await restore({ snapshotId: 1, config });

    expect(mocks.createWorkflow).toHaveBeenCalledOnce();
  });

  it('calls createWorkflow directly in forceCreate mode', async () => {
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'My Workflow' }]);

    await restore({ snapshotId: 1, config, forceCreate: true });

    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
    expect(mocks.createWorkflow).toHaveBeenCalledOnce();
  });

  it('creates folders before workflows when folder structure exists', async () => {
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Deploy', folder: 'DevOps' }]);

    await restore({ snapshotId: 1, config, forceCreate: true });

    expect(mocks.createFolder).toHaveBeenCalledWith('DevOps', null);
    expect(mocks.createWorkflow).toHaveBeenCalledOnce();
  });

  it('falls back to flat restore if folder creation fails', async () => {
    mocks.createFolder.mockRejectedValue(new N8nApiError('not found', 404));

    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Deploy', folder: 'DevOps' }]);

    await restore({ snapshotId: 1, config, forceCreate: true });

    expect(mocks.createWorkflow).toHaveBeenCalledOnce();
    const callArgs = mocks.createWorkflow.mock.calls[0][0] as { parentFolderId: null };
    expect(callArgs.parentFolderId).toBeNull();
  });

  it('skips credential restore when no passphrase provided', async () => {
    const config = { ...baseConfig, backupDir, containerName: 'n8n' };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Workflow' }], true);

    await restore({ snapshotId: 1, config });

    expect(mocks.importCredentials).not.toHaveBeenCalled();
  });

  it('restores credentials when passphrase and containerName are provided', async () => {
    const config = { ...baseConfig, backupDir, containerName: 'n8n' };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Workflow' }], true);

    await restore({ snapshotId: 1, config, passphrase: 'my-pass' });

    expect(mocks.importCredentials).toHaveBeenCalledOnce();
  });

  it('returns correct snapshot object', async () => {
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Test Workflow' }]);

    const result = await restore({ snapshotId: 1, config });

    expect(result.id).toBe(1);
    expect(result.meta.instanceUrl).toBe('http://localhost:5678');
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].name).toBe('Test Workflow');
  });
});
