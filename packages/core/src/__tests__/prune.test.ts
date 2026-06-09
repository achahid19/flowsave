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

import { pruneSnapshots } from '../prune';
import type { FlowsaveConfig } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a minimal workflow JSON into the snapshot directory. */
function writeWorkflow(snapshotDir: string, id: string, name: string, nodes: unknown[] = []): void {
  writeFileSync(
    join(snapshotDir, `${name}.json`),
    JSON.stringify({ id, name, active: false, nodes, connections: {} })
  );
}

describe('pruneSnapshots', () => {
  let tmpDir: string;
  let backupDir: string;
  let homeDir: string;
  let config: FlowsaveConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flowsave-prune-test-'));
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
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function seedIndex(ids: number[]): void {
    writeFileSync(
      join(homeDir, 'index.json'),
      JSON.stringify(
        ids.map((id) => ({
          id,
          timestamp: `2026-06-09T${String(id).padStart(2, '0')}:00:00Z`,
          instanceUrl: 'http://localhost:5678',
          sizeBytes: id * 100,
        }))
      )
    );
  }

  function makeSnapshot(id: number, workflows: Array<{ id: string; name: string; nodes?: unknown[] }>): void {
    const dir = join(backupDir, String(id));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ snapshotId: id }));
    for (const wf of workflows) {
      writeWorkflow(dir, wf.id, wf.name, wf.nodes ?? []);
    }
  }

  it('returns empty result when fewer than 2 snapshots', () => {
    seedIndex([1]);
    makeSnapshot(1, [{ id: 'wf-1', name: 'Workflow' }]);
    const result = pruneSnapshots(config, true);
    expect(result.removed).toHaveLength(0);
    expect(result.kept).toEqual([1]);
  });

  it('removes older snapshot when content is identical to newer', () => {
    seedIndex([1, 2]);
    const wfs = [{ id: 'wf-1', name: 'My Workflow' }];
    makeSnapshot(1, wfs);
    makeSnapshot(2, wfs);

    const result = pruneSnapshots(config, true);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].id).toBe(1);
    expect(result.removed[0].identicalTo).toBe(2);
    expect(result.kept).toEqual([2]);
  });

  it('keeps both snapshots when content differs', () => {
    seedIndex([1, 2]);
    makeSnapshot(1, [{ id: 'wf-1', name: 'Workflow', nodes: [] }]);
    makeSnapshot(2, [{ id: 'wf-1', name: 'Workflow', nodes: [{ type: 'n8n-nodes-base.start' }] }]);

    const result = pruneSnapshots(config, true);
    expect(result.removed).toHaveLength(0);
    expect(result.kept).toEqual([1, 2]);
  });

  it('handles a chain: keeps only the newest of identical snapshots', () => {
    seedIndex([1, 2, 3]);
    const wfs = [{ id: 'wf-1', name: 'Same' }];
    makeSnapshot(1, wfs);
    makeSnapshot(2, wfs);
    makeSnapshot(3, wfs);

    const result = pruneSnapshots(config, true);
    expect(result.removed.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(result.kept).toEqual([3]);
  });

  it('does not delete files when dryRun=true', () => {
    seedIndex([1, 2]);
    const wfs = [{ id: 'wf-1', name: 'Same' }];
    makeSnapshot(1, wfs);
    makeSnapshot(2, wfs);

    pruneSnapshots(config, true);
    expect(existsSync(join(backupDir, '1'))).toBe(true);
  });

  it('deletes files and updates index when dryRun=false', () => {
    seedIndex([1, 2]);
    const wfs = [{ id: 'wf-1', name: 'Same' }];
    makeSnapshot(1, wfs);
    makeSnapshot(2, wfs);

    pruneSnapshots(config, false);
    expect(existsSync(join(backupDir, '1'))).toBe(false);
    const index = JSON.parse(readFileSync(join(homeDir, 'index.json'), 'utf-8'));
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe(2);
  });

  it('computes bytesFreed correctly', () => {
    seedIndex([1, 2]);
    const wfs = [{ id: 'wf-1', name: 'Same' }];
    makeSnapshot(1, wfs);
    makeSnapshot(2, wfs);

    const result = pruneSnapshots(config, true);
    // sizeBytes for id=1 is 1*100 = 100 (from seedIndex helper)
    expect(result.bytesFreed).toBe(100);
  });
});
