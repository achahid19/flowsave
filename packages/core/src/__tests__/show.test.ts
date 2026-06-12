import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
  getFlowsaveHome: vi.fn(),
}));

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return {
    ...actual,
    getFlowsaveHome: mocks.getFlowsaveHome,
    getIndexPath: (): string => join(mocks.getFlowsaveHome(), 'index.json'),
  };
});

import { readSnapshotDetail, ShowError } from '../snapshotStore';
import type { FlowsaveConfig } from '../types';

const baseMeta = {
  snapshotId: 1,
  instanceUrl: 'http://localhost:5678',
  n8nVersion: '1.90.0',
  timestamp: '2026-06-10T12:00:00Z',
  workflowCount: 2,
  credentialsIncluded: false,
  folderStructureIncluded: false,
  sizeBytes: 1024,
};

const workflowA = {
  id: 'wf-1',
  name: 'Alpha Workflow',
  active: true,
  nodes: [{ id: 'n1' }, { id: 'n2' }],
  connections: {},
};

const workflowB = {
  id: 'wf-2',
  name: 'Beta Workflow',
  active: false,
  nodes: [{ id: 'n3' }],
  connections: {},
};

describe('readSnapshotDetail', () => {
  let tmpDir: string;
  let backupDir: string;
  let homeDir: string;
  let config: FlowsaveConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flowsave-show-test-'));
    backupDir = join(tmpDir, 'backups');
    homeDir = join(tmpDir, 'home');
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    mocks.getFlowsaveHome.mockReturnValue(homeDir);

    config = {
      instanceUrl: 'http://localhost:5678',
      apiKey: 'key',
      backupDir,
      gitBranch: 'main',
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function seedSnapshot(id: number, workflows: Record<string, object> = {}, hasCreds = false): void {
    const snapDir = join(backupDir, String(id));
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, 'meta.json'), JSON.stringify({ ...baseMeta, snapshotId: id }));
    for (const [filename, data] of Object.entries(workflows)) {
      writeFileSync(join(snapDir, filename), JSON.stringify(data));
    }
    if (hasCreds) {
      writeFileSync(join(snapDir, '_credentials.enc.json'), '{"iv":"x","tag":"y","data":"z"}');
    }
  }

  it('returns meta and workflows for a valid snapshot', () => {
    seedSnapshot(1, {
      'Alpha_Workflow.json': workflowA,
      'Beta_Workflow.json': workflowB,
    });

    const detail = readSnapshotDetail(1, config);

    expect(detail.meta.snapshotId).toBe(1);
    expect(detail.meta.instanceUrl).toBe('http://localhost:5678');
    expect(detail.workflows).toHaveLength(2);
    expect(detail.workflows.map((w) => w.id)).toContain('wf-1');
    expect(detail.workflows.map((w) => w.id)).toContain('wf-2');
  });

  it('detects presence of credentials file', () => {
    seedSnapshot(2, { 'Alpha_Workflow.json': workflowA }, true);
    const detail = readSnapshotDetail(2, config);
    expect(detail.hasCredentials).toBe(true);
  });

  it('reports no credentials when file is absent', () => {
    seedSnapshot(3, { 'Alpha_Workflow.json': workflowA }, false);
    const detail = readSnapshotDetail(3, config);
    expect(detail.hasCredentials).toBe(false);
  });

  it('returns credentialMeta null when _credentials.meta.json is absent (older snapshot)', () => {
    seedSnapshot(7, { 'Alpha_Workflow.json': workflowA }, true);
    // No meta file written — simulates a snapshot from before meta support
    const detail = readSnapshotDetail(7, config);
    expect(detail.credentialMeta).toBeNull();
  });

  it('returns credentialMeta array when _credentials.meta.json is present', () => {
    const id = 8;
    seedSnapshot(id, { 'Alpha_Workflow.json': workflowA }, true);
    const snapDir = join(backupDir, String(id));
    const meta = [
      { id: 'c1', name: 'Airtable Key', type: 'airtableTokenApi' },
      { id: 'c2', name: 'Postgres DB', type: 'postgres' },
    ];
    writeFileSync(join(snapDir, '_credentials.meta.json'), JSON.stringify(meta));

    const detail = readSnapshotDetail(id, config);
    expect(detail.credentialMeta).toHaveLength(2);
    expect(detail.credentialMeta?.[0].name).toBe('Airtable Key');
    expect(detail.credentialMeta?.[1].type).toBe('postgres');
  });

  it('returns credentialMeta null when _credentials.meta.json is corrupt', () => {
    const id = 9;
    seedSnapshot(id, { 'Alpha_Workflow.json': workflowA }, true);
    const snapDir = join(backupDir, String(id));
    writeFileSync(join(snapDir, '_credentials.meta.json'), 'not-valid-json{{{');

    const detail = readSnapshotDetail(id, config);
    // Corrupt meta degrades gracefully — treat as absent
    expect(detail.credentialMeta).toBeNull();
  });

  it('reconstructs folderPath from nested directory structure', () => {
    const id = 4;
    const snapDir = join(backupDir, String(id));
    const folderDir = join(snapDir, 'DevOps', 'Deploy');
    mkdirSync(folderDir, { recursive: true });
    writeFileSync(join(snapDir, 'meta.json'), JSON.stringify({ ...baseMeta, snapshotId: id }));
    writeFileSync(join(folderDir, 'Deploy_Workflow.json'), JSON.stringify(workflowA));

    const detail = readSnapshotDetail(id, config);
    const wf = detail.workflows.find((w) => w.id === 'wf-1');
    expect(wf).toBeDefined();
    expect(wf?.folderPath).toEqual(['DevOps', 'Deploy']);
  });

  it('throws ShowError when snapshot directory does not exist', () => {
    expect(() => readSnapshotDetail(999, config)).toThrow(ShowError);
    expect(() => readSnapshotDetail(999, config)).toThrow('999 not found');
  });

  it('throws ShowError when meta.json is missing', () => {
    const snapDir = join(backupDir, '5');
    mkdirSync(snapDir, { recursive: true });
    expect(() => readSnapshotDetail(5, config)).toThrow(ShowError);
    expect(() => readSnapshotDetail(5, config)).toThrow('missing meta.json');
  });

  it('excludes meta.json and _credentials.enc.json from workflow list', () => {
    seedSnapshot(6, { 'Alpha_Workflow.json': workflowA }, true);
    const detail = readSnapshotDetail(6, config);
    const names = detail.workflows.map((w) => w.name);
    expect(names).not.toContain('meta');
    expect(names).not.toContain('_credentials');
    expect(detail.workflows).toHaveLength(1);
  });
});
