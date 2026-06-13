import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  getConfigPath: vi.fn(() => '/Users/test/.flowsave/config.json'),
  expandHome: vi.fn((p: string) => p),
  ConfigValidationError: class extends Error {
    constructor(msg: string) { super(msg); this.name = 'ConfigValidationError'; }
  },
  fetch: vi.fn(),
  execSync: vi.fn(),
  accessSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('@flowsave/core', () => ({
  readConfig: mocks.readConfig,
  getConfigPath: mocks.getConfigPath,
  expandHome: mocks.expandHome,
  ConfigValidationError: mocks.ConfigValidationError,
}));

vi.mock('child_process', () => ({ execSync: mocks.execSync }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    accessSync: mocks.accessSync,
    mkdirSync: mocks.mkdirSync,
    constants: actual.constants,
  };
});

vi.stubGlobal('fetch', mocks.fetch);

import { register } from '../commands/doctor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const BASE_CONFIG = {
  instanceUrl: 'http://localhost:5678',
  apiKey: 'key',
  backupDir: '/tmp/backups',
  gitBranch: 'main',
};

function makeProgram(): Command {
  const p = new Command().exitOverride();
  p.configureOutput({ writeErr: () => undefined });
  return p;
}

function okFetchResponse() {
  return Promise.resolve({ ok: true, status: 200 } as Response);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('flowsave doctor', () => {
  let output: string[] = [];

  beforeEach(() => {
    mocks.readConfig.mockReturnValue(BASE_CONFIG);
    mocks.fetch.mockImplementation(okFetchResponse);
    mocks.execSync.mockReturnValue('n8n');
    mocks.accessSync.mockReturnValue(undefined);
    mocks.mkdirSync.mockReturnValue(undefined);
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('reports all checks passed when everything is fine', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'doctor']);
    const all = output.join('\n');
    expect(all).toContain('All checks passed');
  });

  it('reports config failure when readConfig throws', async () => {
    mocks.readConfig.mockImplementation(() => {
      throw new mocks.ConfigValidationError('Config not found');
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(program.parseAsync(['node', 'flowsave', 'doctor'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('reports instance unreachable on network error', async () => {
    mocks.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(program.parseAsync(['node', 'flowsave', 'doctor'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output.join('\n')).toContain('ECONNREFUSED');
  });

  it('reports invalid API key on 401 response', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 401 } as Response);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(program.parseAsync(['node', 'flowsave', 'doctor'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const all = output.join('\n');
    expect(all).toContain('401');
  });

  it('skips docker check when no containerName configured', async () => {
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'doctor']);
    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it('checks docker when containerName is configured', async () => {
    mocks.readConfig.mockReturnValue({ ...BASE_CONFIG, containerName: 'n8n' });
    mocks.execSync.mockReturnValue('n8n');
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'doctor']);
    expect(mocks.execSync).toHaveBeenCalled();
  });

  it('reports docker failure when container not found', async () => {
    mocks.readConfig.mockReturnValue({ ...BASE_CONFIG, containerName: 'n8n' });
    mocks.execSync.mockReturnValue(''); // Container not running
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(program.parseAsync(['node', 'flowsave', 'doctor'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('shows usermod fix hint when docker daemon is inaccessible without sudo', async () => {
    // Bug fixed: permission denied on `docker info` was showing the same generic
    // "is Docker installed?" message as a missing daemon — now shows the actionable
    // usermod fix so users on Linux know exactly how to solve it.
    mocks.readConfig.mockReturnValue({ ...BASE_CONFIG, containerName: 'n8n' });
    mocks.execSync.mockImplementation((cmd: string) => {
      if (String(cmd).startsWith('docker info')) {
        throw new Error(
          'Got permission denied while trying to connect to the Docker daemon socket'
        );
      }
      return '';
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const program = makeProgram();
    register(program);
    await expect(program.parseAsync(['node', 'flowsave', 'doctor'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const all = output.join('\n');
    expect(all).toContain('docker group');
    expect(all).toContain('usermod');
  });
});
