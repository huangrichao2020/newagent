# Prompt Contracts

更新时间: `2026-04-02`

## Goal

`newagent` 里的关键 prompt 不再依赖松散自然语言描述，而是尽量固定成可复用的 contract。

这套 contract 主要借鉴了高质量 AI research / writing workflows 里常见的做法：

- 先明确 `ROLE`
- 再明确 `TASK`
- 然后锁定 `OUTPUT CONTRACT`
- 最后补 `EXECUTION PROTOCOL` 和 `RESPONSE RULES`

核心目的不是“写得更好看”，而是降低输出漂移，让 planner、execution model、外接 review / repair 适配都更可控。

## Current Use

当前已经接到这些路径：

- `code/shell/manager/manager-planner.js`
- `code/shell/manager/manager-executor.js`
- `code/shell/prompts/prompt-contract.js`

当前 manager planning prompt 会显式区分：

- `ROLE`
- `TASK`
- `OUTPUT CONTRACT`
- `EXECUTION PROTOCOL`

当前 manager execution prompt 和 Codex instruction 也会显式区分：

- `MANAGER STEP`
- `OPERATOR REQUEST`
- `SESSION SUMMARY`
- `TARGET PROJECT CONTEXT`
- `EXECUTION PROTOCOL`
- `RESPONSE RULES`

## Why It Helps

这套结构对远程 agent 最直接的帮助有三点：

- 更容易把"允许做什么、不允许做什么"写死进 prompt
- 更容易把运行上下文和输出协议拆开，减少模型把上下文当成回答内容复述
- 更容易扩成标准 skill / tool adapter，而不是继续堆一次性长 prompt

## Follow-up

后续如果继续扩，可以按同样模式把这些面也收进 contract：

- `report` 生成格式
- 飞书 operator reply 模板
- 真实 deploy / operate 的审批前说明
- 针对 review / repair 的专用 skill 包
