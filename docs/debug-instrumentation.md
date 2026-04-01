# Debug Instrumentation

## Purpose

Define a debug capability layer for `newagent` that improves debugging power without collapsing the safety boundary of the shell.

This document is intentionally separate from the core runtime design.

Reason:

- debugging is valuable
- raw process memory access is dangerous
- the shell should not treat those as the same thing

## Core Decision

`newagent` should not begin with a general-purpose Cheat Engine clone.

It should begin with a layered debug instrumentation model:

1. semantic state debugging
2. debugger protocol adapters
3. raw memory instrumentation

The first two are broadly useful.

The third is powerful, but should remain optional, local-only, and behind the highest permission class.

## Why Not Start With Raw Memory CRUD

Raw memory CRUD looks attractive because it appears universal:

- read arbitrary state
- patch values live
- freeze values
- scan for unknown fields

But for an agent shell, it is a poor default abstraction:

- memory addresses are unstable
- the model cannot reason well from naked offsets alone
- the risk of corrupting a target process is high
- security risk is much higher than ordinary debug inspection
- most real debugging tasks are better served by object state or a real debugger

Conclusion:

- raw memory instrumentation should be the last layer, not the first one

## Layer 1 — Semantic State Debugging

This is the most valuable debug layer for `newagent` itself.

It operates on the shell's own runtime objects instead of bytes and addresses.

### Scope

- `Session`
- `Task`
- `PlanStep`
- `ApprovalRequest`
- `TimelineEvent`
- `MemoryEntry`
- derived context snapshots

### Candidate Tools

- `debug.session.get`
- `debug.session.patch`
- `debug.task.get`
- `debug.task.patch`
- `debug.plan_step.get`
- `debug.plan_step.patch`
- `debug.plan_step.force_complete`
- `debug.plan_step.force_fail`
- `debug.approval.list`
- `debug.approval.force_resolve`
- `debug.context.inspect`
- `debug.context.rebuild`
- `debug.memory.inspect`
- `debug.memory.patch`
- `debug.timeline.replay`

### Permission Guidance

Mostly:

- `safe` for read-only inspection
- `sensitive` for forcing state transitions

### Why This Layer Matters

This layer gives the agent practical debugging power while keeping the debugging vocabulary aligned with the runtime model.

This is the first debug layer that should be implemented.

## Layer 2 — Debugger Protocol Adapters

This layer is for debugging target programs through structured debugger interfaces instead of raw memory offsets.

### Target Examples

- Node.js via `inspector`
- browser and frontend targets via `Chrome DevTools Protocol`
- native programs via `LLDB` or `GDB`

### Candidate Tools

- `debug.attach`
- `debug.detach`
- `debug.process.list`
- `debug.breakpoints.list`
- `debug.breakpoints.set`
- `debug.breakpoints.clear`
- `debug.stack`
- `debug.locals`
- `debug.eval`
- `debug.continue`
- `debug.step_over`
- `debug.step_into`
- `debug.step_out`
- `debug.watch.add`
- `debug.watch.remove`

### Permission Guidance

- `safe` for passive inspection
- `sensitive` for attach, eval, and breakpoint mutation
- `dangerous` for operations that modify process behavior

### Why This Layer Matters

This layer gives the shell real debugging power over external programs while preserving symbols, frames, scopes, and structured state.

That is usually far more useful than scanning anonymous memory.

## Layer 3 — Raw Memory Instrumentation

This is the Cheat Engine-like layer.

It should exist only as an optional development capability profile.

### Candidate Tools

- `mem.process.list`
- `mem.maps`
- `mem.scan`
- `mem.scan_refine`
- `mem.read`
- `mem.write`
- `mem.watch`
- `mem.freeze`
- `mem.unfreeze`
- `mem.pointer_chain`

### Intended Use Cases

- native black-box debugging
- locating ephemeral runtime values when symbols are absent
- reverse engineering target process state in a controlled development context

### Non-Goals

- not a default runtime capability
- not a remote administration interface
- not a generic production control surface
- not exposed to low-trust channels

## Security Boundary

This layer needs a stronger boundary than ordinary tools.

### Hard Rules

- local only
- same-user processes only
- default to child processes spawned by the shell
- explicit PID or attach target required
- no remote relay dependency
- no low-trust channel exposure
- all mutating actions must emit timeline events
- all dangerous debug actions require explicit approval

### Additional Rules For Raw Memory Tools

- do not allow full-process blind scanning by default
- require region scoping where possible
- separate `read` from `write`
- separate `write` from `freeze`
- log requested address, width, and value shape
- redact obviously secret-looking payloads in visible logs when possible

## Permission Model

Suggested permission mapping:

### `safe`

- read semantic runtime state
- inspect context selection
- inspect timeline
- list processes
- inspect debugger stack and locals
- inspect memory maps

### `sensitive`

- attach debugger
- set breakpoints
- evaluate expressions in target runtime
- inspect bounded memory regions
- force internal runtime state transitions

### `dangerous`

- write target memory
- freeze target memory
- patch instructions
- continue execution after a forced state mutation
- run shell commands under debug control

## Channel Policy

These capabilities must not be uniformly exposed across every channel.

### Allowed by default

- local terminal
- local desktop UI in development mode

### Not allowed by default

- Feishu
- any remote relay
- public HTTP tool bridge
- untrusted automation agents

Reason:

- the more indirect the channel, the less acceptable raw debug mutation becomes

## Runtime Profiles

Recommended profiles:

### `default`

- no debug mutation tools
- only normal shell tools

### `dev-inspect`

- semantic state inspection
- context inspection
- debugger attach and passive inspection

### `dev-debug`

- semantic patching
- debugger mutation
- dangerous debug tools with approval

### `native-memory`

- raw memory tools
- explicit opt-in only
- highest trust only

## Storage And Audit

Debug capability is only acceptable if it remains inspectable.

### Required Timeline Events

- `debug_attach_requested`
- `debug_attach_completed`
- `debug_attach_failed`
- `debug_eval_requested`
- `debug_eval_completed`
- `debug_eval_failed`
- `memory_read_requested`
- `memory_read_completed`
- `memory_write_requested`
- `memory_write_completed`
- `memory_freeze_requested`
- `memory_freeze_completed`
- `debug_state_patched`

### Derived Artifacts Worth Persisting

- debugger target snapshot
- stack frame snapshot
- context rebuild result
- memory scan result set identifiers

## Recommended Adoption Order

### Stage A

Implement semantic runtime debug tools first.

Goal:

- debug the shell itself

### Stage B

Add debugger protocol adapters.

Goal:

- debug attached target programs with structured symbols and frames

### Stage C

Add raw memory instrumentation only if real native-debug demand remains after Stages A and B.

Goal:

- support hard native cases, not become the default debug path

## Recommendation For `newagent`

Short version:

- yes, `newagent` can support Cheat Engine-like memory CRUD
- no, it should not be the default debug design

The right design is:

1. build semantic debug tools first
2. add debugger adapters second
3. keep raw memory CRUD as an optional `native-memory` capability pack

That gives the shell strong debugging power without turning the entire runtime into an unsafe process patcher.
