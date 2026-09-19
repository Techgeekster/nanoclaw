# Complete NanoClaw Workflow Setup

**Date**: Sep 14, 2026  
**Status**: ✅ Complete and ready to use

## System Overview

- **Ruby** (claude-sonnet-5): Main agent, orchestrates all work
- **Home Assistant Manager** (claude-haiku-4-5): Smart home ops, direct Discord notification
- **All other agents deleted** to reduce context burn

## Folder Structure

```
/workspace/agent/cache/repos/
└── [owner/repo]/
    └── [milestone]/
        ├── prd-[feature]/
        │   ├── prd-[feature].md
        │   ├── design-[aspect].html
        │   ├── hld-[feature].md
        │   ├── tasks-[feature].md
        │   └── index.html
        ├── design-components.md (growing library)
        ├── tech-stack-reference.md (tech decisions)
```

## Task Templates Available

All templates stored in: `/workspace/agent/cache/groups/dm-with-tia/task-templates.md`

1. **PRD Task** - First PRD asks for GitHub repo + milestone, creates folder structure
2. **Design Task** - Angular/Ionic UI with Signals, co-located files (.ts, .html, .scss, .spec.ts)
3. **HLD Task** - Frontend + backend technical design, tech stack decisions
4. **Tasking Task** - Story point breakdown, GitHub issue publishing, APPROVAL gate
5. **Unit Test Task** - TDD: tests written FIRST, 80% coverage minimum
6. **Code Task** - Implement to pass tests, modern Angular standards, 80% coverage
7. **E2E Test Task** - Playwright user workflows, 80% coverage minimum
8. **Code Review Task** - Fresh agent reviews all artifacts, GREEN/ISSUES report

## Workflow Gates & Approvals

```
PRD (draft/review/finalize) → ClickUp
Design (draft/review/finalize) → ClickUp (linked to PRD)
HLD (draft/review/finalize) → ClickUp (linked to PRD)
Tasking (draft/review/APPROVE) → GitHub Issues
    ↓
Unit Tests (finalize)
Code (implement)
E2E Tests (finalize)
    ↓
Code Review (GREEN or ISSUES)
    ↓ GREEN LIGHT
User Approval → Merge to main ✅
```

## Tech Stack

**Frontend**: Angular + Ionic Capacitor (TypeScript, mobile-first)
**Backend**: Node.js + Express (TypeScript)
**Testing**: 
- Unit: Jasmine (Angular), Jest/Mocha (backend)
- E2E: Playwright
- Coverage minimum: 80% (lines, branches, functions, statements)

## Modern Angular Standards

✅ Signals-first (all reactive state)
✅ Standalone components (no NgModules)
✅ OnPush change detection
✅ 4-file component structure (.ts, .html, .scss, .spec.ts)
✅ Modern template syntax (@if, @for, @let)
✅ Signal Store (ngrx/signals) for shared state
✅ No subscribe in templates
✅ TypeScript strict mode
✅ Reference: angular.dev best practices

## Wildfire Monitoring

- Task: `monitor-fire-[name]`
- Frequency: Every 15 minutes (fast for rapid fires)
- Input: Fire tracking link
- Checks: Size, containment %, evacuation status
- Notifications: Phone push + TTS to announcement devices
- Coordination: Ruby → Home Assistant Manager → HA devices

## Key Files

- **Instructions**: `/groups/dm-with-tia/instructions.prepend.md` (Ruby's full workflow)
- **Templates**: `/groups/dm-with-tia/task-templates.md` (all task prompts)
- **Tech Stack**: `/groups/dm-with-tia/tech-stack-reference.md` (accumulated tech decisions)
- **Components**: `/groups/dm-with-tia/design-components.md` (growing Ionic pattern library)
- **Task Templates Doc**: `/groups/dm-with-tia/task-templates.md` (reference for tasks)
- **Context Management**: `CONTEXT_MANAGEMENT.md` (archived conversation summaries)

## Ruby's Memory Structure

```
memory/
├── INDEX.md (active work + recent tasks)
├── preferences.md (your standing preferences)
└── repos.md (active GitHub repos + milestones)
```

## Key Commands

```bash
# List current tasks
ncl tasks list

# Run task immediately
ncl tasks run [task-id]

# Restart Ruby container
ncl groups restart --id ag-1788211813242-nmfcqh

# Check Ruby's model
ncl groups config get --id ag-1788211813242-nmfcqh
```

## Usage Examples

**Start a new feature**:
```
You: "Write PRD for [feature name]"
Ruby: Creates first PRD, asks for GitHub repo + milestone, sets up folder structure
```

**Complete workflow for a feature**:
```
1. "Write PRD for search feature"
2. "Design search UI" (references PRD)
3. "Create HLD for search" (references PRD + Design)
4. "Break down search work" (references HLD)
   → APPROVE when ready
5. "Write unit tests for search"
6. "Implement search feature"
7. "Write E2E tests for search"
8. "Review search code"
   → GREEN or ISSUES FOUND
9. If GREEN: "Approve and merge"
```

## Context Management Strategy

✅ Task-based, ephemeral work (2K tokens per task, then exits)
✅ Archived conversation summaries in memory (cheap reference)
✅ Cached documents in /workspace/agent/cache/repos/ (permanent reference)
✅ Ruby stays persistent with INDEX.md (orchestration only)
✅ Result: ~8.5K baseline + 2K per active task

## GitHub Integration

- PRD publishes to ClickUp
- Design publishes to ClickUp (linked to PRD)
- HLD publishes to ClickUp (linked to PRD)
- Task breakdown publishes to GitHub as issues + milestone
- Code review blocks merge until GREEN
- User approval gates final merge

## What's Complete

✅ Ruby upgraded to Sonnet (better orchestration)
✅ All agents except Ruby + Home Assistant Manager deleted
✅ PRD, Design, HLD, Tasking, Unit Test, Code, E2E Test, Code Review tasks fully templated
✅ Modern Angular standards documented (Signals, standalone, 4-file structure)
✅ TDD workflow (tests first, code implements)
✅ ClickUp publishing for planning artifacts
✅ GitHub publishing for code tasks
✅ Code Review final gate (fresh agent, all standards)
✅ Folder structure by repo/milestone
✅ Design component library (growing Ionic patterns)
✅ Tech stack reference (accumulated decisions)
✅ Wildfire monitoring (15-min checks, mobile alerts)

## To Use

Just tell Ruby what you want:
- "Write PRD for [feature]"
- "Design [feature] UI"
- "Create HLD for [feature]"
- "Break down [feature] work"
- etc.

Ruby adapts templates intelligently, handles all coordination.

All context needed is in cached documents. Code review agent is completely fresh.
