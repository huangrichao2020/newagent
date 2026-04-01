# Claude Code 完整技术文档学习笔记

**学习日期**: 2026-03-31  
**资料来源**: 
- 架构概览页面 (完整获取)
- claude-code-sourcemap (4,756 源码文件)
- claude-code-deep-dive (1,091 行研究报告)

**版本**: Claude Code v2.1.88

---

## 📋 目录

1. [项目定位](#项目定位)
2. [技术栈](#技术栈)
3. [6 层架构](#6-层架构)
4. [核心设计理念](#核心设计理念)
5. [数据流](#数据流)
6. [安全架构](#安全架构)
7. [多 AI 提供商支持](#多 ai 提供商支持)
8. [对新一代 Agent 外壳的启发](#对新一代 agent 外壳的启发)

---

## 项目定位

Claude Code 是 Anthropic 官方的 AI 编程助手命令行工具，允许用户通过终端与 Claude AI 模型进行交互式对话，执行代码编辑、文件操作、命令运行等编程任务。

**v2.1.88 特性**:
- ✅ 完整的工具链 (45+ 内置工具)
- ✅ 远程通信支持 (Bridge)
- ✅ 多模型支持 (Anthropic/AWS/Azure/Google)
- ✅ 企业级特性 (权限/策略/审计)

---

## 技术栈

### 运行时与构建

| 层级 | 技术 | 说明 |
|------|------|------|
| **运行时** | **Bun** | 高性能 JS/TS 运行时，直接执行.ts/.tsx，原生支持 ESM |
| **编译时** | **bun:bundle** | `feature()` 实现死代码消除 |
| **运行时特性** | **GrowthBook** | 远程配置动态控制功能 |
| **堆内存** | **8GB** | `--max-old-space-size=8192` |

### 前端/UI

| 层级 | 技术 | 说明 |
|------|------|------|
| **框架** | **React 19** | 组件化 UI 开发 |
| **终端渲染** | **Ink** | React → 终端 ANSI 输出 |
| **布局引擎** | **Yoga** | Facebook Flexbox 布局引擎 |
| **性能优化** | **React Compiler Runtime** | `react/compiler-runtime` 自动记忆化 |
| **渲染帧率** | **60 FPS** | 自定义 Ink 渲染器，含 FPS 计量 |

### 数据验证与通信

| 层级 | 技术 | 说明 |
|------|------|------|
| **Schema 验证** | **Zod v4** | 所有工具输入/输出的运行时类型验证 |
| **AI 协议** | **MCP** | Stdio/SSE/WebSocket/HTTP 四种传输 |
| **LSP** | **Language Server Protocol** | 代码智能分析集成 |
| **API SDK** | **@anthropic-ai/sdk** | 官方 SDK 封装 |

### 状态管理

| 层级 | 技术 | 说明 |
|------|------|------|
| **Store** | **自研轻量 Store** | 类 Zustand 的 `getState/setState/subscribe` |
| **React 集成** | **useSyncExternalStore** | React 18+ 外部 Store 订阅标准 API |
| **不可变性** | **DeepImmutable<T>** | 编译期确保状态不可变 |

---

## 6 层架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                         入口层 (Entrypoints)                          │
│  cli.tsx │ mcp.ts │ agentSdkTypes.ts │ init.ts                       │
│  快速路径优化 │ MCP Server │ Agent SDK │ 初始化链                     │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────────┐
│                         屏幕层 (Screens)                             │
│  REPL.tsx │ Doctor.tsx │ ResumeConversation.tsx                      │
│  主交互循环 │ 环境诊断 │ 会话恢复                                    │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────────┐
│                       组件层 (Components)                            │
│  App.tsx(FpsMetrics→Stats→AppState Provider 组合)                    │
│  StatusLine.tsx │ VirtualMessageList.tsx │ ToolUseLoader.tsx          │
│  200+ 组件 │ 虚拟滚动 │ 动画加载器                                   │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────────┐
│                      引擎层 (Query Engine)                           │
│  QueryEngine.ts │ query/config.ts │ query/tokenBudget.ts             │
│  核心 AI 对话循环 │ 会话配置 │ Token 预算管理                        │
│  │                                                                   │
│  query() → processUserInput() → API Call → 消息流处理 → SDK 消息     │
│  成本跟踪 │ 历史记录 │ 中断支持 │ 结构化输出重试                     │
└──┬───────────────┬───────────────────┬──────────────────────────────┘
   │               │                   │
┌──▼──────┐  ┌─────▼──────┐  ┌────────▼──────────────────────────────┐
│工具系统 │  │ 命令系统   │  │         服务层 (Services)              │
│Tool.ts  │  │commands.ts │  │  claude.ts   │ 500+ 行模型查询         │
│tools.ts │  │60+命令目录 │  │  withRetry.ts│ 700+ 行重试逻辑         │
│45+工具  │  │120+命令    │  │  client.ts   │ 多提供商 API 工厂       │
│+MCP扩展 │  │+技能命令   │  │  mcp/        │ MCP 客户端/配置/类型    │
└──┬──────┘  └─────┬──────┘  └────────┬──────────────────────────────┘
   │               │                   │
┌──▼───────────────▼───────────────────▼──────────────────────────────┐
│                    状态管理层 (State)                                 │
│  Store<T>: getState/setState/subscribe                               │
│  AppState: 50+ DeepImmutable 字段                                    │
│  ToolPermissionContext: 权限模式 + 规则层                            │
│  selectors.ts: 派生计算 │ onChangeAppState.ts: 变更监听             │
└──┬──────────────────────────────────────────────────────────────────┘
   │
┌──▼──────────────────────────────────────────────────────────────────┐
│                    基础设施层 (Infrastructure)                        │
│  bridge/   远程通信 │ hooks/   90+ React Hook                       │
│  plugins/  插件系统 │ skills/  技能加载                              │
│  utils/    150+ 工具 │ constants/ 提示词/系统/工具常量               │
│  types/    完整类型定义 │ tasks/ 任务执行框架                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 核心设计理念

### 1. 编译时死代码消除

```typescript
// bun:bundle 编译时标志 — 未启用的路径在编译时被移除
import { feature } from 'bun:bundle'

if (feature('OVERLAP_TEST_TOOL')) {
  // 此代码块仅在 OVERLAP_TEST_TOOL 启用时编译到产物中
  tools.push(OverlapTestTool)
}
```

**控制的 Feature**:
- `CONTEXT_COLLAPSE` — 上下文折叠
- `TERMINAL_PANEL` — 终端面板
- `WORKFLOWS` — 工作流引擎
- `REPL` — REPL 工具
- `MONITOR_TOOL` — 监控 MCP 任务

---

### 2. Memoization 策略

```typescript
// 单次计算缓存 — 避免重复初始化
const COMMANDS = memoize(() => { /* 120+ commands assembly */ })
const builtInCommandNames = memoize(() => { /* name set */ })
const loadAllCommands = memoize(async (cwd) => { /* skill+plugin+builtin */ })
```

**关键 memoized 函数**:
- `getSystemContext()` — Git 状态（会话级缓存）
- `getUserContext()` — CLAUDE.md + 日期
- `getGitStatus()` — Git 分支/状态/日志
- `loadAllCommands(cwd)` — 按 cwd memoized
- `getSkillToolCommands(cwd)` — 技能命令缓存

---

### 3. DeepImmutable 类型安全

```typescript
// 所有 AppState 字段使用 DeepImmutable 包装
type AppState = DeepImmutable<{
  mcp: MCPState
  plugins: PluginState
  fileHistory: FileHistoryState
  // ... 50+ 字段
}>
```

**状态容器分类**:
- **不可变对象** — `mcp`, `plugins`, `fileHistory` 等业务状态
- **可变容器** — `tasks`, `agentNameRegistry` 等需要频繁修改的引用

---

### 4. 异步生成器消息流

```typescript
// QueryEngine 核心是 AsyncGenerator
async *submitMessage(prompt): AsyncGenerator<SDKMessage, void, unknown> {
  // 1. processUserInput(prompt)
  // 2. yield* from query() generator
  // 3. yield SDK messages (assistant/user/progress/stream_event)
  // 4. check budget limits
}
```

**消息处理链**:
- `ask()` — 顶级便利包装器
- `QueryEngine.submitMessage()` — 核心查询循环
- `query()` — API 调用与流式处理
- 通过 `yield` 向上游传递 SDK 消息

---

### 5. 工具排序保持 Prompt 缓存稳定

```typescript
// assembleToolPool() 中按名称排序
// 确保工具列表在不同请求间保持相同顺序
// 从而最大化 Anthropic API 的 prompt 缓存命中率
const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))
return uniqBy(sorted, t => t.name)
```

**关键洞察**: 工具排序影响 prompt cache 命中率！

---

## 数据流

```
用户输入
  │
  ▼
processUserInput() ─── 解析斜杠命令/图片/URL
  │
  ▼
QueryEngine.submitMessage()
  │
  ├─ fetchSystemPromptParts() ─── 组装系统提示词
  │    ├─ getSimpleIntroSection()      // 基本介绍
  │    ├─ getSimpleSystemSection()     // 系统信息
  │    ├─ getActionsSection()          // 行为指南
  │    ├─ getUsingYourToolsSection()   // 工具使用
  │    ├─ getSessionSpecificGuidance() // 会话特定
  │    ├─ getLanguageSection()         // 语言偏好
  │    └─ getOutputStyleSection()      // 输出样式
  │
  ▼
query() ─── 调用 claude.ts 的 API 查询
  │
  ├─ 构造请求：model + messages + tools + system prompt
  ├─ 缓存策略：1h TTL (3600s)，thinking config，effort params
  ├─ Zod schema → API schema 转换
  │
  ▼
API 流式响应
  │
  ├─ message_start  → 重置 currentMessageUsage
  ├─ content_block  → 文本/工具调用/thinking
  ├─ message_delta  → 累加使用量
  ├─ message_stop   → 合并 totalUsage
  │
  ▼
工具调用分发
  │
  ├─ checkPermissions(input, context) → allow/ask/deny
  ├─ validateInput(input, context) → ValidationResult
  ├─ tool.call(input, context, canUseTool, ...) → ToolResult
  │
  ▼
结果处理
  │
  ├─ 成本跟踪：addToTotalSessionCost()
  ├─ 历史记录：recordTranscript()
  ├─ 预算检查：checkTokenBudget() (90% 阈值 + 递减检测)
  │
  ▼
yield SDKMessage → UI 渲染
```

---

## 安全架构

### 权限决策链

```
┌─────────────────────────────────────────────┐
│              权限决策链                       │
│                                             │
│  policySettings (企业策略，最高优先级)       │
│       ↓                                     │
│  alwaysDenyRules (拒绝规则)                 │
│       ↓                                     │
│  alwaysAllowRules (允许规则)                │
│       ↓                                     │
│  alwaysAskRules (询问规则)                  │
│       ↓                                     │
│  PermissionMode 默认行为                    │
│    - default (提示用户)                     │
│    - acceptEdits (接受编辑)                 │
│    - bypassPermissions (跳过权限)           │
│    - plan (规划模式，只读)                  │
│    - auto (自动分类器判断)                  │
│    - dontAsk (不询问)                       │
│    - bubble (冒泡到父级)                    │
└─────────────────────────────────────────────┘
```

### 规则来源优先级（从高到低）

1. `policySettings` — 企业管理策略
2. `flagSettings` — Feature Flag 控制
3. `cliArg` — 命令行参数
4. `localSettings` — 本地项目 `.claude/settings.json`
5. `projectSettings` — 项目级 `CLAUDE.md`
6. `userSettings` — 用户级 `~/.claude/settings.json`
7. `session` — 会话内交互
8. `command` — 命令级覆盖

---

## 多 AI 提供商支持

| 提供商 | 协议 | 认证 |
|--------|------|------|
| **Anthropic Direct** | HTTPS | API Key |
| **AWS Bedrock** | Bedrock SDK | AWS Credentials |
| **Azure Foundry** | Azure OpenAI 协议 | Azure AD Token |
| **Google Vertex AI** | Vertex SDK | GCP Credentials |

通过 `getAnthropicClient()` 工厂统一创建，共享相同的查询/重试/成本跟踪逻辑。

---

## 项目规模

| 类别 | 数量 |
|------|------|
| 源码文件 | 500+ |
| 内置工具 | 45+ |
| 命令 | 120+ |
| UI 组件 | 200+ |
| Hooks | 90+ |
| 工具函数 | 150+ |

---

## 对新一代 Agent 外壳的启发

### 1. 架构设计

```typescript
class NextGenAgentShell {
  // 6 层架构
  async execute(task: Task) {
    // 1. 入口层：解析用户输入
    const input = await this.parseInput(task);
    
    // 2. 屏幕层：选择交互界面
    const screen = this.selectScreen(input.type);
    
    // 3. 组件层：组装 UI 组件
    const components = this.assembleComponents(screen);
    
    // 4. 引擎层：核心 AI 循环
    const result = await this.queryEngine.submit(input);
    
    // 5. 状态层：管理状态变更
    this.store.setState({ result });
    
    // 6. 基础设施：工具/插件/技能
    return this.infrastructure.execute(result);
  }
}
```

### 2. 性能优化

| 技术 | 应用 |
|------|------|
| **编译时死代码消除** | Feature Flag 控制编译产物 |
| **Memoization** | 会话级缓存 Git 状态/命令 |
| **DeepImmutable** | 编译期状态不可变保证 |
| **AsyncGenerator** | 流式消息处理 |
| **工具排序** | Prompt Cache 命中优化 |

### 3. 安全设计

- 7 种权限模式
- 8 层规则优先级
- Hook 安全拦截
- YOLO 分类器

### 4. 多提供商支持

通过工厂模式统一 API 创建，共享查询/重试/成本跟踪逻辑。

---

## 📝 待深入研究

由于部分子页面返回 404，以下内容基于源码研究补充：

- [ ] QueryEngine.ts 完整实现 (已研究)
- [ ] tools.ts 45+ 工具详情 (已研究)
- [ ] commands.ts 120+ 命令列表
- [ ] claude.ts 500+ 行模型查询
- [ ] withRetry.ts 700+ 行重试逻辑
- [ ] MCP 客户端实现
- [ ] Bridge 远程通信

---

*最后更新：2026-03-31*  
*版本：Claude Code v2.1.88*
