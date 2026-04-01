# Remote Server Manager

## Mission

`newagent` 的目标已经明确收口：

- 它是阿里云远程服务器的专业项目总管 agent
- 它不是一个泛化聊天壳
- 它不是一个只在本地玩的 demo

## Target Runtime

- 部署位置：远程阿里云服务器
- 主交互通道：飞书
- 通道方式：直接长连接
- 远程 relay：不允许作为架构依赖

## Default Model Routing

- 规划：百炼 `codingplan`
- 执行：百炼 `qwen3.5-plus`
- 总结：百炼 `qwen3.5-plus`
- 审核与纠错：`codex`

## Managed Objects

总管 agent 需要长期管理这些对象：

- 项目
- 服务
- 端口
- 发布目录
- 公开路径
- 定时任务
- 任务进展
- 审批记录
- review / repair 记录

## First Managed Server Baseline

当前第一台目标服务器的已知基线是：

- 大项目：
  - `uwillberich`
  - `novel-evolution`
  - `gent-mesh`
- 小项目：
  - `deploy-hub`
  - `acp-registry`
  - `ssh-channel`

## Required Behaviors

- 能回答“服务器上有哪些项目”
- 能回答“每个项目的源码、运行、发布路径是什么”
- 能回答“哪个服务在线，哪个有风险”
- 能接收飞书消息并转成可恢复会话
- 能在必要时调用 `codex` 做 review
- 能在必要时调用 `codex` 做 repair
- 所有关键动作都要进 timeline

## Current Implementation Direction

M1 先做这几件事：

1. 内核可恢复
2. 项目注册表可用
3. 远程总管默认画像可用
4. `codex` review / repair 工具可调用
5. 飞书长连接适配器可用
6. 百炼 provider 可用
7. 收到消息后自动规划并回摘要
8. 再部署远端

## Current Working Slice

当前这版已经能做到：

- 载入远端 6 项目基线
- 用飞书长连接收消息
- 飞书通道固定复用一个总管会话
- 把最近几轮对话和长期压缩记忆带进后续规划
- 每 5 小时自动压缩一次飞书上下文
- 调 `codingplan` 生成 JSON 计划
- 把计划落成 `plan_steps`
- 把摘要和 assistant reply 记入 timeline
- 用飞书回一版中文确认摘要
- 通过安全工具读取项目注册表和探活服务端点
- 在 runtime 内自动推进第一版 manager loop
- 能检查项目的 PM2 进程状态
- 能自动生成阶段汇报
- 能自动调 `codex review`
- 能在 `repair` 步骤进入审批等待

当前还没做到：

- 自动执行 `operate / deploy` 步骤
- 远端 PM2 常驻运行后的稳定性验收
