# Newagent Self-Handoff 2026-04-02

## Mission

你现在运行在阿里云服务器上，目标不是继续当一个只会聊天的壳子，而是逐步把自己补成一个能稳定管理服务器、项目、消息通道、外部信息源、飞书工作台对象的长期 agent。

这次交接的重点不是“继续泛泛优化”，而是明确补完下面这几组能力：

1. `news_*`
2. `channel_feishu_doc_*`
3. `channel_feishu_drive_*`
4. `channel_feishu_wiki_*`
5. `channel_feishu_bitable_*`

## Hard Constraints

- 主系统不能挂。
- `newagent-manager` 和 `newagent-scrapling-worker` 不能因为这次开发失联。
- 先在仓库里完成实现和测试，再低风险重启。
- 不允许把飞书当成纯文本聊天渠道，最终要把它变成真正的工作台。
- 高风险动作可以先报备，不必等批准，但必须给出明确影响说明和阻止窗口。
- 如果发现自己无法独立推进代码改动，应立即通过 `ssh-channel` 找 `codex_mac_local`，不要空转。

## Current Known Facts

- 主交互通道是飞书长连接。
- 远端运行仓库是 `/root/newagent`。
- 当前已经有：
  - 项目 registry
  - 基础设施 registry
  - PM2 / 端口 / 服务探活能力
  - coworker 通道
  - 动态工具 registry
- 当前还缺：
  - 外部消息工具族的稳定落地
  - 飞书文档 / 云盘 / 知识库 / 多维表格的真正 CRUD 工具

## Expected Tool Taxonomy

内部工具必须继续按分族建设，不允许退回到“每次临时想命令”：

- `project_*`
- `infrastructure_*`
- `server_ops_*`
- `news_*`
- `channel_*`
- `coworker_*`
- `dynamic_tool_*`
- `tool_catalog_*`

原则：

- 高频、稳定、可复用动作做成内建工具。
- 环境偶发诊断动作先做动态工具。
- 动态工具必须进入 review queue。

## Phase Plan

### Phase 1: Verify Current Reality

先确认：

- 当前仓库是否干净
- 当前飞书 scopes 是否齐
- 当前 `tool-runtime` 里已有哪些 `channel_*` / `news_*`
- 当前测试是否全绿

产出：

- 一份简短现状报告
- 一份缺口列表

### Phase 2: Land `news_*`

目标：

- `news_source_list`
- `news_source_register`
- `news_general_collect`
- `news_stock_collect`
- `news_hot_collect`

要求：

- source registry 驱动，不把站点写死在 prompt
- 股票资讯优先参考股票系统里的实时资讯思路
- 自媒体热榜至少先接一个可用热榜源
- 返回结构统一：`source / request_url / items`

### Phase 3: Land Feishu Workspace CRUD

先做最小可用闭环：

1. 文档
   - 创建文档
   - 读取文档
   - 覆盖写入或追加写入
2. 云盘
   - 列目录
   - 建文件夹
   - 上传文件
3. 知识库
   - 列空间
   - 列节点
   - 创建节点
   - 改标题
4. 多维表格
   - 创建 app
   - 列表
   - 建表
   - 建字段
   - 写记录

要求：

- 所有写操作必须走审批或明确的危险工具路径
- 所有工具结果要结构化
- 所有工具都要可被 `tool_catalog_*` 发现

## Identity Requirement

用户明确希望飞书对象“像是以他本人身份在操作”。

现实处理原则：

- 如果当前只是 bot/app 身份，那先把对象创建、写入、分享闭环做通。
- 如果要真正以用户身份创建，需要补 `user_access_token` 路线。
- 不能假装已经实现“用户身份写入”。
- 一旦发现当前权限模型只能以 app 身份操作，要明确汇报这个事实。

## When To Ask Codex Coworker

下面这些情况不要自己硬扛，直接找 `codex_mac_local`：

- 飞书 API 行为和 SDK 不一致
- 文档 block 写入异常
- 多维表格 schema 设计卡住
- 自己改完后测试反复不稳定
- 需要跨多个模块的大改

提问格式要精确：

- 目标
- 当前现象
- 已验证事实
- 期望返回物

## Dynamic Script Policy

允许临时写脚本，但必须：

- 放在明确临时位置
- 注册进 `dynamic_tool_*`
- 带 `category / lifecycle / review_status`
- 事情做完进入 review queue

## Acceptance Criteria

完成这轮任务，至少要满足：

- `news_*` 可以稳定拉到一类通用源、一类股票源、一类热榜源
- `channel_feishu_*` 至少有 1 套文档 CRUD、1 套云盘 CRUD、1 套知识库 CRUD、1 套多维表格 CRUD
- 针对性测试通过
- 重启后 manager 仍在线
- 最终给用户一份简短结果，不要长篇废话

## Stop Conditions

遇到下面情况先停：

- 发现当前改动会导致飞书主通道中断
- 发现要改动鉴权模型且风险未厘清
- 发现远端内存不足以安全重启
- 发现自己的代码改动已经超出当前上下文把控范围

停下时要做：

- 说明卡点
- 给出 1 到 2 个下一步选项
- 必要时发 coworker 请求给 `codex_mac_local`
