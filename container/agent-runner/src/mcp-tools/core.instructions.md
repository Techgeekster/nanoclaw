## Outbound tools

The runtime system prompt lists your destinations and explains how final output is handled in this session. Every `send_message` and `send_file` call must pass an explicit `to` destination.

### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ to, path, text?, filename? })` to deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a specific inbound message by its `#N` id — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`eyes` = seen, `white_check_mark` = done) when a full reply would be noise. `emoji` is the shortcode name (e.g. `thumbs_up`, `heart`), not the raw character.

### Naming threads (`rename_thread`)

When a new thread starts (a fresh Discord thread created for this
conversation, distinct from a reply in an already-named one), call
`mcp__nanoclaw__rename_thread({ name })` once you understand what the
conversation is about — usually right after your first reply, not before.
Give it a short, specific name (e.g. "Vet appointment scheduling", not
"Chat" or a restatement of the first message). Only do this once per
thread; don't re-rename an already-sensibly-named thread just because the
topic shifts slightly. It's a no-op outside Discord threads, so it's safe
to call whenever it seems relevant.

### Internal thoughts

Wrap reasoning in `<internal>...</internal>` tags to mark it as scratchpad — logged but not sent.
