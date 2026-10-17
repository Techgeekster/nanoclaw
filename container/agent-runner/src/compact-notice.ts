/**
 * Bridge from the provider's compaction signals to the poll loop. The PreCompact
 * hook and the compact_boundary event fire inside the SDK query and have no
 * routing context; the poll loop owns the current turn's route, so it registers
 * a listener for the life of a query.
 */
export interface CompactListener {
  /** PreCompact fired. `auto` is true when the SDK compacted on its own (context full). */
  onStart(auto: boolean): void;
  /** compact_boundary arrived — the summary is in place and the turn can continue. */
  onDone(): void;
}

let listener: CompactListener | null = null;

export function setCompactListener(l: CompactListener | null): void {
  listener = l;
}

export function notifyCompacting(auto: boolean): void {
  try {
    listener?.onStart(auto);
  } catch {
    // A notice failure must never block compaction.
  }
}

export function notifyCompacted(): void {
  try {
    listener?.onDone();
  } catch {
    // A notice failure must never block the turn.
  }
}
