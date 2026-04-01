# Claude Code 完整技术文档学习笔记 v2

**学习日期**: 2026-03-31  
**版本**: Claude Code v2.1.88  
**资料来源**: plain-sun-1ffe.hunshcn429.workers.dev

---

## 📋 目录

1. [总体架构](#总体架构)
2. [启动流程](#启动流程)
3. [特性门控系统](#特性门控系统)
4. [查询引擎](#查询引擎)
5. [权限安全系统](#权限安全系统)
6. [开发者指南](#开发者指南)
7. [数据流架构](#数据流架构)

---

## 总体架构

### 6 层分层架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 6: UI 交互层 (Ink / React / Components / Hooks)          │
├─────────────────────────────────────────────────────────────────┤
│  Layer 5: 命令层 (commands/ — 70+ 斜杠命令 + 技能)             │
├─────────────────────────────────────────────────────────────────┤
│  Layer 4: 工具层 (tools/ — 40+ 内置工具 + MCP 扩展)             │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: 查询引擎层 (QueryEngine + queryLoop + TokenBudget)    │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: 服务层 (services/ — compact/analytics/mcp/lsp/oauth)  │
├─────────────────────────────────────────────────────────────────┤
│  Layer 1: 基础设施层 (state/bridge/entrypoints/utils/constants) │
└─────────────────────────────────────────────────────────────────┘
```

### Layer 1: 基础设施层

| 模块 | 文件数 | 职责 |
|------|--------|------|
| state/ | 6 | 全局 AppState 存储，DeepImmutable 包装，80+ 字段 |
| bridge/ | 31 | 与 claude.ai 的远程通信（轮询/WebSocket/SSE） |
| entrypoints/ | 6 | CLI 入口、初始化、MCP 服务器入口 |
| constants/ | 21 | 系统提示词、API 限制、错误码、OAuth 配置 |
| utils/ | 300+ | 文件操作、Shell、Git、加密、模型、权限等 |
| types/ | 8 | 全局类型定义 |

### Layer 2: 服务层

| 服务目录 | 核心功能 |
|----------|----------|
| compact/ | 11 文件，3 级会话压缩（微压缩→自动压缩→会话记忆） |
| analytics/ | 9 文件，Datadog + 1P OpenTelemetry 双通道遥测 |
| mcp/ | 23 文件，MCP 协议客户端/服务器、工具转换、6 层配置合并 |
| lsp/ | 7 文件，语言服务器协议集成（诊断、补全） |
| oauth/ | 5 文件，OAuth 2.0 + PKCE 认证流程 |
| tools/ | 4 文件，工具执行引擎（StreamingToolExecutor，并发度 10） |

---

## 启动流程

### 启动链概览

```
用户执行 claude 命令
    ↓
entrypoints/cli.tsx (~303 行) — 命令行路由
    ↓
main.tsx (~4684 行) — Commander.js 配置 + 迁移
    ↓
entrypoints/init.ts (~309 行) — 16 步初始化
    ↓
screens/REPL.tsx — 交互式界面 (t=350ms 首帧渲染)
```

### CLI 路由表 (部分)

| 条件 | 目标 | 说明 |
|------|------|------|
| `--version` | 直接输出版本 | 零模块加载快速路径 |
| `--daemon-worker` | Daemon Worker | 内部 worker 进程 |
| `remote/bridge/sync` | Bridge 模块 | claude.ai 桥接 |
| `daemon` | 守护进程 | 后台运行 |
| `ps/logs/attach/kill` | 会话管理 | 后台会话管理 |
| 默认 | main.tsx → REPL | 交互式终端界面 |

### 迁移系统 (11 个迁移)

```typescript
const CURRENT_MIGRATION_VERSION = 11

// 同步迁移 (9 个):
migrateAutoUpdatesToSettings()
migrateBypassPermissionsAcceptedToSettings()
migrateEnableAllProjectMcpServersToSettings()
resetProToOpusDefault()
migrateSonnet1mToSonnet45()
migrateLegacyOpusToCurrent()
migrateSonnet45ToSonnet46()
migrateOpusToOpus1m()
migrateReplBridgeEnabledToRemoteControlAtStartup()

// 条件迁移 (2 个):
resetAutoModeOptInForDefaultOffer()  // 仅 feature('TRANSCRIPT_CLASSIFIER')
migrateFennecToOpus()                // 仅内部构建 (ant)
```

### 初始化步骤 (16 步)

```typescript
async function init() {
  // 1. enableConfigs()
  // 2. applySafeConfigEnvironmentVariables()
  // 3. setupGracefulShutdown()
  // 4. 初始化 1P 事件日志 + GrowthBook
  // 5. populateOAuthAccountInfoIfNeeded()
  // 6. initJetBrainsDetection()
  // 7. detectCurrentRepository()
  // 8. initializeRemoteManagedSettingsLoadingPromise()
  // 9. configureGlobalMTLS()
  // 10. configureGlobalAgents()
  // 11. preconnectAnthropicApi()
  // 12. registerCleanup(shutdownLspServerManager)
}
```

### 启动时序图

```
t=0ms    cli.tsx main() 开始
t=10ms   dynamic import main.tsx
t=25ms   Commander.js 解析选项
t=30ms   runMigrations() (11 个迁移)
t=50ms   init() 开始
t=220ms  REPL.tsx 挂载
t=250ms  AppState 初始化 (80+ 字段)
t=280ms  工具池构建
t=300ms  Ink 渲染引擎启动
t=350ms  首帧渲染 ✅
t=400ms  等待用户输入
```

---

## 特性门控系统

### 编译时特性门控

```typescript
// 构建时由 Bun bundler 内联为 true/false
function feature(flag: FeatureFlag): boolean {
  return FEATURE_FLAGS[flag] === true
}

// 使用示例
if (feature('VOICE_MODE')) {
  // 当 VOICE_MODE=false 时，整个分支被 tree-shake 消除
  const voiceEngine = await import('./voice/voiceEngine')
}
```

### ~47 个编译时 Flag

#### 核心功能 Flag

| Flag | 用途 |
|------|------|
| `BRIDGE_MODE` | claude.ai Web 端 Bridge 通信 |
| `DAEMON` | 守护进程/后台运行模式 |
| `BG_SESSIONS` | 后台会话管理 |
| `VOICE_MODE` | 语音输入/输出 |
| `KAIROS` | 高级时间/计划功能 |
| `TEMPLATES` | 项目模板系统 |
| `PROACTIVE` | 主动建议模式 |

#### 工具 Flag

| Flag | 控制的功能 |
|------|-----------|
| `AGENT_TRIGGERS` | CronCreate/Delete/ListTool |
| `WORKFLOW_SCRIPTS` | WorkflowTool |
| `WEB_BROWSER_TOOL` | WebBrowserTool |
| `CONTEXT_COLLAPSE` | CtxInspectTool |
| `HISTORY_SNIP` | SnipTool |
| `FORK_SUBAGENT` | Fork 子代理 |
| `TOKEN_BUDGET` | Token 预算系统 |

### GrowthBook vs feature()

| 维度 | feature() | GrowthBook |
|------|-----------|------------|
| **时机** | 编译时 | 运行时 |
| **产物影响** | 代码被消除 | 代码保留 |
| **变更方式** | 重新构建 | 远程配置刷新 |
| **用途** | 构建变体 | A/B 测试、灰度发布 |

---

## 查询引擎

### 核心文件

- `QueryEngine.ts` (~1000+ 行) — 会话管理
- `query.ts` (~1200+ 行) — 查询循环
- `query/tokenBudget.ts` — Token 预算管理

### 查询循环 12 步

```typescript
async function* query(params): AsyncGenerator<SDKMessage> {
  while (true) {
    // Step 1: Snip 压缩 (Feature-Gated)
    // Step 2: 微压缩 (工具结果级别)
    // Step 3: 上下文折叠 (Feature-Gated)
    // Step 4: 自动压缩 (上下文过大时)
    // Step 5: 计算 token 预算
    // Step 6: API 调用 (流式请求)
    // Step 7: 流式工具执行 (并发度 max=10)
    // Step 8: 回填工具结果
    // Step 9: 阻塞限制检查
    // Step 10: 4 级错误恢复
    // Step 11: 停止钩子检查
    
    if (shouldStop || stopReason === 'end_turn') break
  }
}
```

### 4 级错误恢复

1. **反应式压缩** — `prompt too long` 或上下文溢出
2. **上下文折叠排空** — 折叠旧内容
3. **最大输出 token 恢复** — 升级 `max_tokens` 重试 (最多 3 次)
4. **媒体错误恢复** — 图片/PDF 过大降级处理

### Token 预算阈值

| 使用率 | 行为 |
|--------|------|
| <70% | 正常发送 |
| 70%-85% | 触发自动压缩 |
| 85%-95% | 触发阻塞压缩 |
| >95% | 触发紧急折叠 |

---

## 权限安全系统

### 7 种权限模式

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| **default** | 敏感工具需要用户确认 | 默认安全模式 |
| **plan** | 仅规划，不执行写入 | 审查模式 |
| **acceptEdits** | 自动接受文件编辑 | 信任编辑 |
| **bypassPermissions** | 跳过所有权限检查 | 开发调试（危险） |
| **dontAsk** | 不询问用户 | 非交互式模式 |
| **auto** | AI 分类器自动判断 | ANT 内部 |
| **bubble** | 冒泡到父级权限 | 子任务 |

### 权限规则配置

```json
{
  "permissions": {
    "allow": ["Read(**)", "Glob(**)", "Grep(**)"],
    "deny": ["Bash(rm -rf *)", "FileWrite(/etc/**)"],
    "ask": ["Bash(*)", "FileWrite(**)"],
    "defaultMode": "default"
  }
}
```

### 权限检查流程

```
tool.checkPermissions(context)
    ↓
1. 检查 deny 规则 → 匹配则 DENIED
    ↓
2. 检查 allow 规则 → 匹配则 ALLOWED
    ↓
3. 检查 ask 规则 → 匹配则 ASK_USER
    ↓
4. 检查工具默认 → isReadOnly() ? ALLOWED : ASK_USER
    ↓
5. 权限模式兜底
```

### YOLO 分类器 (Auto 模式)

```json
{
  "autoMode": {
    "rules": [
      { "pattern": "Read(**)", "action": "allow" },
      { "pattern": "Bash(git *)", "action": "allow" },
      { "pattern": "Bash(rm *)", "action": "deny" },
      { "pattern": "Bash(sudo *)", "action": "deny" }
    ]
  }
}
```

### 27 种 Hook 事件

- PreToolUse / PostToolUse / PostToolUseFailure
- UserPromptSubmit / SessionStart / SessionEnd
- SubagentStart / SubagentStop
- PreCompact / PostCompact
- PermissionRequest / PermissionDenied
- TaskCreated / TaskCompleted
- ... 更多

---

## 开发者指南

### 环境准备

| 工具 | 版本 | 用途 |
|------|------|------|
| Bun | 最新版 | 运行时、构建工具、包管理器 |
| Node.js | 18+ | 部分原生模块编译 |
| Git | 2.x | 源码管理 |

### 代码模式与约定

#### 1. React Compiler Runtime

```typescript
// 构建产物中自动注入 memo 化
import { c as _c } from "react/compiler-runtime"

// 开发者只需写普通代码
function MyComponent({ data }) {
  const processed = expensiveCompute(data) // 自动被 memo 化
  return <Box>{processed}</Box>
}
```

#### 2. Feature Gate 模式

```typescript
import { feature } from '../constants/common'

if (feature('VOICE_MODE')) {
  // 此分支在非 VOICE_MODE 构建中被完全消除
}
```

#### 3. 延迟 Import 模式

```typescript
// ✅ 正确 — 延迟加载
const { QueryEngine } = await import('./QueryEngine')

// ❌ 避免 — 静态导入大模块
import { QueryEngine } from './QueryEngine'
```

#### 4. useSyncExternalStore 模式

```typescript
// 创建 Store
const store = createStore<AppState>(initialState)

// 组件订阅（自动选择性重渲染）
function MyComponent() {
  const model = useAppState(s => s.mainLoopModel)
  // 仅在 s.currentModel 变化时重渲染
}
```

### 关键类型

#### Tool 接口

```typescript
interface Tool<Input = unknown, Output = unknown> {
  name: string
  description(input: Input, options?): Promise<string>
  inputSchema: Input  // Zod schema 对象
  call(args: Input, context: ToolUseContext, canUseTool: CanUseToolFn, parentMessage: Message): Promise<ToolResult<Output>>
  checkPermissions(input: Input, context: ToolPermissionContext): Promise<PermissionResult>
  isReadOnly(input: Input): boolean
  isDestructive?(input?: Input): boolean
  isConcurrencySafe(input: Input): boolean
  // ...约 55 个成员
}
```

#### AppState (80+ 字段)

```typescript
interface AppState {
  settings: Settings
  mainLoopModel: string
  mainLoopModelForSession: string | undefined
  toolPermissionContext: DeepImmutable<ToolPermissionContext>
  tasks: Tasks
  agentNameRegistry: AgentNameRegistration[]
  fileHistory: FileHistory
  mcp: McpState
  plugins: PluginsState
  // ...80+ 字段
}
```

### 调试技巧

#### 环境变量

| 变量 | 用途 |
|------|------|
| `CLAUDE_CODE_DEBUG=1` | 启用调试日志 |
| `CLAUDE_CODE_DEBUG_REPAINTS=1` | Ink 重绘归因调试 |
| `CLAUDE_CODE_SHELL` | 覆盖默认 Shell |

#### 日志查看

```bash
# 会话日志位置
~/.claude/logs/

# 实时查看日志
tail -f ~/.claude/logs/current.log
```

---

## 数据流架构

### 用户输入 → AI 响应流

```
用户输入 (PromptInput.tsx)
    ↓
handlePromptSubmit() — 输入预处理
    ↓
QueryEngine.submitMessage() — 构建消息
    ↓
queryLoop() — 无限循环 {
    tokenBudget.compute() — 预算计算
    → API.createMessage() — 调用 Claude
    → streamToolUses() — 执行工具
    → backfill results — 回填结果
    → 检查 stop_reason
}
    ↓
Messages.tsx — 渲染消息
    ↓
VirtualMessageList — 虚拟滚动显示
```

### 工具执行流

```
API 返回 tool_use block
    ↓
StreamingToolExecutor.execute() (并发度 max=10)
    ↓
tool.checkPermissions() — 权限检查
    ↓ (需要授权)
PermissionRequest UI — 用户确认
    ↓ (已授权)
tool.call(args, context, canUseTool, parentMessage) — 执行工具
    ↓
Promise<ToolResult<Output>> — 工具结果
    ↓
tool_result 注入消息队列 — 下一轮循环
```

### 状态更新流

```
setState(updater) — 状态变更
    ↓
Store.notify() — 通知订阅者
    ↓
useSyncExternalStore() — React 组件同步
    ↓
Ink reconciler — 重新协调
    ↓
Yoga layout — 布局计算
    ↓
Screen buffer diff — 差异渲染
    ↓
Terminal ANSI output — 终端写入
```

---

## 构建架构

### FEATURE() 编译时消除

```typescript
// 构建时根据编译目标，对应代码被完全消除
if (feature('VOICE_MODE')) {
  // 整个分支在非 VOICE_MODE 构建中被 tree-shake
  await import('./voice/voiceEngine')
}
```

### 延迟导入 + 动态 IMPORT

```typescript
// 大多数模块使用 lazy dynamic import 减少启动时间
const { QueryEngine } = await import('./QueryEngine')
```

### REACT COMPILER RUNTIME

```typescript
// 构建产物中自动注入 memo 化代码
import { c as _c } from "react/compiler-runtime"
// 消除手写 useMemo / useCallback 的需要
```

---

*最后更新：2026-03-31*  
*版本：Claude Code v2.1.88*  
*总大小：约 25KB*
