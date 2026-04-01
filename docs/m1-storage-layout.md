# M1 Storage Layout

## Purpose

Freeze the on-disk layout for `M1 Terminal Shell Kernel`.

The storage layer must be:

- inspectable by a human
- recoverable after interruption
- simple enough to debug with plain file tools

M1 does not aim for database sophistication.

M1 aims for a storage layout that makes runtime state visible.

## Decisions Frozen In Phase 3

1. Use a hybrid model:
   - current state in `json`
   - append-only audit and memory streams in `jsonl`
2. Keep one session per directory.
3. Keep one active task per session in M1.
4. Keep timeline append-only.
5. Keep memory append-only.
6. Use single-writer locking per session.
7. Prefer atomic rewrite for mutable state files.
8. Do not copy full skill bodies into storage.

## Storage Root

Runtime storage root for M1:

```text
storage/
```

This is runtime data, not source code.

Persistence code will live under `code/storage/`, but runtime files live under `storage/`.

## Root Layout

```text
storage/
├── sessions/
│   └── <session-id>/
│       ├── session.json
│       ├── task.json
│       ├── plan_steps.json
│       ├── approvals.json
│       ├── timeline.jsonl
│       ├── context/
│       │   ├── latest-selection.json
│       │   └── latest-merged-context.json
│       └── locks/
│           └── writer.lock
└── memory/
    ├── session/
    │   └── <session-id>.jsonl
    └── project/
        └── <project-key>.jsonl
```

## Session Directory

Path:

```text
storage/sessions/<session-id>/
```

Purpose:

- contain all current-state and audit files for one resumable session

### `session.json`

Type:

- mutable current-state file

Contains:

- `Session`

Canonical:

- yes

Write rule:

- rewrite atomically

### `task.json`

Type:

- mutable current-state file

Contains:

- current `Task`

Canonical:

- yes

Write rule:

- rewrite atomically

### `plan_steps.json`

Type:

- mutable current-state file

Contains:

- ordered array of current `PlanStep` objects

Canonical:

- yes

Write rule:

- rewrite atomically

Reason:

- one file is easier to inspect than many tiny step files in M1

### `approvals.json`

Type:

- mutable current-state file

Contains:

- array of current `ApprovalRequest` objects for the session

Canonical:

- yes

Write rule:

- rewrite atomically

Reason:

- timeline preserves approval history
- this file preserves the current approval state snapshot

### `timeline.jsonl`

Type:

- append-only event log

Contains:

- `TimelineEvent` records, one JSON object per line

Canonical:

- yes

Write rule:

- append only

Reason:

- timeline is the audit spine of the shell

### `context/latest-selection.json`

Type:

- derived snapshot

Contains:

- selected context sources for the latest execution turn

Canonical:

- no

Write rule:

- rewrite freely

Reason:

- useful for inspection and debugging
- safe to regenerate

### `context/latest-merged-context.json`

Type:

- derived snapshot

Contains:

- bounded merged context payload prepared for execution

Canonical:

- no

Write rule:

- rewrite freely

Reason:

- helps inspect the context router without replaying the whole shell

### `locks/writer.lock`

Type:

- ephemeral lock file

Contains:

- process metadata for the current writer

Canonical:

- no

Purpose:

- enforce one active writer per session in M1

Rule:

- if lock is present and live, another writer must refuse to mutate state

## Memory Layout

### `storage/memory/session/<session-id>.jsonl`

Purpose:

- persist session-scoped memory entries

Format:

- append-only JSON Lines

Contains:

- `MemoryEntry` records with `scope = session`

Rule:

- no in-place mutation
- superseding or retracting memory appends a new record

### `storage/memory/project/<project-key>.jsonl`

Purpose:

- persist durable project-scoped memory entries

Format:

- append-only JSON Lines

Contains:

- `MemoryEntry` records with `scope = project`

Rule:

- no in-place mutation
- new decisions or corrections append new entries

## Skill Resolution Rules

Skills are runtime assets, not persisted copies.

M1 rule set:

1. Load skill definitions from configured skill roots.
2. Record selected skills as references only.
3. Do not copy `SKILL.md` bodies into `storage/`.
4. If a referenced skill disappears, keep the old reference and mark it stale on next load.
5. Skill selection for the latest turn may appear in `context/latest-selection.json`.

## File Format Rules

- Use UTF-8.
- Use RFC 3339 timestamps in UTC.
- Use stable field naming in `snake_case`.
- Use `json` for mutable current state.
- Use `jsonl` for append-only logs and memory.
- One JSON object per line in `jsonl`, no pretty printing.

## Atomic Write Rules

For mutable canonical files:

- write to sibling temp file
- fsync if supported by the implementation layer
- rename into place

Applies to:

- `session.json`
- `task.json`
- `plan_steps.json`
- `approvals.json`

M1 does not require multi-file transactions.

Instead:

- each state mutation should write current state
- each important state change should also emit a timeline event

## Canonical vs Derived

Canonical files:

- `session.json`
- `task.json`
- `plan_steps.json`
- `approvals.json`
- `timeline.jsonl`
- `storage/memory/session/<session-id>.jsonl`
- `storage/memory/project/<project-key>.jsonl`

Derived files:

- `context/latest-selection.json`
- `context/latest-merged-context.json`

Derived files may be deleted and rebuilt.

## Recovery Model

### Case 1 — Clean resume

Resume from:

- `session.json`
- `task.json`
- `plan_steps.json`
- `approvals.json`

Use:

- `timeline.jsonl` for audit and display

### Case 2 — Process crash during planning or execution

Reload:

- current state from the mutable files

Then:

- append `session_recovered`
- move `Session.status` to `blocked`
- move `Task.status` to `blocked` if it was active

### Case 3 — Derived context files missing

Behavior:

- recompute them

No recovery risk:

- they are not canonical

### Case 4 — Lock file is stale

Behavior:

- validate recorded PID and timestamp
- if the writer is gone, clear the stale lock and record a recovery event

## Inspectability Example

Given session `01JZSESSION...`, a human should be able to inspect:

```text
storage/sessions/01JZSESSION.../session.json
storage/sessions/01JZSESSION.../task.json
storage/sessions/01JZSESSION.../plan_steps.json
storage/sessions/01JZSESSION.../approvals.json
storage/sessions/01JZSESSION.../timeline.jsonl
storage/memory/session/01JZSESSION....jsonl
storage/memory/project/newagent.jsonl
```

This should be enough to answer:

- what the shell was doing
- what step it was on
- whether it is blocked
- what approvals are pending
- what durable constraints were remembered

## Non-Goals For M1 Storage

- no SQLite
- no remote state store
- no background compaction
- no event-sourced full replay requirement
- no multi-user locking model
- no binary artifact management
