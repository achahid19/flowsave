/**
 * @flowsave/core — Git sync
 *
 * Stages a snapshot directory, commits it, and pushes to the user's remote.
 *
 * Security:
 * - All git commands use spawnSync with an argument array — no shell injection
 * - The remote URL comes from the user's config, not from the network
 * - No credentials are passed through this module (SSH keys or HTTPS tokens
 *   are handled by the user's git credential store)
 *
 * The Pro gate is on automated scheduling of this operation, not on this
 * module existing. The code is fully open-source.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GitSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitSyncError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RunOptions {
  cwd: string;
}

/**
 * Run a git command with an argument array (safe from shell injection).
 * Throws GitSyncError on non-zero exit.
 */
function runGit(args: string[], options: RunOptions): string {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf-8',
  });

  if (result.error) {
    throw new GitSyncError(`Failed to run git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    throw new GitSyncError(
      `git ${args[0]} failed (exit ${result.status})${stderr ? `: ${stderr}` : ''}`
    );
  }

  return result.stdout?.trim() ?? '';
}

/**
 * Check if a directory is already a git repository.
 */
function isGitRepo(dir: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  return result.status === 0 && result.stdout?.trim() === 'true';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Stage the snapshot directory, commit it, and push to the configured remote.
 *
 * If the directory is not yet a git repo, it will be initialized first.
 * A .gitignore is created to ensure only snapshot JSON files are tracked.
 *
 * @param snapshotPath - Absolute path to the snapshot directory to commit
 * @param remote       - Git remote URL (e.g. git@github.com:user/n8n-backups.git)
 * @param branch       - Branch to push to (e.g. "main")
 */
export async function pushToGit(
  snapshotPath: string,
  remote: string,
  branch: string
): Promise<void> {
  if (!existsSync(snapshotPath)) {
    throw new GitSyncError(`Snapshot path does not exist: ${snapshotPath}`);
  }

  // The git repo lives in the parent of the snapshot directory (the backupDir)
  // so all snapshots are tracked in one repo.
  const repoDir = join(snapshotPath, '..');

  // 1. Initialize git repo if needed
  if (!isGitRepo(repoDir)) {
    mkdirSync(repoDir, { recursive: true });
    runGit(['init', '-b', branch], { cwd: repoDir });
    runGit(['remote', 'add', 'origin', remote], { cwd: repoDir });

    // Write a .gitignore to exclude the encrypted credential files from git
    // (they are encrypted, but we keep them in the backup dir, not the git repo)
    writeFileSync(
      join(repoDir, '.gitignore'),
      '# Flowsave — exclude encrypted credential bundles from git\n_credentials.enc.json\n',
      'utf-8'
    );
  } else {
    // Ensure remote is set correctly
    const remotes = spawnSync('git', ['remote'], {
      cwd: repoDir,
      encoding: 'utf-8',
    });
    if (!remotes.stdout?.includes('origin')) {
      runGit(['remote', 'add', 'origin', remote], { cwd: repoDir });
    } else {
      runGit(['remote', 'set-url', 'origin', remote], { cwd: repoDir });
    }
  }

  // 2. Stage all changes in the snapshot directory
  runGit(['add', snapshotPath], { cwd: repoDir });

  // 3. Commit — use a standard message format
  const timestamp = new Date().toISOString();
  const snapshotId = snapshotPath.split('/').pop() ?? 'unknown';
  const message = `chore: flowsave backup ${timestamp} snapshot-${snapshotId}`;

  // Check if the snapshot files were actually staged (not the whole working tree,
  // which may have untracked/deleted files from previously pruned snapshots).
  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], {
    cwd: repoDir,
  });
  // exit 0 = nothing staged, exit 1 = staged changes present
  if (staged.status === 0) {
    return;
  }

  // Configure a minimal git identity if not set (CI / fresh environments)
  const nameCheck = spawnSync('git', ['config', 'user.name'], {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  if (!nameCheck.stdout?.trim()) {
    runGit(['config', 'user.name', 'Flowsave'], { cwd: repoDir });
    runGit(['config', 'user.email', 'flowsave@localhost'], { cwd: repoDir });
  }

  runGit(['commit', '-m', message], { cwd: repoDir });

  // 4. Push to remote — HEAD:<branch> works regardless of local branch name
  //    (the repo may have been initialized on 'master' before this config was set)
  runGit(['push', '-u', 'origin', `HEAD:${branch}`], { cwd: repoDir });
}
