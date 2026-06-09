import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
    getIndexPath: () => join(mocks.getFlowsaveHome(), 'index.json'),
  };
});

import { deleteSnapshot, DeleteError } from '../backup';
import type { FlowsaveConfig } from '../types';

describe('deleteSnapshot', () => {
  let tmpDir: string;
  let backupDir: string;
  let homeDir: string;
  let config: FlowsaveConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flowsave-delete-test-'));
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

    // Seed index with two snapshots
    writeFileSync(
      join(homeDir, 'index.json'),
      JSON.stringify([
        { id: 1, timestamp: '2026-06-09T10:00:00Z', instanceUrl: 'http://localhost:5678', sizeBytes: 100 },
        { id: 2, timestamp: '2026-06-09T11:00:00Z', instanceUrl: 'http://localhost:5678', sizeBytes: 200 },
      ])
    );

    // Create snapshot directories
    mkdirSync(join(backupDir, '1'), { recursive: true });
    writeFileSync(join(backupDir, '1', 'meta.json'), '{}');
    mkdirSync(join(backupDir, '2'), { recursive: true });
    writeFileSync(join(backupDir, '2', 'meta.json'), '{}');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('removes the snapshot directory from disk', () => {
    deleteSnapshot(1, config);
    expect(existsSync(join(backupDir, '1'))).toBe(false);
  });

  it('removes the entry from index.json', () => {
    deleteSnapshot(1, config);
    const index = JSON.parse(readFileSync(join(homeDir, 'index.json'), 'utf-8'));
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe(2);
  });

  it('leaves other snapshots untouched', () => {
    deleteSnapshot(1, config);
    expect(existsSync(join(backupDir, '2'))).toBe(true);
  });

  it('throws DeleteError when snapshot ID is not in index', () => {
    expect(() => deleteSnapshot(99, config)).toThrow(DeleteError);
  });

  it('still removes from index even if directory is missing from disk', () => {
    rmSync(join(backupDir, '1'), { recursive: true });
    deleteSnapshot(1, config);
    const index = JSON.parse(readFileSync(join(homeDir, 'index.json'), 'utf-8'));
    expect(index.find((e: { id: number }) => e.id === 1)).toBeUndefined();
  });
});
