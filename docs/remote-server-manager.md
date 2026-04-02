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
- 外部复核与约束提炼：OpenRouter 免费模型，默认 `stepfun/step-3.5-flash:free`
- `codex` review / repair：适配保留，但远端默认关闭

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

## Internal Tool Families

为了避免每次都临时拼命令，`newagent` 内部工具要按职责分族，而不是平铺一堆 shell 动作：

- `project_*`
  负责项目注册、源码/运行/发布路径、PM2 进程、服务端点、代码搜索与业务调用线索。
- `infrastructure_*`
  负责项目、服务、路由、端口、静态入口、公开路径之间的映射关系。
- `server_ops_*`
  负责服务器日常运维视角的信息面，例如能力矩阵、端口矩阵、批量探活、网络接口等。
- `news_*`
  负责通用消息、股票资讯、自媒体热榜等外部信息收集，统一走 source registry 而不是把站点写死在 prompt 里。
- `channel_*`
  负责飞书等前台通道的引用回复、reaction、状态同步、楼层关联。
- `coworker_*`
  负责和 `codex_mac_local` 这类特殊同事/特殊消息源的协作。
- `dynamic_tool_*`
  负责临时脚本和临时工具的注册、调用、评审与转正/退役。
- `tool_catalog_*`
  负责让 agent 能先看懂自己当前有哪些稳定工具和临时工具，再决定是否继续写脚本。

原则：

- 常用、高频、低歧义的动作进内建工具。
- 环境相关、一次性的诊断动作先进动态工具。
- 动态工具必须带 `category / lifecycle / review_status / restart_*` 元信息。
- 临时工具跑完后进入 review queue，由维护/运维角色决定是否永久保留。

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
- 用户确认“就这样 / 继续 / 按这个来”会沉淀成长期偏好记忆
- 把最近几轮对话和长期压缩记忆带进后续规划
- 后台维护循环会巡检统一会话，并在每 5 小时间隔到点后自动压缩飞书上下文
- 前台记忆写入和后台压缩有互斥锁与 trailing run，避免并发重复提取
- 调 `codingplan` 生成 JSON 计划
- 把计划落成 `plan_steps`
- 把摘要和 assistant reply 记入 timeline
- 计划结果和压缩结果都可以走第二模型复核，并把可复用约束写回 session memory
- 用飞书回一版中文确认摘要
- 通过安全工具读取项目注册表和探活服务端点
- 通过 `news_*` 工具拉通通用资讯、股票资讯和热榜源
- 通过 `tool_catalog_*` / `dynamic_tool_*` 先盘清自身工具面，再注册临时脚本
- 通过 `channel_feishu_scope_list` / `channel_feishu_capability_matrix` 检查飞书权限面
- 通过 `channel_feishu_doc_*` 创建文档、读取文档并追加 markdown/html 内容
- 通过 `channel_feishu_drive_*` / `channel_feishu_file_upload` 管理云盘目录、移动文件和上传文件
- 通过 `channel_feishu_wiki_*` 列知识空间、建节点、改标题、移动节点和挂载现有文档
- 通过 `channel_feishu_bitable_*` 创建多维表格、建表、列记录和增改记录
- 在 runtime 内自动推进第一版 manager loop
- 能检查项目的 PM2 进程状态
- 能自动生成阶段汇报
- 能自动调 `codex review`
- 能在 `repair` 步骤进入审批等待

当前还没做到：

- 自动执行 `operate / deploy` 步骤
- 远端 PM2 常驻运行后的稳定性验收
