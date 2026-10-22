import { afterEach, describe, expect, it } from 'bun:test';

import { setCompactListener } from '../compact-notice.js';
import { createPreCompactHook } from './claude.js';

afterEach(() => setCompactListener(null));

const hookInput = (extra: Record<string, unknown> = {}) =>
  ({
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    custom_instructions: null,
    session_id: 'sess-1',
    transcript_path: '/nonexistent/transcript.jsonl',
    cwd: '/workspace/agent',
    ...extra,
  }) as never;

const run = (input: never) => createPreCompactHook('Ruby')(input, undefined, { signal: new AbortController().signal });

describe('PreCompact hook', () => {
  it('announces a compaction of the main conversation', async () => {
    const starts: boolean[] = [];
    setCompactListener({ onStart: (auto) => starts.push(auto), onDone: () => {} });
    await run(hookInput());
    expect(starts).toEqual([true]);
  });

  it('stays silent when a sub-agent compacts its own context', async () => {
    const starts: boolean[] = [];
    setCompactListener({ onStart: (auto) => starts.push(auto), onDone: () => {} });
    await run(hookInput({ agent_id: 'agent-a1215acd4f72f2b01', agent_type: 'general-purpose' }));
    expect(starts).toEqual([]);
  });
});
