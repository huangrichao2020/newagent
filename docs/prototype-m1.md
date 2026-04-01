# Prototype M1

## Objective

Build a terminal-first shell kernel that proves the project thesis.

M1 should show that the shell can manage state, permissions, and visibility better than a raw chat loop.

## M1 Features

### Required

- create session
- resume session
- persist timeline
- classify task state
- assemble layered context
- execute a small local tool registry
- gate dangerous tools behind approval
- persist session memory and project memory separately

### Nice To Have

- short session summary generation
- step-level progress rendering
- explicit abort and retry commands

## M1 Command Surface

Suggested shell verbs:

- `start`
- `resume`
- `status`
- `timeline`
- `approve`
- `reject`
- `abort`
- `memory add`
- `memory search`

## M1 Tool Surface

Only a few tools are needed:

- read file
- list files
- search text
- run shell command
- write file

The important part is not tool count.

The important part is:

- schema
- permission tagging
- execution logging
- approval behavior

## M1 Success Demo

A single demo should prove the shell works:

1. User starts a task.
2. Shell assembles context and shows chosen sources.
3. Shell produces a short plan.
4. Shell executes one safe tool directly.
5. Shell requests approval for one dangerous tool.
6. User approves.
7. Shell resumes and completes.
8. User exits.
9. User resumes later and sees timeline plus memory.

If this works cleanly, the shell is real enough to justify M2.
