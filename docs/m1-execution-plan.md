# M1 Execution Plan

## Objective

Build the smallest terminal-first shell that proves:

- session continuity
- visible execution
- governed tool use
- separated memory layers

## Philosophy

This plan intentionally optimizes for correctness and clarity over speed.

The rule is:

- freeze interfaces first
- implement one subsystem at a time
- verify before expanding

## Phase 1 — Freeze What We Are Building

Purpose:

- remove ambiguity before code exists

Tasks:

1. Freeze M1 command surface.
2. Freeze data objects.
3. Freeze storage layout.
4. Freeze tool permission categories.

Artifacts:

- this plan
- `docs/prototype-m1.md`
- `docs/m1-data-model.md`
- `docs/m1-storage-layout.md`
- upcoming interface notes for core objects

Exit criteria:

- no unresolved ambiguity about what M1 includes
- no hidden requirement that would force architecture changes later

## Phase 2 — Freeze The Data Model

Purpose:

- make state explicit before writing handlers

Objects to define:

- `Session`
- `Task`
- `PlanStep`
- `TimelineEvent`
- `ApprovalRequest`
- `MemoryEntry`
- `ToolSpec`

Required decisions:

- stable IDs
- lifecycle states
- append-only vs mutable fields
- minimum persisted fields

Exit criteria:

- each object has a written shape and purpose
- storage format can be derived from the definitions

## Phase 3 — Freeze Storage Layout

Purpose:

- guarantee inspectability and recoverability

Proposed direction:

- `storage/sessions/<session-id>/session.json`
- `storage/sessions/<session-id>/timeline.jsonl`
- `storage/sessions/<session-id>/task.json`
- `storage/memory/session/<session-id>.jsonl`
- `storage/memory/project/project.jsonl`

Key decisions:

- what is append-only
- what is recalculated
- what is canonical

Exit criteria:

- a human can debug state from files alone

## Phase 4 — Implement Session Kernel

Purpose:

- establish continuity as the core property of the shell

Build:

- create session
- load session
- change session state
- append timeline events

Do not build yet:

- complex tool logic
- memory retrieval heuristics

Verification:

- create a session
- persist it
- restart process
- resume it without loss of identity or timeline

Exit criteria:

- session continuity works from disk

## Phase 5 — Implement Context Router

Purpose:

- make context selection explicit and inspectable

Build:

- current input source
- session summary source
- project memory source
- optional skill source
- bounded merged context

Verification:

- shell can display which sources were selected
- merged context size stays bounded

Exit criteria:

- context assembly is visible, not magical

## Phase 6 — Implement Tool Runtime And Permission Governance

Purpose:

- make action execution safe and auditable

Initial tools:

- read file
- list files
- search text
- run shell command
- write file

Permission classes:

- `safe`
- `sensitive`
- `dangerous`

Build:

- tool registry
- input validation
- permission tagging
- approval request flow
- execution result envelope

Verification:

- safe tool executes without pause
- dangerous tool pauses with a clear approval record

Exit criteria:

- tool execution and approval are both visible in timeline

## Phase 7 — Implement Terminal Command Surface

Purpose:

- expose the kernel in a usable shell loop

Commands:

- `start`
- `resume`
- `status`
- `timeline`
- `approve`
- `reject`
- `abort`
- `memory add`
- `memory search`

Verification:

- a human can run the happy path without reading source code

Exit criteria:

- the shell is operable, not just callable from tests

## Phase 8 — Implement Memory Split

Purpose:

- prove that durable memory is structured, not just leftover chat

Build:

- session memory write/read
- project memory write/read
- targeted retrieval

Verification:

- resumed session loads relevant memory instead of replaying everything

Exit criteria:

- memory improves continuity without becoming opaque

## Stop Points

Stop after each phase if any of these become true:

- architecture boundaries are getting blurred
- implementation requires inventing new hidden state
- command surface grows faster than kernel quality
- a subsystem cannot be verified from files and logs

## What We Will Not Rush

- desktop UI
- remote channels
- Feishu integration
- browser control
- plugin ecosystem
- eval/training layer

## Recommended Immediate Next Step

Start with Phase 2 and write the actual object definitions before any runtime code lands in `code/`.
