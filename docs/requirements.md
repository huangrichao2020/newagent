# Requirements

## Problem Statement

Current agent products are often impressive but operationally weak.

Common failures:

- context loss across sessions
- invisible execution and low trust
- poor interruptibility
- memory without governance
- tool access without enough safety or audit
- weak handoff between planning, execution, and review

For this project there is one more concrete failure:

- project-management and remote-server capabilities are too tightly bound into the default assistant path

## Primary User

Primary user:

- the operator who wants one long-running assistant to handle both general requests and remote-machine work
- prefers talking through Feishu instead of SSHing in for every task
- expects visibility, audit, and recoverability
- wants project inventory, release flow, runtime health, and exception follow-up to be available as optional capabilities, not mandatory framing

## Core User Stories

1. As a user, I want the agent to understand the current task using layered context instead of only the last few messages.
2. As a user, I want to see what the agent is doing while it works.
3. As a user, I want to interrupt, redirect, or narrow an ongoing execution.
4. As a user, I want dangerous actions to require explicit approval.
5. As a user, I want important facts to survive across sessions without replaying everything.
6. As a user, I want procedural knowledge to live as reusable skills, not be hidden inside one long prompt.
7. As a user, I want to resume a prior session and know what happened before.
8. As a user, I want tool execution to be auditable.
9. As a user, I want project-management capability to know which remote projects exist and what role each project plays when the task is actually about those projects.
10. As a user, I want the manager agent to talk to me through Feishu over a long-lived direct connection.
11. As a user, I want the manager agent to use Bailian `codingplan` for planning and `qwen3.5-plus` for execution by default.
12. As a user, I want the manager agent to be able to call Codex for review and repair when needed.

## Functional Requirements

### Session

- Create a named session.
- Resume a previous session.
- Maintain session timeline and state.
- Mark session state as idle, planning, running, waiting-approval, blocked, completed, or failed.

### Context

- Assemble context from multiple layers:
  - current message
  - session context
  - project context
  - durable memory
  - relevant skills
- Project context or service inventory must be attached only when relevant to the current request.
- Show what context sources were selected.

### Planning And Execution

- Support plan-first execution for non-trivial tasks.
- Allow a plan to be revised before or during execution.
- Keep task steps visible and stateful.
- Split planning model and execution model when needed.

### Project Management Capability

- Maintain a project registry for the remote server as an optional capability.
- Persist project records including role, source root, runtime root, publish root, and service identity.
- Distinguish major business projects from minor infrastructure projects.
- Support loading a known server baseline as seed data.

### Tools And Permissions

- Register tools with typed input schemas.
- Tag tools with permission levels.
- Require approval for dangerous operations.
- Record who approved what and when.
- Allow a review-only Codex tool.
- Allow a repair-capable Codex tool under stronger permissions.

### Channel Integration

- If Feishu is supported, it must run as a direct long-lived local connection.
- Do not require a remote relay server, root server, or message forwarder for Feishu.
- The local shell should own Feishu session lifecycle, message receipt, and reply dispatch.
- Feishu integration should remain optional and isolated from the core shell kernel.
- For this project, Feishu is not a nice-to-have channel. It is the primary operator interface after deployment.

### Model Routing

- The default planning model must be Bailian `codingplan`.
- The default execution and summarization model must be Bailian `qwen3.5-plus`.
- Model routing must be explicit and inspectable instead of hidden inside prompts.

### Codex Integration

- The manager agent must be allowed to call Codex for workspace review.
- The manager agent must be allowed to call Codex for repair or correction with stricter permissions.
- Codex invocation must be auditable in the timeline.

### Memory

- Keep session memory separate from project memory.
- Support saving facts, decisions, and open questions.
- Support targeted retrieval, not just full replay.

### Transparency

- Show execution timeline.
- Show tool calls and outcomes.
- Show state transitions.
- Show the basis for approval requests.
- Show which model route was used for planning or execution.
- Show when Codex was invoked and why.

## Non-Functional Requirements

- Terminal-first for M1 and remote-server-first for deployment.
- Small enough to reason about.
- Recoverable after interruption.
- Provider-agnostic at the shell boundary.
- Easy to inspect from plain files and logs.
- Capable of being deployed as a long-running manager process on the remote server.

## Non-Goals For M1

- polished desktop UI
- voice interaction
- browser automation
- multi-user collaboration
- agent training or RL loops
- complex multi-agent orchestration
- replacing every project-specific runtime on day one

Those may come later, but they are not required for the first kernel.
