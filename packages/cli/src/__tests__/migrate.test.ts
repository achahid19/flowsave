import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  migrate: vi.fn(),
  readConfig: vi.fn(),
  ConfigValidationError: class extends Error {
    constructor(msg: string) { super(msg); this.name = 'ConfigValidationError'; }
  },
  prompt: vi.fn(),
}));

vi.mock('@flowsave/core', () => ({
  migrate: mocks.migrate,
  readConfig: mocks.readConfig,
  ConfigValidationError: mocks.ConfigValidationError,
}));

vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt } }));

import { register } from '../commands/migrate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const BASE_CONFIG = {
  instanceUrl: 'http://source:5678',
  apiKey: 'source-key',
  backupDir: '/tmp/backups',
  gitBranch: 'main',
};

const SNAPSHOT = {
  id: 7,
  meta: { workflowCount: 4, instanceUrl: 'http://source:5678', snapshotId: 7, n8nVersion: '1.0', timestamp: '', credentialsIncluded: false },
  workflows: [],
  snapshotPath: '/tmp/backups/7',
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
describe('flowsave migrate', () => {
  beforeEach(() => {
    mocks.readConfig.mockReturnValue(BASE_CONFIG);
    mocks.migrate.mockResolvedValue(SNAPSHOT);
    mocks.prompt.mockResolvedValue({ pass: '' });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('calls migrate() with --to and --api-key', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync([
      'node', 'flowsave', 'migrate',
      '--to', 'http://dest:5678',
      '--api-key', 'dest-key',
    ]);
    expect(mocks.migrate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: BASE_CONFIG,
        targetUrl: 'http://dest:5678',
        targetApiKey: 'dest-key',
        passphrase: undefined,
      })
    );
  });

  it('passes passphrase when --passphrase flag provided', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync([
      'node', 'flowsave', 'migrate',
      '--to', 'http://dest:5678',
      '--api-key', 'dest-key',
      '--passphrase', 'secret',
    ]);
    expect(mocks.migrate).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: 'secret' })
    );
  });

  it('exits 1 when migrate() throws', async () => {
    mocks.migrate.mockRejectedValue(new Error('network error'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(
      program.parseAsync([
        'node', 'flowsave', 'migrate',
        '--to', 'http://dest:5678',
        '--api-key', 'dest-key',
      ])
    ).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prompts for confirmation when passphrase is non-empty and proceeds on match', async () => {
    mocks.prompt
      .mockResolvedValueOnce({ pass: 'secret' })
      .mockResolvedValueOnce({ confirm: 'secret' });
    const program = makeProgram();
    register(program);
    await program.parseAsync([
      'node', 'flowsave', 'migrate',
      '--to', 'http://dest:5678',
      '--api-key', 'dest-key',
    ]);
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
    expect(mocks.migrate).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: 'secret' })
    );
  });

  it('exits 1 when passphrase confirmation does not match', async () => {
    mocks.prompt
      .mockResolvedValueOnce({ pass: 'secret' })
      .mockResolvedValueOnce({ confirm: 'wrong' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(
      program.parseAsync([
        'node', 'flowsave', 'migrate',
        '--to', 'http://dest:5678',
        '--api-key', 'dest-key',
      ])
    ).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it('skips confirmation when passphrase provided via --passphrase flag', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync([
      'node', 'flowsave', 'migrate',
      '--to', 'http://dest:5678',
      '--api-key', 'dest-key',
      '--passphrase', 'secret',
    ]);
    // prompt should not be called at all (no interactive prompts when flag is used)
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.migrate).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: 'secret' })
    );
  });
});
