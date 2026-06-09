import { describe, it, expect } from 'vitest';
import { formatBytes, formatDate, renderDiff } from '../utils/format';
import type { DiffResult } from '@flowsave/core';

describe('formatBytes', () => {
  it('formats bytes under 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats KB with 1 decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024 - 1)).toMatch(/KB$/);
  });

  it('formats MB with 1 decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('formatDate', () => {
  it('returns a non-empty string for a valid ISO date', () => {
    const result = formatDate('2026-06-09T08:00:00Z');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the year', () => {
    const result = formatDate('2026-06-09T08:00:00Z');
    expect(result).toContain('2026');
  });
});

describe('renderDiff', () => {
  const empty: DiffResult = {
    snapshotA: 1,
    snapshotB: 2,
    added: [],
    removed: [],
    modified: [],
    unchanged: 5,
  };

  it('returns "identical" message when nothing changed', () => {
    const result = renderDiff(empty);
    expect(result).toContain('identical');
  });

  it('shows added workflows in green', () => {
    const result = renderDiff({
      ...empty,
      added: [{ name: 'New Workflow', folderPath: [] }],
    });
    expect(result).toContain('Added (1)');
    expect(result).toContain('New Workflow');
  });

  it('shows removed workflows', () => {
    const result = renderDiff({
      ...empty,
      removed: [{ name: 'Old Workflow', folderPath: ['DevOps'] }],
    });
    expect(result).toContain('Removed (1)');
    expect(result).toContain('Old Workflow');
    expect(result).toContain('[DevOps]');
  });

  it('shows modified workflows with node count delta', () => {
    const result = renderDiff({
      ...empty,
      modified: [
        {
          name: 'Changed',
          folderPath: [],
          changes: [{ field: 'nodes', before: [1, 2], after: [1, 2, 3] }],
        },
      ],
    });
    expect(result).toContain('Modified (1)');
    expect(result).toContain('Changed');
    expect(result).toContain('nodes: 2 → 3 (+1)');
  });

  it('shows active state change as before → after', () => {
    const result = renderDiff({
      ...empty,
      modified: [
        {
          name: 'Toggled',
          folderPath: [],
          changes: [{ field: 'active', before: true, after: false }],
        },
      ],
    });
    expect(result).toContain('active: true → false');
  });

  it('shows name rename as old → new', () => {
    const result = renderDiff({
      ...empty,
      modified: [
        {
          name: 'Renamed',
          folderPath: [],
          changes: [{ field: 'name', before: 'Old Name', after: 'New Name' }],
        },
      ],
    });
    expect(result).toContain('"Old Name" → "New Name"');
  });

  it('shows unchanged count when something else changed', () => {
    const result = renderDiff({
      ...empty,
      added: [{ name: 'A', folderPath: [] }],
      unchanged: 3,
    });
    expect(result).toContain('Unchanged: 3');
  });

  it('uses singular "workflow" for unchanged count of 1', () => {
    const result = renderDiff({
      ...empty,
      added: [{ name: 'A', folderPath: [] }],
      unchanged: 1,
    });
    expect(result).toContain('Unchanged: 1 workflow');
    expect(result).not.toContain('workflows');
  });
});
