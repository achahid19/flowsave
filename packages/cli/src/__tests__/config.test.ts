import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  writeConfig: vi.fn(),
  validateConfig: vi.fn(),
  getConfigPath: vi.fn(() => '/tmp/.flowsave/config.json'),
  getDefaultBackupDir: vi.fn(() => '/tmp/.flowsave/backups'),
  ConfigValidationError: class extends Error {
    constructor(msg: string) { super(msg); this.name = 'ConfigValidationError'; }
  },
  existsSync: vi.fn(() => false),
  prompt: vi.fn(),
}));

vi.mock('@flowsave/core', () => ({
  writeConfig: mocks.writeConfig,
  validateConfig: mocks.validateConfig,
  getConfigPath: mocks.getConfigPath,
  getDefaultBackupDir: mocks.getDefaultBackupDir,
  ConfigValidationError: mocks.ConfigValidationError,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mocks.existsSync };
});

vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt } }));

import { register } from '../commands/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const VALID_ANSWERS = {
  instanceUrl: 'http://localhost:5678',
  apiKey: 'n8n_api_abc123',
  containerName: '',
  backupDir: '/tmp/.flowsave/backups',
  gitRemote: '',
  gitBranch: 'main',
};

const VALIDATED_CONFIG = {
  instanceUrl: 'http://localhost:5678',
  apiKey: 'n8n_api_abc123',
  backupDir: '/tmp/.flowsave/backups',
  gitBranch: 'main',
};

function makeProgram(): Command {
  const p = new Command().exitOverride();
  p.configureOutput({ writeErr: () => undefined });
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('flowsave config init', () => {
  beforeEach(() => {
    mocks.existsSync.mockReturnValue(false);
    mocks.validateConfig.mockReturnValue(VALIDATED_CONFIG);
    mocks.prompt.mockResolvedValue(VALID_ANSWERS);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('calls writeConfig with validated answers when no existing config', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'config', 'init']);
    expect(mocks.validateConfig).toHaveBeenCalled();
    expect(mocks.writeConfig).toHaveBeenCalledWith(VALIDATED_CONFIG);
  });

  it('asks for overwrite confirmation when config exists', async () => {
    mocks.existsSync.mockReturnValue(true);
    // First prompt = overwrite confirm, second = config answers
    mocks.prompt
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce(VALID_ANSWERS);

    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'config', 'init']);
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
    expect(mocks.writeConfig).toHaveBeenCalled();
  });

  it('aborts without writing when user declines overwrite', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.prompt.mockResolvedValueOnce({ overwrite: false });

    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'config', 'init']);
    expect(mocks.writeConfig).not.toHaveBeenCalled();
  });

  it('exits 1 when validateConfig throws ConfigValidationError', async () => {
    mocks.validateConfig.mockImplementation(() => {
      throw new mocks.ConfigValidationError('instanceUrl is invalid');
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(
      program.parseAsync(['node', 'flowsave', 'config', 'init'])
    ).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
