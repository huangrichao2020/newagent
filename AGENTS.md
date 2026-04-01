# AGENTS.md

## Project Identity

This project studies and defines a next-generation agent shell.

The shell is not the model itself.

The shell is the layer that turns a model into a trustworthy working system:

- session and context management
- tool routing and execution
- permissions and approvals
- memory and skills
- planning and verification
- user interaction and transparency

## Current Phase

Current phase: `spec-first`

That means:

- research notes are valid inputs
- architecture and requirements take priority over premature implementation
- new code should only be added when it serves the current milestone

## Current Milestone

`M1 Terminal Shell Kernel`

Deliver a terminal-first prototype that can:

1. run one task-oriented session
2. assemble layered context
3. show an execution timeline
4. execute a small tool registry with approval gates
5. persist session memory and project memory separately
6. resume a previous session

## Design Rules

- Keep runtime, workflow, optimization, and PR operations conceptually separate.
- Do not treat long-term memory as chat leftovers.
- Do not hide tool execution behind a black box when it can be surfaced.
- Prefer explicit state machines and logs over magic behavior.
- Prefer small testable interfaces over large implicit coordinators.
- Keep model-provider switching cheap.
- Default to terminal-first until the kernel is stable.
- For Feishu channel work, use a local long-lived connection model. Do not route Feishu messaging through a remote relay or root server.

## What Counts As Progress

Good progress:

- clearer requirements
- better architecture boundaries
- runnable prototypes
- sharper permission model
- visible execution states
- durable session and memory design

Not enough:

- more raw notes without synthesis
- UI polish without kernel clarity
- adding tools before the governance model exists
- adding training logic before runtime and traces exist

## Working Conventions

- Update `README.md` when project scope changes.
- Put requirements and architecture decisions under `docs/`.
- Keep raw study notes under `notes/`.
- Keep third-party material under `references/`.
- Put only runnable prototypes or scaffolds under `code/`.

## External Patterns To Reuse

- Hermes Agent: runtime, memory, channels, scheduling
- Superpowers: spec -> plan -> execute -> verify
- Agent Lightning: traces before optimization
- GitHub PR dashboard: queue-based review thinking

See:

- `docs/requirements.md`
- `docs/architecture.md`
- `docs/roadmap.md`
- `docs/prototype-m1.md`
