import { describe, expect, it } from 'bun:test';

import type { MessageInRow } from '../db/messages-in.js';
import { taskRunModel } from './task-script.js';

const msg = (kind: string, content: string) => ({ id: 'm', kind, content }) as MessageInRow;

describe('taskRunModel', () => {
  it('reads the model from a task', () => {
    expect(taskRunModel([msg('task', '{"prompt":"x","model":"opus"}')])).toBe('opus');
  });

  it('finds the task in a mixed batch', () => {
    expect(taskRunModel([msg('chat', '{"text":"hi"}'), msg('task', '{"prompt":"x","model":"haiku"}')])).toBe('haiku');
  });

  it('leaves the group model alone when no task names one', () => {
    expect(taskRunModel([msg('task', '{"prompt":"x"}')])).toBeUndefined();
    expect(taskRunModel([msg('task', '{"prompt":"x","model":null}')])).toBeUndefined();
    expect(taskRunModel([msg('task', 'plain v1 prompt')])).toBeUndefined();
  });

  it('ignores a model field outside a task', () => {
    expect(taskRunModel([msg('chat', '{"model":"opus"}')])).toBeUndefined();
  });
});
