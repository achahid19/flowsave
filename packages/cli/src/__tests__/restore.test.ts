import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  restore: vi.fn(),
  readConfig: vi.fn(),
  ConfigValidationError: class extends Error {
    constructor(msg: string) { super(msg); this.name = 'ConfigValidationError'; }
  },
  prompt: vi.fn(),
}));

vi.mock('@flowsave/core', () => ({
  restore: mocks.restore,
  readConfig: mocks.readConfig,
  ConfigValidationError: mocks.ConfigValidationError,
}));

vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt } }));

import { register } from '../commands/restore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const BASE_CONFIG = {
  instanceUrl: 'http://localhost:5678',
  apiKey: 'key',
  backupDir: '/tmp/backups',
  gitBranch: 'main',
};

const SNAPSHOT = {
  id: 1,
  meta: { workflowCount: 2, instanceUrl: 'http://localhost:5678', snapshotId: 1, n8nVersion: '1.0', timestamp: '', credentialsIncluded: false },
  workflows: [{ id: 'w1', name: 'A', folderPath: [], data: {} }, { id: 'w2', name: 'B', folderPath: [], data: {} }],
  snapshotPath: '/tmp/backups/1',
  credentialsIncluded: false,
};

function makeProgram(): Command {
  const p = new Command().exitOverride();
  p.configureOutput({ writeErr: () => undefined });
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('flowsave restore', () => {
  beforeEach(() => {
    mocks.readConfig.mockReturnValue(BASE_CONFIG);
    mocks.restore.mockResolvedValue(SNAPSHOT);
    mocks.prompt.mockResolvedValue({ pass: '' });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('calls restore() with parsed snapshotId via --snap flag', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'restore', '--snap', '5']);
    expect(mocks.restore).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 5 })
    );
  });

  it('calls restore() with parsed snapshotId via positional argument', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'restore', '7']);
    expect(mocks.restore).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 7 })
    );
  });

  it('exits 1 when no snapshot ID is provided', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(
      program.parseAsync(['node', 'flowsave', 'restore'])
    ).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('sets forceCreate=true when --to flag is provided', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync([
      'node', 'flowsave', 'restore',
      '--snap', '3',
      '--to', 'http://other:5678',
      '--api-key', 'other-key',
    ]);
    expect(mocks.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        forceCreate: true,
        targetUrl: 'http://other:5678',
        targetApiKey: 'other-key',
      })
    );
  });

  it('does not set forceCreate when no --to flag', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'restore', '--snap', '1']);
    expect(mocks.restore).toHaveBeenCalledWith(
      expect.objectContaining({ forceCreate: false })
    );
  });

  it('exits 1 on invalid snapshot id', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(
      program.parseAsync(['node', 'flowsave', 'restore', '--snap', 'abc'])
    ).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when restore() throws', async () => {
    mocks.restore.mockRejectedValue(new Error('snapshot not found'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(
      program.parseAsync(['node', 'flowsave', 'restore', '--snap', '99'])
    ).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
