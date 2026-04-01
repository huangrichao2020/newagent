# Roadmap

## Phase 0

Status: complete enough to move on

Outputs:

- project created
- initial pain points recorded
- Claude Code source-map materials collected
- QueryEngine and Tool model notes written

## Phase 1

Goal: freeze the remote server manager definition

Outputs:

- requirements baseline
- architecture baseline
- M1 scope definition
- project operating rules
- remote-server manager target fixed
- Feishu long-connection constraint fixed
- Bailian model routing fixed

Exit criteria:

- we can explain what the manager is
- we can explain what M1 includes and excludes

## Phase 2

Goal: implement the session kernel and project registry prototype

Outputs:

- session creation and resume
- task state machine
- timeline persistence
- minimal context assembly
- server project registry
- remote manager profile

Exit criteria:

- one session can survive interruption and resume correctly
- one server baseline can be registered and inspected

## Phase 3

Goal: implement the tool, approval, and reviewer runtime

Outputs:

- typed tool registry
- permission levels
- approval flow
- execution log
- Codex review adapter
- Codex repair adapter

Exit criteria:

- safe tools run directly
- dangerous tools pause for approval
- timeline shows both request and result
- Codex can be called as review and repair tooling

## Phase 4

Goal: make the shell usable as a remote operator

Outputs:

- terminal interaction loop
- visible execution states
- command surface for inspect, resume, abort, approve
- project register and inspect commands
- manager profile inspection

Exit criteria:

- user can operate the shell without reading source code
- the shell can explain what projects it manages

## Phase 5

Goal: strengthen memory, channel, and deployment readiness

Outputs:

- session memory vs project memory split
- skill lookup
- relevant retrieval
- Feishu long-connection adapter
- Bailian provider adapter
- remote deployment baseline

Exit criteria:

- a resumed session starts with usable context instead of full replay
- Feishu can feed work into the kernel
- model routing is real, not just documented

Status:

- session memory vs project memory: first slice done
- Feishu long-connection adapter: first slice done
- Bailian provider adapter: first slice done
- deploy baseline: drafted
- remaining gap: message intake is planned but not yet auto-executed

## Phase 6

Goal: deploy and hand over operational control

Outputs:

- deploy to aliyun
- connect Feishu operator channel
- load server project baseline
- let the manager take over real work

Exit criteria:

- the manager can receive work from Feishu
- the manager can inspect known server projects
- the manager can call Codex for review and repair

Current gap:

- intake and first-plan reply are implemented locally
- real remote deployment, live Feishu app credentials, and operational handoff are not done yet

## Deferred Work

- debug instrumentation profiles
- debugger protocol adapters
- raw memory instrumentation as optional native-debug capability
- desktop UI
- browser control
- multi-agent orchestration
- evaluation harness
- prompt optimization and training loops
