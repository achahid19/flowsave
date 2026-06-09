/**
 * @flowsave/core — Snapshot pruning
 *
 * Scans the local snapshot index and identifies snapshots whose workflow
 * content is identical to a newer snapshot. Identical snapshots are redundant —
 * they add disk space without adding any recoverable state.
 *
 * Algorithm (newest-to-oldest):
 *   - Start with the newest snapshot as the reference point.
 *   - Walk backwards. If snapshot[i] is identical to the current reference,
 *     mark it for removal. If different, it becomes the new reference.
 *
 * "Identical" means: diff() returns 0 added, 0 removed, 0 modified.
 * Metadata differences (timestamp, sizeBytes) are ignored — only workflow
 * content matters.
 *
 * A snapshot that cannot be diffed (missing files, corrupt) is always kept.
 */

import { deleteSnapshot, listSnapshots } from './backup';
import { diff } from './diff';
import type { FlowsaveConfig, SnapshotIndexEntry } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PruneCandidate {
  /** Snapshot ID to be removed. */
  id: number;
  /** Timestamp string from the index entry. */
  timestamp: string;
  /** The ID of the newer snapshot this one is identical to. */
  identicalTo: number;
  /** Size in bytes (for reporting how much space is freed). */
  sizeBytes: number;
}

export interface PruneResult {
  /** Snapshots that were (or would be) removed. */
  removed: PruneCandidate[];
  /** Snapshot IDs that were kept. */
  kept: number[];
  /** Total bytes freed (or that would be freed on dry run). */
  bytesFreed: number;
  /** True when called with dryRun=true — no files were deleted. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Scan all local snapshots and remove (or report) identical consecutive ones.
 *
 * @param config  - Used to locate snapshotDir and backupDir.
 * @param dryRun  - If true, report what would be removed without deleting anything.
 */
export function pruneSnapshots(config: FlowsaveConfig, dryRun = false): PruneResult {
  const entries: SnapshotIndexEntry[] = listSnapshots().sort((a, b) => a.id - b.id);

  if (entries.length < 2) {
    return {
      removed: [],
      kept: entries.map((e) => e.id),
      bytesFreed: 0,
      dryRun,
    };
  }

  const candidates: PruneCandidate[] = [];

  // Walk from newest to oldest, tracking the last kept snapshot index.
  let refIdx = entries.length - 1; // newest is always kept

  for (let i = entries.length - 2; i >= 0; i--) {
    const current = entries[i];
    const reference = entries[refIdx];

    let identical = false;
    try {
      const result = diff(current.id, reference.id, config);
      identical =
        result.added.length === 0 &&
        result.removed.length === 0 &&
        result.modified.length === 0;
    } catch {
      // Can't diff (corrupt / missing files) — keep it to be safe
      identical = false;
    }

    if (identical) {
      candidates.push({
        id: current.id,
        timestamp: current.timestamp,
        identicalTo: reference.id,
        sizeBytes: current.sizeBytes ?? 0,
      });
    } else {
      refIdx = i;
    }
  }

  const removedIds = new Set(candidates.map((c) => c.id));
  const kept = entries.map((e) => e.id).filter((id) => !removedIds.has(id));
  const bytesFreed = candidates.reduce((sum, c) => sum + c.sizeBytes, 0);

  if (!dryRun) {
    // Delete in ascending ID order (oldest first) so index stays consistent
    for (const candidate of candidates.sort((a, b) => a.id - b.id)) {
      deleteSnapshot(candidate.id, config);
    }
  }

  return { removed: candidates, kept, bytesFreed, dryRun };
}
