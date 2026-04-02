# M1 Handoff

Updated: `2026-04-02`

## Current State

`newagent` has moved beyond spec-only work.

M1 now has runnable kernel slices plus a first agent loop:

1. `Session Kernel`
2. `Context Router`
3. `Tool Runtime + Permission Governance` first slice
4. `Memory Store`
5. `Single-Step Executor`
6. `Manager Executor / Runtime` first slice

## Implemented Modules

### Session Kernel

Files:

- `code/shell/session/session-store.js`
- `code/shell/session/session-store.test.js`

Implemented surface:

- `createSession`
- `loadSession`
- `createPlan`
- `updateSessionStatus`
- `appendTimelineEvent`
- `requestApproval`
- `resolveApproval`
- `abortSession`
- `recoverInterruptedSession`

### Context Router

Files:

- `code/shell/context/context-router.js`
- `code/shell/context/context-router.test.js`

Implemented surface:

- `buildExecutionContext`

Current sources:

- current input
- session summary
- session memory
- project memory
- skill refs

Current derived files:

- `storage/sessions/<session-id>/context/latest-selection.json`
- `storage/sessions/<session-id>/context/latest-merged-context.json`

### CLI

Files:

- `code/shell/cli/session-cli.js`
- `code/shell/cli/session-cli.test.js`
- `code/bin/newagent.js`

Implemented commands:

- `start`
- `plan-create`
- `resume`
- `status`
- `timeline`
- `context-build`
- `memory add`
- `memory search`
- `step-run`
- `approve`
- `reject`
- `abort`

Important approval capability:

- `approve --continue` resolves a pending approval and continues the stored step in one command

### Memory Store

Files:

- `code/shell/memory/memory-store.js`
- `code/shell/memory/memory-store.test.js`

Implemented behavior:

- append session-scoped memory
- append project-scoped memory
- search memory by query
- search memory by tag
- append `memory_written` timeline events

### Single-Step Executor

Files:

- `code/shell/executor/step-executor.js`
- `code/shell/executor/step-executor.test.js`

Implemented behavior:

- build execution context for the current step
- start the current step
- run one tool through the tool runtime
- complete the step on safe success
- pause on approval-required tools
- fail and block on tool errors

### Tool Runtime

Files:

- `code/shell/tools/tool-runtime.js`
- `code/shell/tools/tool-runtime.test.js`

Implemented behavior:

- safe tools execute directly
- dangerous tools do not execute directly
- dangerous tools create approval requests through the session kernel
- tool execution emits timeline events

Registered tools:

- `read_file`
- `list_files`
- `search_text`
- `write_file`
- `run_shell_command`

Current execution rule:

- `read_file`, `list_files`, `search_text` are `safe`
- `write_file`, `run_shell_command` are `dangerous`

## Verification

Current automated verification:

- `npm test`

Latest status:

- `93 / 93` tests passing
- `npm run demo:m1` passes
- `npm run demo:m1-approval` passes

## What Is Still Missing

M1 is not done yet.

Main gaps:

- no interactive shell loop
- no `operate / deploy` execution mapping yet
- no live remote acceptance for the latest agent loop

Note:

- there is now a reproducible safe-path demo script
- there is now a reproducible approval-resume demo script

## Recommended Next Steps

1. Extend the agent loop beyond `inspect / review / repair / report` into `operate / deploy`.
2. Re-sync the latest code to aliyun and verify real Feishu long-connection traffic.
3. Only after that, consider an interactive shell loop.

## Reproducible Demo

Current demo entry:

```bash
npm run demo:m1
npm run demo:m1-approval
```

Files:

- `code/demo/m1-demo.mjs`
- `code/demo/m1-approval-demo.mjs`

What it proves:

- session creation
- plan creation
- single-step safe execution
- context build
- timeline growth
- memory write
- completed session status
- approval pause
- approval resolution
- approved dangerous execution

## Guardrails

- Keep Feishu out of M1 implementation.
- Keep remote relay out of the architecture.
- Do not add UI polish before the execution loop is real.
- Do not expand the tool surface until the current permission model stays coherent.
