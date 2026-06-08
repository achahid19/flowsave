import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Mock backup and restore before importing migrate
// ---------------------------------------------------------------------------
vi.mock('../backup', () => ({
  backup: vi.fn(),
  BackupError: class BackupError extends Error {},
}));

vi.mock('../restore', () => ({
  restore: vi.fn(),
  RestoreError: class RestoreError extends Error {},
}));

import { migrate } from '../migrate';
import { backup } from '../backup';
import { restore } from '../restore';
import type { FlowsaveConfig, Snapshot, SnapshotMeta } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSnapshot(id = 1): Snapshot {
  const meta: SnapshotMeta = {
    snapshotId: id,
    instanceUrl: 'http://source:5678',
    n8nVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    workflowCount: 2,
    credentialsIncluded: false,
  };
  return {
    id,
    meta,
    workflows: [],
    snapshotPath: `/tmp/backups/${id}`,
    credentialsIncluded: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrate', () => {
  let tmpDir: string;

  const config: FlowsaveConfig = {
    instanceUrl: 'http://source:5678',
    apiKey: 'source-key',
    backupDir: '',
    gitBranch: 'main',
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flowsave-migrate-test-'));
    mkdirSync(join(tmpDir, 'backups'), { recursive: true });
    vi.mocked(backup).mockResolvedValue(makeMockSnapshot(1));
    vi.mocked(restore).mockResolvedValue(makeMockSnapshot(1));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('calls backup with the source config', async () => {
    const configWithDir = { ...config, backupDir: join(tmpDir, 'backups') };
    await migrate({
      config: configWithDir,
      targetUrl: 'http://dest:5678',
      targetApiKey: 'dest-key',
    });

    expect(backup).toHaveBeenCalledOnce();
    expect(vi.mocked(backup).mock.calls[0][0].config).toMatchObject({
      instanceUrl: 'http://source:5678',
    });
  });

  it('calls restore with forceCreate=true (never update by ID on destination)', async () => {
    const configWithDir = { ...config, backupDir: join(tmpDir, 'backups') };
    await migrate({
      config: configWithDir,
      targetUrl: 'http://dest:5678',
      targetApiKey: 'dest-key',
    });

    expect(restore).toHaveBeenCalledOnce();
    const restoreCall = vi.mocked(restore).mock.calls[0][0];
    expect(restoreCall.forceCreate).toBe(true);
  });

  it('passes the destination URL and API key to restore', async () => {
    const configWithDir = { ...config, backupDir: join(tmpDir, 'backups') };
    await migrate({
      config: configWithDir,
      targetUrl: 'http://dest:5678',
      targetApiKey: 'dest-key',
    });

    const restoreCall = vi.mocked(restore).mock.calls[0][0];
    expect(restoreCall.targetUrl).toBe('http://dest:5678');
    expect(restoreCall.targetApiKey).toBe('dest-key');
  });

  it('passes the passphrase to both backup and restore', async () => {
    const configWithDir = { ...config, backupDir: join(tmpDir, 'backups') };
    await migrate({
      config: configWithDir,
      targetUrl: 'http://dest:5678',
      targetApiKey: 'dest-key',
      passphrase: 'secret-pass',
    });

    expect(vi.mocked(backup).mock.calls[0][0].passphrase).toBe('secret-pass');
    expect(vi.mocked(restore).mock.calls[0][0].passphrase).toBe('secret-pass');
  });

  it('uses the snapshot ID from backup in the restore call', async () => {
    vi.mocked(backup).mockResolvedValue(makeMockSnapshot(42));

    const configWithDir = { ...config, backupDir: join(tmpDir, 'backups') };
    await migrate({
      config: configWithDir,
      targetUrl: 'http://dest:5678',
      targetApiKey: 'dest-key',
    });

    expect(vi.mocked(restore).mock.calls[0][0].snapshotId).toBe(42);
  });

  it('returns the snapshot created from the source', async () => {
    const mockSnap = makeMockSnapshot(7);
    vi.mocked(backup).mockResolvedValue(mockSnap);

    const configWithDir = { ...config, backupDir: join(tmpDir, 'backups') };
    const result = await migrate({
      config: configWithDir,
      targetUrl: 'http://dest:5678',
      targetApiKey: 'dest-key',
    });

    expect(result.id).toBe(7);
  });

  it('propagates backup errors without swallowing', async () => {
    vi.mocked(backup).mockRejectedValue(new Error('network unreachable'));

    const configWithDir = { ...config, backupDir: join(tmpDir, 'backups') };
    await expect(
      migrate({
        config: configWithDir,
        targetUrl: 'http://dest:5678',
        targetApiKey: 'dest-key',
      })
    ).rejects.toThrow('network unreachable');
  });
});
