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

/**
 * Prompt pushed into the query when compaction finishes, or null when none is needed.
 * Auto-compaction interrupts work in flight, so the agent is told to carry on. If
 * follow-ups arrived while it was compacting, the nudge must send it to those first:
 * "do not wait for the user" alone steers it back to the old task and leaves the new
 * messages unanswered. Manual /compact is a user command, not an interruption, so it
 * gets no nudge (its follow-ups are already queued behind it).
 * @param auto - true when the SDK compacted on its own.
 * @param arrived - follow-up messages pushed into the query while compaction was running.
 */
export function compactResumeNudge(auto: boolean, arrived: number): string | null {
  if (!auto) return null;
  if (arrived > 0) {
    const noun = arrived === 1 ? 'message' : 'messages';
    return (
      `Your context was just compacted automatically. ${arrived} new ${noun} arrived while it was compacting; ` +
      'they are already in your input queue. Respond to them first, then continue any task you were working on before compaction.'
    );
  }
  return 'Your context was just compacted automatically. Continue the task you were working on before compaction; do not wait for the user.';
}
