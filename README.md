# newagent

状态: `从通用研究壳切到远程服务器项目总管阶段`

这个目录现在不再只是笔记堆。

它的目标已经收口得很具体：

- 为阿里云远程服务器打造一个专业项目总管 agent
- 直接通过飞书和用户对接
- 长期管理服务器上的项目、服务、发布链和异常
- 把模型变成可靠工作系统，而不是只会聊天的终端助手

当前运行约束也已经明确：

- 以远端 `/root/newagent` 为主仓库和运行真相
- GitHub 从远端仓库更新维护
- 真实密钥只放远端 repo 外环境变量，不进 GitHub
- 远端默认走百炼 / Qwen，`Codex` 适配保留但默认关闭

## 项目目标

本项目现在要解决的是远程服务器上的真实总管问题：

- 多项目并存但边界不清
- 服务在线但职责、端口、发布路径容易漂移
- 长任务和定时任务需要长期跟踪
- 远程协作需要一个持续在线的总管入口
- 审核、纠错、发布不能靠人工记忆串联

目标形态不是“更会聊天”，而是“更像一个可控、可恢复、可解释、可接管远程运维与项目协调的服务器总管”。

## 项目边界

这个项目仍然聚焦于 shell 层，不聚焦于训练模型本身。

本项目关注：

- 会话与上下文管理
- 远程项目注册表和服务图谱
- 任务规划与执行编排
- 工具系统与权限模型
- 记忆系统与技能系统
- 飞书长连接通道
- 用户界面与透明执行
- 中断、恢复、审计、信任
- 审核与纠错闭环

本项目暂不优先关注：

- 基础模型训练
- 复杂多模态生成
- 大规模分布式 agent 集群
- UI 皮肤层面的细节打磨

## 当前结论

从已有研究看，下一代 agent shell 至少需要 6 个稳定部件：

1. `Session Kernel`
2. `Context Router`
3. `Planner / Executor`
4. `Tool Runtime + Permission Governance`
5. `Memory + Skills`
6. `Visible Interaction Layer`

而对 `newagent` 这条线来说，还必须再加 3 个具体能力：

1. `Remote Project Registry`
2. `Feishu Long-Connection Gateway`
3. `Review / Repair Adapter`

外部参考的角色划分目前也已经比较清楚：

- Claude Code 资料: 工程化外壳和工具治理
- Hermes Agent: 长期运行、通道、记忆、调度
- Superpowers: 设计到执行的工作流纪律
- Agent Lightning: traces、eval、优化层

调试能力方向的当前结论是：

- 先做 semantic debug
- 再做 debugger adapters
- raw memory CRUD 只做成 opt-in 的高风险调试层

## 当前目录

```text
newagent/
├── AGENTS.md              # 项目运行规则
├── README.md              # 项目总览
├── docs/                  # 结构化文档
├── notes/                 # 原始研究笔记
├── code/                  # 原型和可运行代码
└── references/            # 第三方参考资料
```

## 文档入口

- [requirements.md](./docs/requirements.md)
- [architecture.md](./docs/architecture.md)
- [roadmap.md](./docs/roadmap.md)
- [remote-server-manager.md](./docs/remote-server-manager.md)
- [aliyun-deploy-status.md](./docs/aliyun-deploy-status.md)
- [prompt-contracts.md](./docs/prompt-contracts.md)
- [prototype-m1.md](./docs/prototype-m1.md)
- [m1-execution-plan.md](./docs/m1-execution-plan.md)
- [m1-data-model.md](./docs/m1-data-model.md)
- [m1-storage-layout.md](./docs/m1-storage-layout.md)
- [debug-instrumentation.md](./docs/debug-instrumentation.md)
- [code/README.md](./code/README.md)

## 第一目标

第一目标不变，仍然是做出 `M1 Kernel`，但现在要明确服务于“远程服务器项目总管”：

- 单会话可执行
- 分层上下文装配
- 可见执行时间线
- 最小工具注册与审批模型
- 会话记忆 / 项目记忆分离
- 可恢复
- 可登记服务器项目
- 可固化远程总管默认画像
- 可调用 `codex` 做审核与纠错

当前实现状态：

- `docs/` 已冻结到数据模型和存储布局
- `code/` 已起步实现第一段 `Session Kernel`
- 已有最小可测原型覆盖：
  - `create session`
  - `load session`
  - `create plan`
  - `update session state`
  - `append timeline event`
  - `request approval`
  - `resolve approval`
  - `abort session`
  - `recover interrupted session`
- 已有一层薄命令面：
  - `profile show`
  - `project seed-aliyun`
  - `project list`
  - `project get`
  - `project register`
  - `start`
  - `resume`
  - `status`
  - `timeline`
  - `approve`
  - `reject`
  - `abort`

当前还不是完整可部署总管：

- 还没有交互式 shell loop
- 还没有远端常驻部署与值守验收
- 还没有真正接管阿里云上的生产任务

当前新增进展：

- 已有最小 `Context Router` 原型
- 已能从 `current input / session summary / session memory / project memory / skill refs` 选源
- 已能输出有界 merged context
- 已能落盘到 `context/latest-selection.json` 和 `context/latest-merged-context.json`
- 已有最小 `Tool Runtime + Permission Governance` 原型
- 已有 `safe` 与 `dangerous` 工具分层
- dangerous 工具已能转成审批对象而不是直接执行
- 已有 `memory add / memory search`
- 已有单步执行链 `step-run`
- 已能走 `context -> tool -> state transition`
- 已有远程服务器总管画像：
  - 飞书主通道
  - 百炼 `codingplan` 负责规划
  - 百炼 `qwen3.5-plus` 负责执行和总结
  - 远端默认不把 `codex` 放进主执行链
- 已有项目注册表原型：
  - `project register`
  - `project list`
  - `project seed-aliyun`
- 已有 `codex` 工具适配：
  - `codex_review_workspace`
  - `codex_repair_workspace`
  - 远端默认关闭，避免国内网络环境导致执行漂移
- 已把网页提取能力补成独立 worker 方案：
  - `web_extract_scrapling` 已有真实 `/v1/extract` worker 对接面
  - worker 可独立部署到阿里云并通过 `NEWAGENT_SCRAPLING_BASE_URL` 接回总管 runtime
  - 已在阿里云通过 PM2 常驻，并完成 `static / dynamic / stealth` 真请求验证
- 已有飞书长连接适配器：
  - `channel feishu-profile`
  - `channel feishu-send`
  - `manager feishu-serve`
- 已有百炼 provider adapter：
  - `provider invoke`
  - `manager intake-message`
- 已能走第一版总管 intake 闭环：
  - 飞书/手工消息进入
  - 自动创建总管会话
  - 自动载入远端 6 项目基线
  - 自动调用 `codingplan` 生成步骤
  - 自动把摘要和计划写入 timeline
  - 自动回一版中文确认摘要
- 已能在 runtime 内自动推进第一版 manager loop：
  - `inspect` 步骤会自动选择项目巡检工具
  - `report` 步骤会自动生成阶段汇报并写回 timeline
  - `review / repair` 适配已存在，但远端默认关闭
- 已有可重复 safe-path demo：`npm run demo:m1`
- 已有可重复 approval-path demo：`npm run demo:m1-approval`
- `approve --continue` 已能在同一命令里完成审批并继续执行

## 成功标准

如果后续原型能做到以下几点，就算这条线真正立住了：

- 用户知道 agent 在做什么
- 用户能在执行中打断或改方向
- shell 能记住该记住的内容，但不会失控膨胀
- 工具调用有边界，有审计，有恢复机制
- 新会话能接上旧任务，而不是从头再来
- 远程服务器上的项目、服务、发布和异常都能被统一管起来
- 飞书能成为稳定主入口
- 总管 agent 在需要时可接上外部 review / repair 适配

## 下一步

当前推荐推进顺序：

1. 固化远端 repo 外环境变量和远端主仓库维护流程
2. 开始接管真实线上任务

## 当前交接

- [m1-handoff.md](./docs/m1-handoff.md)

最后更新: `2026-04-02`
