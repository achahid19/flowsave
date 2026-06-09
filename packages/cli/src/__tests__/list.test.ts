import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  readConfig: vi.fn(),
  ConfigValidationError: class extends Error {
    constructor(msg: string) { super(msg); this.name = 'ConfigValidationError'; }
  },
}));

vi.mock('@flowsave/core', () => ({
  listSnapshots: mocks.listSnapshots,
  readConfig: mocks.readConfig,
  ConfigValidationError: mocks.ConfigValidationError,
}));

import { register } from '../commands/list';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeProgram(): Command {
  const p = new Command().exitOverride();
  p.configureOutput({ writeErr: () => undefined });
  return p;
}

const SNAP1 = {
  id: 1,
  timestamp: '2026-06-09T08:00:00Z',
  instanceUrl: 'http://localhost:5678',
  sizeBytes: 1500,
};

const SNAP2 = {
  id: 2,
  timestamp: '2026-06-10T08:00:00Z',
  instanceUrl: 'http://localhost:5678',
  sizeBytes: 2048,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('flowsave list', () => {
  let output: string[] = [];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    output = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((str) => {
      output.push(typeof str === 'string' ? str : str.toString());
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
    mocks.readConfig.mockReturnValue({
      instanceUrl: 'http://localhost:5678',
      apiKey: 'key',
      backupDir: '/tmp/backups',
      gitBranch: 'main',
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('shows empty state message when no snapshots', async () => {
    mocks.listSnapshots.mockReturnValue([]);
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'list']);
    const all = output.join('');
    expect(all).toContain('No snapshots yet');
  });

  it('renders a table with snapshot data', async () => {
    mocks.listSnapshots.mockReturnValue([SNAP1, SNAP2]);
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'list']);
    const all = output.join('');
    expect(all).toContain('1');
    expect(all).toContain('2');
    expect(all).toContain('localhost:5678');
  });

  it('shows newest snapshot first (sorted by id desc)', async () => {
    mocks.listSnapshots.mockReturnValue([SNAP1, SNAP2]);
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'list']);
    const all = output.join('');
    const pos1 = all.indexOf('│ 1');
    const pos2 = all.indexOf('│ 2');
    // ID 2 should appear before ID 1 (newer first)
    expect(pos2).toBeLessThan(pos1);
  });

  it('truncates long instance URLs', async () => {
    const longUrl = 'http://' + 'a'.repeat(50) + '.example.com:5678';
    mocks.listSnapshots.mockReturnValue([{ ...SNAP1, instanceUrl: longUrl }]);
    const program = makeProgram();
    register(program);
    await program.parseAsync(['node', 'flowsave', 'list']);
    const all = output.join('');
    expect(all).toContain('...');
  });
});
