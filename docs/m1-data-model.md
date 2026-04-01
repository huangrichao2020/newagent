# M1 Data Model

## Purpose

Freeze the minimum runtime objects for `M1 Terminal Shell Kernel` before implementation begins.

The goal is not to model everything.

The goal is to make continuity, approvals, and inspectability explicit.

## Design Rules

1. `Session` is the unit of continuity.
2. `Task` is the unit of active work inside a session.
3. `TimelineEvent` is append-only and serves as the audit trail.
4. Current state objects may be mutable, but every important state change must also emit a timeline event.
5. Memory stores facts, decisions, constraints, and open questions. Procedures live in skills, not memory.
6. Approvals are first-class objects, not booleans hidden inside tool calls.

## Identity Rules

- Use sortable opaque IDs for runtime entities. Preferred format: `ULID`.
- `ToolSpec.name` and `SkillRef.name` are stable human-readable keys.
- Cross-object references always use IDs, never array positions.
- IDs are never recycled.

## Object Overview

Core M1 objects:

- `Session`
- `Task`
- `PlanStep`
- `TimelineEvent`
- `ApprovalRequest`
- `MemoryEntry`
- `ToolSpec`

Supporting reference object:

- `SkillRef`

## Session

Purpose:

- represent one resumable work stream

Lifecycle:

- `idle`
- `planning`
- `running`
- `waiting_approval`
- `blocked`
- `completed`
- `failed`
- `aborted`

Recovery rule:

- if a process dies while a session is in `planning` or `running`, reload it as `blocked` with a recovery event explaining the interruption

Mutable fields:

- `title`
- `status`
- `active_task_id`
- `updated_at`
- `summary`

Minimum persisted fields:

```json
{
  "id": "01JZSESSION...",
  "title": "Investigate shell kernel state model",
  "status": "planning",
  "project_key": "newagent",
  "active_task_id": "01JZTASK...",
  "created_at": "2026-04-01T12:00:00Z",
  "updated_at": "2026-04-01T12:03:00Z",
  "summary": "Working on M1 data model freeze",
  "version": 1
}
```

Field notes:

- `project_key` binds the session to one local project context
- `summary` is short operational state, not a full transcript
- `version` is the schema version for migration

## Task

Purpose:

- represent one user-directed unit of work inside a session

Lifecycle:

- `draft`
- `planned`
- `running`
- `waiting_approval`
- `blocked`
- `completed`
- `failed`
- `aborted`

Mutable fields:

- `status`
- `plan_step_ids`
- `current_step_id`
- `result`
- `updated_at`

Minimum persisted fields:

```json
{
  "id": "01JZTASK...",
  "session_id": "01JZSESSION...",
  "title": "Freeze M1 data model",
  "user_request": "Define core objects before implementation",
  "status": "running",
  "plan_step_ids": [
    "01JZSTEP1...",
    "01JZSTEP2..."
  ],
  "current_step_id": "01JZSTEP1...",
  "created_at": "2026-04-01T12:00:10Z",
  "updated_at": "2026-04-01T12:04:00Z",
  "result": null,
  "version": 1
}
```

Field notes:

- a session may hold many past tasks, but only one `active_task_id` in M1
- `user_request` stores the canonical task brief
- `result` is a compact task outcome, not a full artifact store

## PlanStep

Purpose:

- represent one planned execution step inside a task

Lifecycle:

- `pending`
- `ready`
- `running`
- `waiting_approval`
- `completed`
- `failed`
- `skipped`
- `canceled`

Mutable fields:

- `status`
- `notes`
- `attempt_count`
- `started_at`
- `finished_at`

Minimum persisted fields:

```json
{
  "id": "01JZSTEP1...",
  "task_id": "01JZTASK...",
  "index": 1,
  "title": "Read architecture and prototype constraints",
  "kind": "research",
  "status": "completed",
  "depends_on": [],
  "notes": "Current docs are aligned",
  "attempt_count": 1,
  "started_at": "2026-04-01T12:01:00Z",
  "finished_at": "2026-04-01T12:02:00Z",
  "version": 1
}
```

Field notes:

- `index` is display order only
- `depends_on` references other step IDs
- step edits are allowed, but every status change must also appear in the timeline

## TimelineEvent

Purpose:

- provide the append-only execution and audit log

Lifecycle:

- immutable after write

Minimum persisted fields:

```json
{
  "id": "01JZEVT...",
  "session_id": "01JZSESSION...",
  "task_id": "01JZTASK...",
  "step_id": "01JZSTEP1...",
  "kind": "tool_completed",
  "actor": "shell",
  "at": "2026-04-01T12:02:10Z",
  "payload": {
    "tool_name": "read_file",
    "status": "ok"
  },
  "version": 1
}
```

Required event families for M1:

- `session_created`
- `session_resumed`
- `session_recovered`
- `user_message_added`
- `task_created`
- `plan_created`
- `plan_step_started`
- `plan_step_completed`
- `plan_step_failed`
- `tool_requested`
- `tool_completed`
- `tool_failed`
- `approval_requested`
- `approval_resolved`
- `memory_written`
- `state_changed`
- `task_completed`
- `task_failed`
- `task_aborted`

Field notes:

- `payload` is event-specific and may be sparse
- timeline is canonical for audit, not for current-state lookup speed

## ApprovalRequest

Purpose:

- represent a blocked action waiting for explicit permission

Lifecycle:

- `pending`
- `approved`
- `rejected`
- `expired`
- `canceled`

Scope rule:

- approvals are session-local in M1

Mutable fields:

- `status`
- `resolved_at`
- `resolved_by`
- `resolution_note`

Minimum persisted fields:

```json
{
  "id": "01JZAPR...",
  "session_id": "01JZSESSION...",
  "task_id": "01JZTASK...",
  "step_id": "01JZSTEP2...",
  "tool_name": "write_file",
  "permission_class": "dangerous",
  "reason": "Will modify a tracked source file",
  "requested_input": {
    "path": "docs/m1-data-model.md"
  },
  "status": "pending",
  "requested_at": "2026-04-01T12:05:00Z",
  "resolved_at": null,
  "resolved_by": null,
  "resolution_note": null,
  "version": 1
}
```

## MemoryEntry

Purpose:

- persist a reusable fact, decision, constraint, or open question

Scopes:

- `session`
- `project`

Kinds:

- `fact`
- `decision`
- `constraint`
- `open_question`
- `summary`

Lifecycle:

- `active`
- `superseded`
- `retracted`

Mutable fields:

- `status`
- `supersedes_id`
- `updated_at`

Minimum persisted fields:

```json
{
  "id": "01JZMEM...",
  "scope": "project",
  "session_id": null,
  "project_key": "newagent",
  "kind": "constraint",
  "status": "active",
  "content": "Feishu must use a local long-lived connection and no remote relay.",
  "tags": [
    "feishu",
    "channels",
    "constraints"
  ],
  "source_event_id": "01JZEVT...",
  "supersedes_id": null,
  "created_at": "2026-04-01T12:06:00Z",
  "updated_at": "2026-04-01T12:06:00Z",
  "version": 1
}
```

Field notes:

- `session` memory is situational and task-linked
- `project` memory is durable across sessions
- procedures should not be stored as `MemoryEntry`; they belong in skills

## ToolSpec

Purpose:

- define a callable tool contract and its governance boundary

Permission classes:

- `safe`
- `sensitive`
- `dangerous`

Lifecycle:

- loaded at runtime, versioned by tool definition

Minimum persisted fields:

```json
{
  "name": "read_file",
  "description": "Read one local file",
  "permission_class": "safe",
  "input_schema": {
    "type": "object"
  },
  "side_effects": false,
  "timeout_ms": 10000,
  "version": 1
}
```

Field notes:

- `name` is the stable key
- `permission_class` drives approval behavior
- `input_schema` is required before execution
- `side_effects` allows fast filtering in planning and audit

## SkillRef

Purpose:

- track which local skill was selected as a context source

Lifecycle:

- immutable for one selection record

Minimum persisted fields:

```json
{
  "name": "agent-systems-patterns",
  "path": "/Users/tingchi/.codex/skills/agent-systems-patterns/SKILL.md",
  "activation_reason": "Task concerns agent runtime and persistent memory design",
  "selected_at": "2026-04-01T12:01:30Z",
  "version": 1
}
```

Field notes:

- `SkillRef` is a selection record, not the skill body itself
- it helps explain context assembly later

## Mutability Matrix

| Object | Canonical form | Mutable | Audit trail required |
| --- | --- | --- | --- |
| `Session` | current-state json | yes | yes |
| `Task` | current-state json | yes | yes |
| `PlanStep` | current-state json | yes | yes |
| `TimelineEvent` | append-only jsonl | no | n/a |
| `ApprovalRequest` | current-state json | yes | yes |
| `MemoryEntry` | current-state json/jsonl | limited | yes |
| `ToolSpec` | definition file | rarely | no |
| `SkillRef` | selection record | no | optional |

## Derived vs Canonical

Canonical for M1:

- current `Session`
- current `Task`
- current `PlanStep` set
- append-only `TimelineEvent` log
- current `ApprovalRequest` records
- persisted `MemoryEntry` records
- local `ToolSpec` definitions

Derived for M1:

- rendered timeline view
- short session summary text
- merged context payload
- search index
- display status badges

## Decisions Frozen In Phase 2

- Runtime entity IDs should be sortable opaque IDs.
- `TimelineEvent` is append-only and immutable.
- Current state lives in mutable objects, but important transitions must emit events.
- `ApprovalRequest` is its own object.
- M1 approvals are session-local.
- Memory is split into `session` and `project`.
- Procedures belong in skills, not memory.
