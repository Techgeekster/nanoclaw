export interface TaskContent {
  prompt: string;
  script: string | null;
  originSessionId: string | null;
  model: string | null;
}

/** Decode the storage-neutral task content envelope. */
export function parseTaskContent(raw: string): TaskContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      script: typeof parsed.script === 'string' ? parsed.script : null,
      originSessionId: typeof parsed.originSessionId === 'string' ? parsed.originSessionId : null,
      model: typeof parsed.model === 'string' ? parsed.model : null,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- LEGACY-COMPAT(v1-tasks): plain-string content predating the JSON envelope
  } catch {
    return { prompt: raw, script: null, originSessionId: null, model: null };
  }
}
