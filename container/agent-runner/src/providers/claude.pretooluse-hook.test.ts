import { describe, expect, it } from 'bun:test';

import { preToolUseHook } from './claude.js';

const run = (tool_name: string, tool_input: Record<string, unknown>) =>
  preToolUseHook({ hook_event_name: 'PreToolUse', tool_name, tool_input } as never, undefined, {
    signal: new AbortController().signal,
  }) as Promise<{ continue?: boolean; hookSpecificOutput?: { permissionDecision?: string } }>;

describe('PreToolUse hook: sub-agent model ban', () => {
  it.each(['fable', 'claude-fable-5', 'Claude-Fable-5'])('denies an Agent call on %s', async (model) => {
    const result = await run('Agent', { prompt: 'x', model });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies the older Task tool name too', async () => {
    const result = await run('Task', { prompt: 'x', model: 'fable' });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it.each(['haiku', 'sonnet', 'opus', 'claude-opus-5', undefined])('lets %s through', async (model) => {
    const result = await run('Agent', { prompt: 'x', model });
    expect(result).toEqual({ continue: true });
  });

  it('ignores a model field on other tools', async () => {
    const result = await run('Read', { file_path: '/x', model: 'fable' });
    expect(result).toEqual({ continue: true });
  });
});
