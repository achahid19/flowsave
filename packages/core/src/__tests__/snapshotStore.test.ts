import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
  getFlowsaveHome: vi.fn(),
}));

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return {
    ...actual,
    getFlowsaveHome: mocks.getFlowsaveHome,
    getIndexPath: (): string => join(mocks.getFlowsaveHome(), 'index.json'),
  };
});

import {
  RESERVED_FILES,
  getSnapshotPath,
  listSnapshots,
  readIndex,
  readWorkflowsFromDisk,
  writeIndex,
} from '../snapshotStore';
import type { SnapshotIndexEntry } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const entry1: SnapshotIndexEntry = {
  id: 1,
  timestamp: '2026-06-01T10:00:00Z',
  instanceUrl: 'http://localhost:5678',
  sizeBytes: 100,
};

const entry2: SnapshotIndexEntry = {
  id: 2,
  timestamp: '2026-06-02T11:00:00Z',
  instanceUrl: 'http://localhost:5678',
  sizeBytes: 200,
};

const workflowFixture = {
  id: 'wf-1',
  name: 'My Workflow',
  active: true,
  nodes: [{ id: 'n1', type: 'n8n-nodes-base.start', position: [0, 0] }],
  connections: {},
  settings: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let homeDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'flowsave-store-test-'));
  homeDir = join(tmpDir, 'home');
  mkdirSync(homeDir, { recursive: true });
  mocks.getFlowsaveHome.mockReturnValue(homeDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// RESERVED_FILES
// ---------------------------------------------------------------------------

describe('RESERVED_FILES', () => {
  it('contains exactly the three expected filenames', () => {
    expect(RESERVED_FILES.has('meta.json')).toBe(true);
    expect(RESERVED_FILES.has('_credentials.enc.json')).toBe(true);
    expect(RESERVED_FILES.has('_credentials.meta.json')).toBe(true);
    expect(RESERVED_FILES.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getSnapshotPath
// ---------------------------------------------------------------------------

describe('getSnapshotPath', () => {
  it('joins backupDir with the string ID', () => {
    const backupDir = '/data/backups';
    expect(getSnapshotPath(backupDir, 3)).toBe(join(resolve('/data/backups'), '3'));
  });

  it('resolves a relative backupDir to an absolute path', () => {
    const result = getSnapshotPath('relative/path', 7);
    expect(result).toBe(join(resolve('relative/path'), '7'));
  });
});

// ---------------------------------------------------------------------------
// readIndex
// ---------------------------------------------------------------------------

describe('readIndex', () => {
  it('returns empty array when the file does not exist', () => {
    const result = readIndex(join(homeDir, 'nonexistent.json'));
    expect(result).toEqual([]);
  });

  it('returns entries when the file is a valid JSON array', () => {
    const indexPath = join(homeDir, 'index.json');
    writeFileSync(indexPath, JSON.stringify([entry1, entry2]));
    const result = readIndex(indexPath);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(2);
  });

  it('returns empty array when JSON is corrupt (not parseable)', () => {
    const indexPath = join(homeDir, 'index.json');
    writeFileSync(indexPath, 'not valid json {{{{');
    const result = readIndex(indexPath);
    expect(result).toEqual([]);
  });

  it('returns empty array when JSON is valid but not an array', () => {
    const indexPath = join(homeDir, 'index.json');
    writeFileSync(indexPath, JSON.stringify({ id: 1 }));
    const result = readIndex(indexPath);
    expect(result).toEqual([]);
  });

  it('returns empty array for an empty JSON array', () => {
    const indexPath = join(homeDir, 'index.json');
    writeFileSync(indexPath, '[]');
    expect(readIndex(indexPath)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeIndex
// ---------------------------------------------------------------------------

describe('writeIndex', () => {
  it('writes entries as pretty-printed JSON', () => {
    const indexPath = join(homeDir, 'index.json');
    writeIndex(indexPath, [entry1, entry2]);
    const raw = readFileSync(indexPath, 'utf-8');
    const parsed = JSON.parse(raw) as SnapshotIndexEntry[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe(1);
    expect(parsed[1].id).toBe(2);
  });

  it('overwrites an existing index file', () => {
    const indexPath = join(homeDir, 'index.json');
    writeIndex(indexPath, [entry1, entry2]);
    writeIndex(indexPath, [entry2]);
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as SnapshotIndexEntry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(2);
  });

  it('writes an empty array when entries is empty', () => {
    const indexPath = join(homeDir, 'index.json');
    writeIndex(indexPath, []);
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// readWorkflowsFromDisk
// ---------------------------------------------------------------------------

describe('readWorkflowsFromDisk', () => {
  let snapshotDir: string;

  beforeEach(() => {
    snapshotDir = join(tmpDir, 'snap1');
    mkdirSync(snapshotDir, { recursive: true });
  });

  it('returns empty array for a directory with no workflow JSON files', () => {
    writeFileSync(join(snapshotDir, 'meta.json'), '{}');
    const workflows = readWorkflowsFromDisk(snapshotDir);
    expect(workflows).toHaveLength(0);
  });

  it('returns a single workflow from a flat snapshot', () => {
    writeFileSync(join(snapshotDir, 'meta.json'), '{}');
    writeFileSync(join(snapshotDir, 'My_Workflow.json'), JSON.stringify(workflowFixture));

    const workflows = readWorkflowsFromDisk(snapshotDir);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].id).toBe('wf-1');
    expect(workflows[0].name).toBe('My Workflow');
    expect(workflows[0].folderPath).toEqual([]);
  });

  it('skips all three RESERVED_FILES', () => {
    writeFileSync(join(snapshotDir, 'meta.json'), '{}');
    writeFileSync(join(snapshotDir, '_credentials.enc.json'), '{"iv":"x","tag":"y","data":"z"}');
    writeFileSync(join(snapshotDir, '_credentials.meta.json'), '[]');
    writeFileSync(join(snapshotDir, 'Real_Workflow.json'), JSON.stringify(workflowFixture));

    const workflows = readWorkflowsFromDisk(snapshotDir);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].id).toBe('wf-1');
  });

  it('reconstructs folderPath from a single level of nesting', () => {
    const folderDir = join(snapshotDir, 'DevOps');
    mkdirSync(folderDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'meta.json'), '{}');
    writeFileSync(join(folderDir, 'Deploy_Workflow.json'), JSON.stringify(workflowFixture));

    const workflows = readWorkflowsFromDisk(snapshotDir);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].folderPath).toEqual(['DevOps']);
  });

  it('reconstructs folderPath from two levels of nesting', () => {
    const deepDir = join(snapshotDir, 'DevOps', 'Deploy');
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'meta.json'), '{}');
    writeFileSync(join(deepDir, 'Deploy_Workflow.json'), JSON.stringify(workflowFixture));

    const workflows = readWorkflowsFromDisk(snapshotDir);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].folderPath).toEqual(['DevOps', 'Deploy']);
  });

  it('collects workflows from multiple folders in one pass', () => {
    const wfB = { ...workflowFixture, id: 'wf-2', name: 'Beta Workflow' };
    const folderA = join(snapshotDir, 'Alpha');
    const folderB = join(snapshotDir, 'Beta');
    mkdirSync(folderA, { recursive: true });
    mkdirSync(folderB, { recursive: true });
    writeFileSync(join(snapshotDir, 'meta.json'), '{}');
    writeFileSync(join(folderA, 'Alpha_Workflow.json'), JSON.stringify(workflowFixture));
    writeFileSync(join(folderB, 'Beta_Workflow.json'), JSON.stringify(wfB));

    const workflows = readWorkflowsFromDisk(snapshotDir);
    expect(workflows).toHaveLength(2);
    expect(workflows.map((w) => w.id).sort()).toEqual(['wf-1', 'wf-2']);
  });

  it('throws when a workflow JSON file is not parseable', () => {
    writeFileSync(join(snapshotDir, 'meta.json'), '{}');
    writeFileSync(join(snapshotDir, 'Broken_Workflow.json'), 'not { valid } json');
    expect(() => readWorkflowsFromDisk(snapshotDir)).toThrow('Failed to parse workflow file');
  });
});

// ---------------------------------------------------------------------------
// listSnapshots
// ---------------------------------------------------------------------------

describe('listSnapshots', () => {
  it('returns empty array when no index file exists', () => {
    expect(listSnapshots()).toEqual([]);
  });

  it('returns all index entries when the index file exists', () => {
    const indexPath = join(homeDir, 'index.json');
    writeFileSync(indexPath, JSON.stringify([entry1, entry2]));
    const result = listSnapshots();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
  });

  it('creates the index file path via getIndexPath (uses mocked getFlowsaveHome)', () => {
    const indexPath = join(homeDir, 'index.json');
    writeFileSync(indexPath, JSON.stringify([entry1]));
    const result = listSnapshots();
    expect(result[0].id).toBe(1);
    expect(existsSync(indexPath)).toBe(true);
  });
});
