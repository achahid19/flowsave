import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { pushToGit, GitSyncError } from '../gitSync';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a local bare repo to act as the remote. */
function makeBareRepo(dir: string): string {
  const bare = join(dir, 'remote.git');
  mkdirSync(bare, { recursive: true });
  spawnSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf-8' });
  return bare;
}

/** Create a snapshot directory with a single workflow JSON file. */
function makeSnapshot(backupDir: string, id: number): string {
  const snapshotPath = join(backupDir, String(id));
  mkdirSync(snapshotPath, { recursive: true });
  writeFileSync(join(snapshotPath, 'meta.json'), JSON.stringify({ snapshotId: id }));
  writeFileSync(join(snapshotPath, 'MyWorkflow.json'), JSON.stringify({ id: 'wf1', name: 'My Workflow' }));
  return snapshotPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pushToGit', () => {
  let tmpDir: string;
  let backupDir: string;
  let remoteUrl: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flowsave-gitsync-'));
    backupDir = join(tmpDir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    remoteUrl = `file://${makeBareRepo(tmpDir)}`;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes a git repo and pushes the snapshot on first call', async () => {
    const snapshotPath = makeSnapshot(backupDir, 1);

    await pushToGit(snapshotPath, remoteUrl, 'main');

    // Verify the remote received the commit
    const log = spawnSync('git', ['log', '--oneline', 'main'], {
      cwd: `${tmpDir}/remote.git`,
      encoding: 'utf-8',
    });
    expect(log.status).toBe(0);
    expect(log.stdout.trim()).toMatch(/flowsave backup/);
  });

  it('creates a .gitignore that excludes _credentials.enc.json', async () => {
    const snapshotPath = makeSnapshot(backupDir, 1);
    await pushToGit(snapshotPath, remoteUrl, 'main');

    const gitignore = readFileSync(join(backupDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('_credentials.enc.json');
  });

  it('does not create a second commit when called again with no new files', async () => {
    const snapshotPath = makeSnapshot(backupDir, 1);

    await pushToGit(snapshotPath, remoteUrl, 'main');
    await pushToGit(snapshotPath, remoteUrl, 'main');

    const log = spawnSync('git', ['log', '--oneline', 'main'], {
      cwd: `${tmpDir}/remote.git`,
      encoding: 'utf-8',
    });
    // Still only one commit
    expect(log.stdout.trim().split('\n').length).toBe(1);
  });

  it('commits and pushes a second snapshot added after the first', async () => {
    const snap1 = makeSnapshot(backupDir, 1);
    await pushToGit(snap1, remoteUrl, 'main');

    const snap2 = makeSnapshot(backupDir, 2);
    await pushToGit(snap2, remoteUrl, 'main');

    const log = spawnSync('git', ['log', '--oneline', 'main'], {
      cwd: `${tmpDir}/remote.git`,
      encoding: 'utf-8',
    });
    expect(log.stdout.trim().split('\n').length).toBe(2);
  });

  it('propagates a branch name change on subsequent pushes', async () => {
    const snap1 = makeSnapshot(backupDir, 1);
    await pushToGit(snap1, remoteUrl, 'main');

    const snap2 = makeSnapshot(backupDir, 2);
    await pushToGit(snap2, remoteUrl, 'backups');

    // Both branches should exist on the remote
    const branches = spawnSync('git', ['branch'], {
      cwd: `${tmpDir}/remote.git`,
      encoding: 'utf-8',
    });
    expect(branches.stdout).toContain('main');
    expect(branches.stdout).toContain('backups');
  });

  it('does not commit _credentials.enc.json (excluded by .gitignore)', async () => {
    const snapshotPath = makeSnapshot(backupDir, 1);
    // Drop an encrypted credential file into the snapshot
    writeFileSync(join(snapshotPath, '_credentials.enc.json'), 'encrypted');

    await pushToGit(snapshotPath, remoteUrl, 'main');

    // Clone the remote and verify the file is absent
    const cloneDir = join(tmpDir, 'clone');
    spawnSync('git', ['clone', remoteUrl, cloneDir], { encoding: 'utf-8' });
    expect(existsSync(join(cloneDir, '1', '_credentials.enc.json'))).toBe(false);
  });

  it('throws GitSyncError when snapshot path does not exist', async () => {
    await expect(
      pushToGit(join(backupDir, 'nonexistent', '999'), remoteUrl, 'main')
    ).rejects.toThrow(GitSyncError);
  });
});
