import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  diff: vi.fn(),
  readConfig: vi.fn(),
  ConfigValidationError: class extends Error {
    constructor(msg: string) { super(msg); this.name = 'ConfigValidationError'; }
  },
}));

vi.mock('@flowsave/core', () => ({
  diff: mocks.diff,
  readConfig: mocks.readConfig,
  ConfigValidationError: mocks.ConfigValidationError,
}));

import { register } from '../commands/diff';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const BASE_CONFIG = {
  instanceUrl: 'http://localhost:5678',
  apiKey: 'key',
  backupDir: '/tmp/backups',
  gitBranch: 'main',
};

const DIFF_RESULT = {
  snapshotA: 1,
  snapshotB: 2,
  added: [{ name: 'NewWf', folderPath: [] }],
  removed: [],
  modified: [],
  unchanged: 3,
};

function makeProgram(): Command {
  const p = new Command().exitOverride();
  p.configureOutput({ writeErr: () => undefined });
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('flowsave diff', () => {
  let output: string[] = [];

  beforeEach(() => {
    mocks.readConfig.mockReturnValue(BASE_CONFIG);
    mocks.diff.mockReturnValue(DIFF_RESULT);
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('calls diff() with both IDs parsed as integers', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'diff', '1', '2']);
    expect(mocks.diff).toHaveBeenCalledWith(1, 2, BASE_CONFIG);
  });

  it('renders diff output to stdout', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'diff', '1', '2']);
    const all = output.join('');
    expect(all).toContain('Added');
    expect(all).toContain('NewWf');
  });

  it('exits 1 when snapshot id is not an integer', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(
      program.parseAsync(['node', 'flowsave', 'diff', 'abc', '2'])
    ).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when diff() throws', async () => {
    mocks.diff.mockImplementation(() => { throw new Error('snapshot not found'); });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(
      program.parseAsync(['node', 'flowsave', 'diff', '1', '99'])
    ).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
