import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  backup: vi.fn(),
  readConfig: vi.fn(),
  ConfigValidationError: class extends Error {
    constructor(msg: string) { super(msg); this.name = 'ConfigValidationError'; }
  },
  prompt: vi.fn(),
}));

vi.mock('@flowsave/core', () => ({
  backup: mocks.backup,
  readConfig: mocks.readConfig,
  ConfigValidationError: mocks.ConfigValidationError,
}));

vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt } }));

import { register } from '../commands/backup';

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
  meta: { workflowCount: 3, instanceUrl: 'http://localhost:5678', snapshotId: 1, n8nVersion: '1.0', timestamp: '', credentialsIncluded: false },
  workflows: [],
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
describe('flowsave backup', () => {
  beforeEach(() => {
    mocks.readConfig.mockReturnValue(BASE_CONFIG);
    mocks.backup.mockResolvedValue(SNAPSHOT);
    // No containerName by default — no passphrase prompt
    mocks.prompt.mockResolvedValue({ pass: '' });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('calls backup() with config and no passphrase when no containerName', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'backup']);
    expect(mocks.backup).toHaveBeenCalledWith({
      config: BASE_CONFIG,
      passphrase: undefined,
    });
  });

  it('prompts for passphrase and confirmation when containerName is set', async () => {
    mocks.readConfig.mockReturnValue({ ...BASE_CONFIG, containerName: 'n8n' });
    mocks.prompt
      .mockResolvedValueOnce({ pass: 'mypass' })
      .mockResolvedValueOnce({ confirm: 'mypass' });
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'backup']);
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
    expect(mocks.backup).toHaveBeenCalledWith({
      config: expect.objectContaining({ containerName: 'n8n' }),
      passphrase: 'mypass',
    });
  });

  it('treats blank passphrase input as undefined and skips confirmation', async () => {
    mocks.readConfig.mockReturnValue({ ...BASE_CONFIG, containerName: 'n8n' });
    mocks.prompt.mockResolvedValueOnce({ pass: '   ' });
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'backup']);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.backup).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: undefined })
    );
  });

  it('exits 1 when passphrase confirmation does not match', async () => {
    mocks.readConfig.mockReturnValue({ ...BASE_CONFIG, containerName: 'n8n' });
    mocks.prompt
      .mockResolvedValueOnce({ pass: 'secret' })
      .mockResolvedValueOnce({ confirm: 'wrong' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(program.parseAsync(['node', 'flowsave', 'backup'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.backup).not.toHaveBeenCalled();
  });

  it('exits 1 when backup() throws', async () => {
    mocks.backup.mockRejectedValue(new Error('connection refused'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(program.parseAsync(['node', 'flowsave', 'backup'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
