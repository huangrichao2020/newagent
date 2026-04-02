# Architecture

## Thesis

`newagent` should be built as a layered runtime for one concrete job:

- a long-running operator assistant that can activate the right capabilities on demand

It is not just a generic prompt wrapper and not just a terminal toy shell.

## Layer Model

### 1. Interaction Layer

Responsibilities:

- receive user input
- render responses
- show progress, approvals, and timeline
- allow interrupt and redirect

For M1:

- terminal UI first
- Feishu gateway next

For later channel integrations:

- Feishu should be treated as a local gateway adapter using a long-lived connection.
- Do not design Feishu around a remote relay service.
- For this project, Feishu is the target operator channel after deployment.

### 2. Session Kernel

Responsibilities:

- create and resume sessions
- track lifecycle state
- store timeline events
- bind one active task graph to a session

Key rule:

- the session is the unit of continuity

### 2.5 Capability Registry

Responsibilities:

- persist optional capability context such as project maps, service inventories, publish paths, or other domain-specific registries
- separate durable factual context from transient execution context
- expose capability data only when the current request actually needs it

Key rule:

- domain registries are optional capabilities, not the default framing for every task

### 3. Context Router

Responsibilities:

- choose relevant context sources
- merge current message, session summary, project memory, and skills
- produce a bounded execution context for the model

Key rule:

- context must be explainable and inspectable

### 4. Planner / Executor

Responsibilities:

- classify task size
- produce plan for non-trivial work
- execute in steps
- update task state after each step

Key rule:

- planning and execution are separate states
- planning and execution may use different models

### 5. Tool Runtime

Responsibilities:

- register tools
- validate inputs
- run tools
- capture outputs
- normalize errors
- expose external agent helpers such as Codex review and repair tools

Key rule:

- every tool call is a timeline event

### 6. Permission Governance

Responsibilities:

- assign permission levels
- enforce approval rules
- block out-of-scope actions
- persist approval decisions

Key rule:

- dangerous capability should never be implicit

### 7. Memory And Skills

Responsibilities:

- persist durable facts and decisions
- keep reusable procedures as skills
- retrieve relevant memory on demand

Key rule:

- memory stores facts, skills store procedures
- domain capabilities such as project management should be attached through memory, skills, or registries only when relevant

### 8. Provider And Reviewer Adapters

Responsibilities:

- route planning to Bailian `codingplan`
- route execution and summarization to Bailian `qwen3.5-plus`
- invoke Codex for review and repair when beneficial

Key rule:

- model routing and reviewer routing must be explicit runtime configuration

## Data Objects

Minimal core objects for M1:

- `Session`
- `Task`
- `PlanStep`
- `TimelineEvent`
- `ToolSpec`
- `ApprovalRequest`
- `MemoryEntry`
- `SkillRef`
- `ProjectRecord`
- `ManagerProfile`

## Execution Flow

```text
User Input
  -> Channel Adapter
  -> Project Registry
  -> Session Kernel
  -> Context Router
  -> Planner
  -> Executor
  -> Tool Runtime
  -> Permission Check
  -> Timeline Update
  -> Response Render
```

If a dangerous tool is requested:

```text
Tool Request
  -> Permission Governance
  -> Waiting Approval
  -> Approved or Rejected
  -> Resume Execution
```

## M1 Storage Direction

Prefer plain inspectable local storage:

- sessions as json/jsonl
- timeline as append-only jsonl
- memory as structured markdown or jsonl
- skills as file-based definitions
- project registry as plain json

## Imported Design Lessons

From Claude Code:

- tool governance matters more than raw tool count
- execution loop and tool loop must be explicit

From Hermes Agent:

- long-running assistant needs real session continuity
- memory, skills, and sessions should not collapse into one bucket

From Superpowers:

- non-trivial work needs spec -> plan -> execute -> verify

From Agent Lightning:

- traces should be captured from the start, even before optimization exists

From `nfeyre/claudecode-src`:

- a real agent shell decomposes into commands, tools, services, bridge, plugins, skills, remote, memory, tasks, and state
- shell architecture is broader than a REPL loop

From `G_G/claude-code`:

- keep source kernel and runnable distribution shell separate
- model-provider compatibility should live in an adapter layer
- runtime mode switches should be explicit
- skills can be treated as deployable runtime assets

From `node-network-devtools`:

- network observability is a development-layer capability worth designing for
- provider and channel debugging should not depend on blind logs alone

## Development Instrumentation

The shell should reserve a non-core development instrumentation layer.

Its purpose is to debug:

- provider adapters
- SSE and WebSocket streaming
- MCP transports
- channel adapters such as Feishu

This layer is useful during development, but should remain optional and outside the M1 kernel.

For this project, that layer should be split into:

1. semantic state debugging
2. debugger protocol adapters
3. raw memory instrumentation

Raw memory CRUD must not be treated as a default shell capability.

If added at all, it belongs in an opt-in debug profile with stricter permissions than normal tools.

See:

- `docs/debug-instrumentation.md`

## Channel Constraint

Feishu is a valid future channel, but with one hard constraint for this project:

- local long connection only
- no remote transit server as architectural dependency

That means any Feishu adapter should sit beside the local session kernel and feed events directly into it.

## Deployment Constraint

This project is being built for one real target:

- the aliyun remote server

That implies:

- remote-server project inventory is first-class data
- PM2, ports, publish roots, and health endpoints are manager-visible state
- the shell is expected to become a long-running process after bootstrap

## Reviewer Constraint

After the manager is online, it should be able to call Codex in two modes:

- review mode
- repair mode

Review can stay read-oriented.

Repair must remain approval-aware and auditable.
