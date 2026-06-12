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
  activateWorkflow: vi.fn(),
  deactivateWorkflow: vi.fn(),
  updateWorkflowTags: vi.fn(),
  getCredentials: vi.fn(),
  deleteCredential: vi.fn(),
  importCredentials: vi.fn(),
  importCredentialsViaApi: vi.fn(),
  getFlowsaveHome: vi.fn(),
}));

vi.mock('../n8nClient', () => {
  class MockN8nClient {
    updateWorkflow = mocks.updateWorkflow;
    createWorkflow = mocks.createWorkflow;
    createFolder = mocks.createFolder;
    activateWorkflow = mocks.activateWorkflow;
    deactivateWorkflow = mocks.deactivateWorkflow;
    updateWorkflowTags = mocks.updateWorkflowTags;
    getCredentials = mocks.getCredentials;
    deleteCredential = mocks.deleteCredential;
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
  importCredentialsViaApi: mocks.importCredentialsViaApi,
}));

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return {
    ...actual,
    getFlowsaveHome: mocks.getFlowsaveHome,
    // getIndexPath must be mocked too: it calls getFlowsaveHome() internally (same-module
    // scope), so the export-level mock above doesn't affect it.
    getIndexPath: (): string => join(mocks.getFlowsaveHome(), 'index.json'),
  };
});

import { restore, RestoreError } from '../restore';
import { N8nApiError } from '../n8nClient';
import type { CredentialMeta, FlowsaveConfig, SnapshotMeta } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeSnapshot(
  homeDir: string,
  backupDir: string,
  snapshotId: number,
  workflows: {
    name: string;
    folder?: string;
    active?: boolean;
    tags?: Array<{ id: string; name: string }>;
  }[],
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
      JSON.stringify({
        id: `wf-${wf.name}`,
        name: wf.name,
        active: wf.active ?? true,
        nodes: [],
        connections: {},
        ...(wf.tags !== undefined && { tags: wf.tags }),
      })
    );
  }

  if (includeCreds) {
    writeFileSync(join(snapshotPath, '_credentials.enc.json'), Buffer.from('encrypted'));
  }
}

/**
 * Write credential meta alongside the credential blob.
 * Call after writeSnapshot when the test exercises pruning or API path.
 */
function writeCredMeta(backupDir: string, snapshotId: number, meta: CredentialMeta[]): void {
  const snapshotPath = join(backupDir, String(snapshotId));
  writeFileSync(join(snapshotPath, '_credentials.meta.json'), JSON.stringify(meta));
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
    mocks.updateWorkflow.mockResolvedValue({ id: 'wf-1', name: 'Test', active: true, nodes: [], connections: {} });
    mocks.createWorkflow.mockResolvedValue({ id: 'wf-new', name: 'Test', active: false, nodes: [], connections: {} });
    mocks.createFolder.mockResolvedValue({ id: 'folder-new', name: 'DevOps', parentFolderId: null });
    mocks.activateWorkflow.mockResolvedValue(undefined);
    mocks.deactivateWorkflow.mockResolvedValue(undefined);
    mocks.updateWorkflowTags.mockResolvedValue(undefined);
    mocks.getCredentials.mockResolvedValue([]);
    mocks.deleteCredential.mockResolvedValue(undefined);
    mocks.importCredentials.mockResolvedValue(undefined);
    mocks.importCredentialsViaApi.mockResolvedValue([]);
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

  // -------------------------------------------------------------------------
  // Active-state fidelity — only flip when current state differs from snapshot
  // -------------------------------------------------------------------------

  it('activates when snapshot was active but target is currently inactive', async () => {
    mocks.updateWorkflow.mockResolvedValue({ id: 'wf-1', name: 'X', active: false, nodes: [], connections: {} });
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Wf', active: true }]);

    await restore({ snapshotId: 1, config });

    expect(mocks.activateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(mocks.deactivateWorkflow).not.toHaveBeenCalled();
  });

  it('does not activate when target is already active (no redundant call)', async () => {
    mocks.updateWorkflow.mockResolvedValue({ id: 'wf-1', name: 'X', active: true, nodes: [], connections: {} });
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Wf', active: true }]);

    await restore({ snapshotId: 1, config });

    expect(mocks.activateWorkflow).not.toHaveBeenCalled();
    expect(mocks.deactivateWorkflow).not.toHaveBeenCalled();
  });

  it('deactivates when snapshot was inactive but target is currently active', async () => {
    mocks.updateWorkflow.mockResolvedValue({ id: 'wf-1', name: 'X', active: true, nodes: [], connections: {} });
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Wf', active: false }]);

    await restore({ snapshotId: 1, config });

    expect(mocks.deactivateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(mocks.activateWorkflow).not.toHaveBeenCalled();
  });

  it('never deactivates in forceCreate mode (fresh workflows start inactive)', async () => {
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Wf', active: false }]);

    await restore({ snapshotId: 1, config, forceCreate: true });

    expect(mocks.deactivateWorkflow).not.toHaveBeenCalled();
    expect(mocks.activateWorkflow).not.toHaveBeenCalled();
  });

  it('activates a freshly-created workflow in forceCreate mode when snapshot was active', async () => {
    // createWorkflow mock returns active:false (n8n creates workflows inactive)
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Wf', active: true }]);

    await restore({ snapshotId: 1, config, forceCreate: true });

    expect(mocks.activateWorkflow).toHaveBeenCalledWith('wf-new');
  });

  // -------------------------------------------------------------------------
  // Tag fidelity
  // -------------------------------------------------------------------------

  it('restores tags on same-instance restore', async () => {
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [
      { name: 'Tagged', tags: [{ id: 'tag1', name: 'prod' }] },
    ]);

    await restore({ snapshotId: 1, config });

    expect(mocks.updateWorkflowTags).toHaveBeenCalledWith('wf-1', [{ id: 'tag1', name: 'prod' }]);
  });

  it('does not restore tags in forceCreate mode (tag IDs differ across instances)', async () => {
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [
      { name: 'Tagged', tags: [{ id: 'tag1', name: 'prod' }] },
    ]);

    await restore({ snapshotId: 1, config, forceCreate: true });

    expect(mocks.updateWorkflowTags).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Credential restore — three paths
  // -------------------------------------------------------------------------

  it('path A: cross-instance without targetContainer calls importCredentialsViaApi, not importCredentials', async () => {
    const config = { ...baseConfig, backupDir, containerName: 'source-n8n' };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Workflow' }], true);
    mocks.importCredentialsViaApi.mockResolvedValue([
      { id: 'c1', name: 'API Key', type: 'httpHeaderAuth', success: true },
    ]);

    await restore({ snapshotId: 1, config, forceCreate: true, passphrase: 'pass' });

    expect(mocks.importCredentialsViaApi).toHaveBeenCalledOnce();
    expect(mocks.importCredentials).not.toHaveBeenCalled();
  });

  it('CRITICAL: cross-instance never uses config.containerName as the target container', async () => {
    // Bug fixed: cross-instance restore was falling back to config.containerName
    // which would import credentials into the SOURCE container, not the target.
    const config = { ...baseConfig, backupDir, containerName: 'source-n8n' };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Workflow' }], true);
    mocks.importCredentialsViaApi.mockResolvedValue([]);

    await restore({ snapshotId: 1, config, forceCreate: true, passphrase: 'pass' });

    // importCredentials (docker exec path) must NOT have been called with the source container
    expect(mocks.importCredentials).not.toHaveBeenCalled();
    // The API path is taken instead — importCredentialsViaApi is called
    expect(mocks.importCredentialsViaApi).toHaveBeenCalledOnce();
  });

  it('path A: credentialImportResults are included in the returned Snapshot', async () => {
    const config = { ...baseConfig, backupDir };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Workflow' }], true);
    const mockResults = [
      { id: 'c1', name: 'API Key', type: 'httpHeaderAuth', success: true },
      { id: 'c2', name: 'OAuth', type: 'oAuth2Api', success: false, error: 'validation error' },
    ];
    mocks.importCredentialsViaApi.mockResolvedValue(mockResults);

    const result = await restore({ snapshotId: 1, config, forceCreate: true, passphrase: 'pass' });

    expect(result.credentialImportResults).toEqual(mockResults);
  });

  it('path B: cross-instance WITH targetContainer calls importCredentials on that container, not source', async () => {
    const config = { ...baseConfig, backupDir, containerName: 'source-n8n' };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Workflow' }], true);

    await restore({
      snapshotId: 1,
      config,
      forceCreate: true,
      targetContainerName: 'dest-n8n',
      passphrase: 'pass',
    });

    expect(mocks.importCredentials).toHaveBeenCalledOnce();
    const [calledContainer] = mocks.importCredentials.mock.calls[0] as [string, ...unknown[]];
    expect(calledContainer).toBe('dest-n8n');
    expect(calledContainer).not.toBe('source-n8n');
    expect(mocks.importCredentialsViaApi).not.toHaveBeenCalled();
  });

  it('path C: same-instance prunes credentials absent from snapshot meta', async () => {
    // Bug fixed: after importing, stale credentials on the instance were not removed.
    const config = { ...baseConfig, backupDir, containerName: 'n8n' };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Workflow' }], true);
    writeCredMeta(backupDir, 1, [{ id: 'c1', name: 'API Key', type: 'httpHeaderAuth' }]);

    mocks.getCredentials.mockResolvedValue([
      { id: 'c1', name: 'API Key', type: 'httpHeaderAuth' },
      { id: 'c2', name: 'Stale Cred', type: 'httpHeaderAuth' },
    ]);

    await restore({ snapshotId: 1, config, passphrase: 'pass' });

    expect(mocks.deleteCredential).toHaveBeenCalledOnce();
    expect(mocks.deleteCredential).toHaveBeenCalledWith('c2');
  });

  it('path C: does NOT delete credentials still present in snapshot meta', async () => {
    const config = { ...baseConfig, backupDir, containerName: 'n8n' };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Workflow' }], true);
    writeCredMeta(backupDir, 1, [
      { id: 'c1', name: 'API Key', type: 'httpHeaderAuth' },
      { id: 'c2', name: 'DB Pass', type: 'postgres' },
    ]);

    mocks.getCredentials.mockResolvedValue([
      { id: 'c1', name: 'API Key', type: 'httpHeaderAuth' },
      { id: 'c2', name: 'DB Pass', type: 'postgres' },
    ]);

    await restore({ snapshotId: 1, config, passphrase: 'pass' });

    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });

  it('path C: skips pruning gracefully when _credentials.meta.json is absent', async () => {
    // _credentials.meta.json was introduced in the same release as pruning.
    // Older snapshots won't have it — pruning must be silently skipped.
    const config = { ...baseConfig, backupDir, containerName: 'n8n' };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Workflow' }], true);
    // No writeCredMeta call — no meta file

    mocks.getCredentials.mockResolvedValue([{ id: 'c1', name: 'Key', type: 'httpHeaderAuth' }]);

    await expect(restore({ snapshotId: 1, config, passphrase: 'pass' })).resolves.not.toThrow();
    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });

  it('CRITICAL: corrupt _credentials.meta.json must NOT delete any credentials', async () => {
    // Bug fixed: a parse failure left snapshotMeta = [] and the (length >= 0)
    // guard was always true — pruning ran with an empty ID set and deleted
    // EVERY credential on the instance. Pruning must be skipped instead.
    const config = { ...baseConfig, backupDir, containerName: 'n8n' };
    writeSnapshot(homeDir, backupDir, 1, [{ name: 'Workflow' }], true);
    writeFileSync(join(backupDir, '1', '_credentials.meta.json'), '{corrupt json!!');

    mocks.getCredentials.mockResolvedValue([
      { id: 'c1', name: 'API Key', type: 'httpHeaderAuth' },
      { id: 'c2', name: 'DB Pass', type: 'postgres' },
    ]);

    const result = await restore({ snapshotId: 1, config, passphrase: 'pass' });

    expect(mocks.deleteCredential).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('pruning was skipped')])
    );
  });
});
