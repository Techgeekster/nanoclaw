# Context Management Strategy for NanoClaw

## Overview

To avoid burning through context with persistent agents, we've set up an **ephemeral task-based system**:

- **Ruby** stays persistent (8K token limit) as your orchestrator and Discord hub
- **Everything else** runs as one-off tasks (2K token limit) that execute, save work, and exit
- **Archives** preserve old work summaries without loading full context
- **INDEX.md** in Ruby's memory is the lightweight reference point for everything

---

## Structure

```
groups/dm-with-tia/
├── agent/
│   ├── cache/              ← Active artifacts (PRDs, code, designs)
│   ├── archive/            ← Completed work (full details stored here)
│   └── memory/
│       ├── INDEX.md        ← What's active + pointers to artifacts (ALWAYS LOADED)
│       └── preferences.md  ← Your preferences/standing decisions (ALWAYS LOADED)
├── task-templates.md       ← Copy-paste templates for creating tasks
└── instructions.prepend.md ← Ruby's instructions (updated with task workflow)
```

---

## How It Works

### 1. You Ask Ruby to Do Something
```
You: "Write a PRD for the new search feature"
```

### 2. Ruby Creates a Task with Full Instructions
```bash
ncl tasks create \
  --name "prd-search" \
  --prompt "[full PRD template with customizations]"
```

The prompt is **self-contained** — the task knows exactly what to do.

### 3. Task Executes (Ephemeral, ~2K tokens)
- Reads existing artifact (if updating)
- Incorporates your feedback
- Writes new/updated version to `/workspace/agent/cache/prd-search.md`
- Sends 2-line summary back to Ruby
- **Exits immediately** (no persistent context)

### 4. Ruby Updates INDEX.md
```markdown
## Search Feature PRD
- **Status**: Draft (awaiting feedback)
- **Last updated**: Sep 14
- **Latest artifact**: prd-search.md
- **Next step**: Review with stakeholders
```

### 5. You Review & Provide Feedback
```
You: "Update the PRD: change 'mobile first' to 'desktop primary'"
```

Ruby creates a new task that reads the existing PRD, applies changes, saves v2.

---

## Task Templates

Four template types available in `/workspace/agent/task-templates.md`:

1. **`prd-task`** — Research, write, iterate on PRDs (handles updates)
2. **`design-task`** — Create/update HTML/CSS mockups (handles design feedback)
3. **`code-task`** — Write code with tests (handles code review)
4. **`test-task`** — Unit, integration, E2E tests

Each template:
- ✅ Handles updates/feedback (reads existing file, applies changes)
- ✅ Saves to cache with predictable naming
- ✅ Sends Ruby a brief summary
- ✅ Exits (no context leak)

---

## Context Burn Comparison

### Old Way (Persistent Agents)
- 10 agents × 8K-20K tokens each = 80-200K tokens loaded at all times
- Every message loads full conversation history
- **Result**: Expensive, slow, context thrash

### New Way (Task-Based)
- Ruby stays loaded: 8K tokens
- Tasks spin up: 2K tokens each
- Tasks exit after completion
- INDEX.md is tiny (~500 tokens)
- **Result**: ~8.5K tokens baseline, +2K per active task, then back to 8.5K

---

## Example Workflow

### Scenario: Build a Search Feature

```
You: "Start a new project: search feature"
├─ Ruby creates task "prd-search"
├─ Task writes PRD, sends summary
├─ Ruby updates INDEX.md with status
└─ [Task exits, frees memory]

You: "The PRD looks good, but change search algorithm to Elasticsearch"
├─ Ruby creates task "prd-search-update"
├─ Task reads existing PRD, applies feedback
├─ Task writes updated PRD v2
├─ Sends summary: "Updated PRD: changed algorithm to Elasticsearch"
└─ [Task exits]

You: "Design the UI for search"
├─ Ruby creates task "design-search"
├─ Task creates HTML mockup
├─ Sends summary: "Search UI mockup ready, uses dark theme"
└─ [Task exits]

You: "Move the search box to the top of the page"
├─ Ruby creates task "design-search-update"
├─ Task reads existing design, modifies
├─ Task writes updated HTML
└─ [Task exits]

You: "Write the backend for search"
├─ Ruby creates task "code-search-api"
├─ Task writes Node/Express API with tests
├─ Sends summary: "Search API done: 45 tests passing, ready for review"
└─ [Task exits]
```

Throughout: Ruby's memory stays ~8K, tasks use ~2K each, then exit. No accumulation.

---

## How to Use Task Templates

### Copy the template
Open `/workspace/agent/task-templates.md`, find the task type you need.

### Customize the [BRACKETS]
```bash
# Example: you want a PRD for a "notification system"

ncl tasks create \
  --name "prd-notifications" \
  --prompt "You are a PRD researcher...
[REST OF TEMPLATE WITH YOUR CUSTOMIZATIONS]"
```

### Let Ruby know
Or just ask Ruby: "Write a PRD for the notification system"
Ruby will know to use the template and customize it.

---

## Updating Existing Work

When you want to modify something (PRD, design, code):

1. **Tell Ruby**: "Update the search PRD to add dark mode requirements"
2. **Ruby creates a new task** with the update template
3. **Task reads existing artifact** from cache
4. **Task applies your feedback** to the existing file
5. **Task sends back summary**: "Updated search PRD: added dark mode, accessibility requirements"
6. **Ruby updates INDEX.md**: timestamp + what changed

**Context cost for an update**: ~2K tokens (not the full original PRD)

---

## Memory Structure

### INDEX.md (Always Loaded)
```markdown
## [Project Name]
- Status: [current phase]
- Last updated: [date]
- Latest artifact: [filename]
- Next step: [what's next]
```

**Keep under 50 lines.** When a project finishes:
1. Move full details to `/workspace/agent/archive/[project]-[date].md`
2. Keep 1-2 line summary in INDEX.md

### preferences.md (Always Loaded)
Your standing preferences/decisions. Ruby references this on every turn.

### cache/ (Active Work)
Current artifacts that might be referenced soon.

### archive/ (Old Work)
Full project details, indexed by [name-date].

---

## Benefits

✅ **Low baseline context** (~8K with just Ruby loaded)
✅ **Cheap updates** (~2K per change)
✅ **No persistent burn** (tasks exit)
✅ **Full history preserved** (everything archived)
✅ **Easy to reference** (INDEX.md tells you where things are)
✅ **Iterative feedback** (easy to request changes)

---

## Next Steps

1. **Try a task**: Ask Ruby "Write a PRD for [your next feature]"
2. **Review the output**: It'll be in `/workspace/agent/cache/prd-[name].md`
3. **Give feedback**: "Update the PRD with [your feedback]"
4. **Watch Ruby update INDEX.md**: Status changes, archive pointers added
5. **Move things to archive**: When projects finish, Ruby can move full details to archive

---

## Quick Reference: Task Commands

```bash
# List all tasks
ncl tasks list

# Check status of a task
ncl tasks get prd-search-a25c

# Run a task now (testing)
ncl tasks run prd-search-a25c

# Update task prompt
ncl tasks update prd-search-a25c --prompt "New instructions..."

# Pause/resume
ncl tasks pause prd-search-a25c
ncl tasks resume prd-search-a25c

# Cancel a task
ncl tasks cancel prd-search-a25c

# Add a note to the run log
ncl tasks append-log --msg "Updated based on feedback"
```

---

## Questions?

- **"How do I see what tasks are running?"** → `ncl tasks list`
- **"How do I search old work?"** → Check `/workspace/agent/archive/` or ask Ruby to search it
- **"What if a task fails?"** → Ruby will tell you. Re-run with adjusted prompt.
- **"Can I see what a task is doing?"** → Not in real-time (tasks run independently), but Ruby gets the summary.
- **"How much does this cost?"** → Baseline ~8.5K tokens (Ruby + INDEX), plus ~2K per active task, then back down. Much cheaper than persistent agents.
