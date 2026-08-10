# Workbench QA

## Test Approach

Workbench quality is measured as **premise adherence**: how well the running implementation delivers the stated product contract (the five pillars and task contract defined in [Architecture](../architecture/README.md)).

A test run guides a user through a complete end-to-end Workbench workflow and scores the result against each pillar.

## Premise Adherence Scoring

Each review scores the implementation against the product premise. History is tracked in `.scheme/workbench/review/PRDs/`.

| Review | Score | Key Finding |
|---|---|---|
| Review 0 | 6.1 / 10 | Core execution model, sessions, and secrets not implemented |
| Review 1 | 7.8 / 10 | Sessions added; sandbox broker not on execution path |
| Review 2 | 8.2 / 10 | Auto-approve CLI correct; Codex/sandbox broker still gaps |

## Test Plan 0

### Goal

Validate current premise adherence with one complete end-to-end Workbench flow:
- daemon-managed task
- Claude provider
- auto-approve enabled
- automatic port allocation
- artifact implementation (Astro app + React ASCII art component)
- Netlify preview URL produced

### Acceptance Criteria

1. `workbench init` completes without error.
2. `workbench task create` provisions sandbox and allocates ports.
3. Agent (Claude) executes the LLD artifact without human prompting.
4. Astro app with React ASCII art component is produced on the task branch.
5. `workbench deploy preview` returns a live Netlify URL.
6. Task transitions to `ready_for_review`.

### Current Status

**IN PROGRESS** — Prerequisites verified (docker, git, node, npm, workbench, claude). Paused to address architecture corrections before proceeding. Full tracker: `.scheme/workbench/qa/PRDs/test-plan-0-tracker.md`.

## Validation Process

1. Confirm prerequisites (docker, git, node, npm, workbench CLI, agent CLIs).
2. Configure credentials (`~/.workbench`) — see [Credentials](../credentials/README.md).
3. Run `workbench init`.
4. Create a task with `workbench task create`.
5. Monitor execution with `workbench status` and `workbench task status <taskId>`.
6. Verify artifact on task branch.
7. Deploy preview with `workbench deploy preview <taskId>`.
8. Record pass/fail evidence for each acceptance criterion.

## Durable vs. Ephemeral QA Records

- **Durable**: test process, acceptance criteria, and scoring rubric live here.
- **Ephemeral**: one-off execution history, live checklists, and evidence logs live in `.scheme/workbench/qa/PRDs/` trackers.
- **Adherence scores**: tracked in `.scheme/workbench/review/PRDs/`.

## See Also

- [Review](../review/README.md) — detailed review findings and current implementation gaps
- [Architecture](../architecture/README.md) — premise contract (five pillars, task contract)
- [Usage](../usage/README.md) — CLI reference for test execution commands
