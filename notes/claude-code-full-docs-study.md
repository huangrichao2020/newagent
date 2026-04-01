# Claude Code 完整技术文档学习笔记

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
8. [对新一代 Agent 外壳的启发](#对新一代 agent 外壳的启发)

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
entrypoints/init.ts (~309 行) — 多步骤初始化
    ↓
screens/REPL.tsx — 交互式界面
```

### CLI 路由表

| 条件 | 目标 | 说明 |
|------|------|------|
| `--version` | 直接输出版本 | 零模块加载快速路径 |
| `--dump-system-prompt` | 导出系统提示词 | feature gate |
| `--daemon-worker` | Daemon Worker | 内部 worker 进程 |
| `remote/bridge/sync` | Bridge 模块 | claude.ai 桥接 |
| `daemon` | 守护进程 | 后台运行 |
| `ps/logs/attach/kill` | 会话管理 | 后台会话管理 |
| 默认 | main.tsx → REPL | 交互式终端界面 |

### 迁移系统

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

// 异步迁移 (1 个):
migrateChangelogFromConfig()  // fire-and-forget
```

### 初始化步骤

```typescript
async function init() {
  // 1. enableConfigs() — 验证并启用配置系统
  // 2. applySafeConfigEnvironmentVariables()
  // 3. setupGracefulShutdown() — 注册 SIGINT/SIGTERM/exit 清理
  // 4. 初始化 1P 事件日志 + GrowthBook
  // 5. populateOAuthAccountInfoIfNeeded() — OAuth 账户信息
  // 6. initJetBrainsDetection() — JetBrains IDE 检测
  // 7. detectCurrentRepository() — 当前仓库检测
  // 8. initializeRemoteManagedSettingsLoadingPromise()
  // 9. configureGlobalMTLS() — mTLS 客户端证书
  // 10. configureGlobalAgents() — 代理配置
  // 11. preconnectAnthropicApi() — API 预连接
  // 12. registerCleanup(shutdownLspServerManager) — LSP 清理
}
```

### 启动时序

| 时间 | 事件 |
|------|------|
| t=0ms | cli.tsx main() 开始 |
| t=10ms | dynamic import main.tsx |
| t=25ms | Commander.js 解析选项 |
| t=30ms | runMigrations() (11 个迁移) |
| t=50ms | init() 开始 |
| t=220ms | REPL.tsx 挂载 |
| t=250ms | AppState 初始化 (80+ 字段) |
| t=280ms | 工具池构建 |
| t=300ms | Ink 渲染引擎启动 |
| t=350ms | 首帧渲染 |
| t=400ms | 等待用户输入 |

---

## 查询引擎

### 核心文件

- `QueryEngine.ts` (~1000+ 行) — 会话管理
- `query.ts` (~1200+ 行) — 查询循环
- `query/tokenBudget.ts` — Token 预算管理

### QueryEngine 类结构

```typescript
class QueryEngine {
  // 配置
  private config: QueryEngineConfig  // ~20 个配置字段

  // 会话状态
  private mutableMessages: Message[]
  private totalUsage: NonNullableUsage
  private permissionDenials: SDKPermissionDenial[]
  private readFileState: FileStateCache
  private abortController: AbortController
  private discoveredSkillNames: Set<string>
  
  // 核心方法
  async *submitMessage(prompt, options?): AsyncGenerator<SDKMessage>
  async cancel(): void
  getMessages(): readonly Message[]
}
```

### 查询循环完整流程

```typescript
async function* query(params: QueryParams): AsyncGenerator<SDKMessage> {
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
    
    if (shouldStop || stopReason === 'end_turn') {
      break
    }
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
    "allow": [
      "Read(**)",
      "Glob(**)",
      "Grep(**)",
      "WebSearch"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "FileWrite(/etc/**)"
    ],
    "ask": [
      "Bash(*)",
      "FileWrite(**)"
    ],
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
5. 权限模式兜底:
   - default → ASK_USER
   - auto → 调用 YOLO 分类器
   - bypassAll → ALLOWED
   - plan → DENIED
```

### YOLO 分类器 (Auto 模式)

```json
{
  "autoMode": {
    "rules": [
      { "pattern": "Read(**)", "action": "allow" },
      { "pattern": "Bash(git *)", "action": "allow" },
      { "pattern": "Bash(npm *)", "action": "allow" },
      { "pattern": "FileWrite(src/**)", "action": "allow" },
      { "pattern": "Bash(rm *)", "action": "deny" },
      { "pattern": "Bash(sudo *)", "action": "deny" }
    ]
  }
}
```

### BashTool 安全系统

**23+ 安全检查类型**:
```typescript
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,
  JQ_SYSTEM_FUNCTION: 2,
  SHELL_METACHARACTERS: 5,
  DANGEROUS_VARIABLES: 6,
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,
  IFS_INJECTION: 11,
  PROC_ENVIRON_ACCESS: 13,
  CONTROL_CHARACTERS: 17,
  // ... 更多
}
```

### Hook 安全拦截

**27 种 Hook 事件**:
- PreToolUse / PostToolUse / PostToolUseFailure
- UserPromptSubmit / SessionStart / SessionEnd
- SubagentStart / SubagentStop
- PreCompact / PostCompact
- PermissionRequest / PermissionDenied
- TaskCreated / TaskCompleted
- ... 更多

**Hook 结果**:
```typescript
interface HookResult {
  allow: boolean       // 是否允许继续
  message?: string     // 拒绝原因
  modified?: unknown   // 修改后的输入
}
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

## 对新一代 Agent 外壳的启发

### 1. 架构设计

```typescript
class NextGenAgentShell {
  // 6 层架构
  async execute(task: Task) {
    // L1: 基础设施
    const config = await this.loadConfig(task);
    
    // L2: 服务层
    const services = await this.initServices(config);
    
    // L3: 查询引擎
    const result = await this.queryEngine.submit(task);
    
    // L4: 工具层
    const tools = await this.executeTools(result);
    
    // L5: 命令层
    const commands = await this.routeCommands(tools);
    
    // L6: UI 层
    return this.renderUI(commands);
  }
}
```

### 2. 启动优化

| 技术 | 应用 |
|------|------|
| 延迟 import | 按需加载模块 |
| 记忆化初始化 | 每阶段只执行一次 |
| 并行加载 | MCP 客户端并行连接 |
| 延迟遥测 | 信任建立后才加载 OTEL |
| 渐进渲染 | 首帧先显示 Logo+ 输入框 |

### 3. 安全设计

- 7 种权限模式
- 规则匹配语法 (`工具名 (参数模式)`)
- YOLO 分类器 (AI 风险评估)
- 23+ Bash 安全检查
- 27 种 Hook 事件拦截

### 4. Token 优化

- 微压缩 (工具结果级别)
- 上下文折叠 (旧内容摘要)
- 自动压缩 (AI 生成摘要)
- 阻塞压缩 (紧急情况)
- 4 级错误恢复

---

## 📝 待深入研究

- [ ] Tool.ts 40+ 工具完整列表
- [ ] commands.ts 120+ 命令路由
- [ ] Bridge 轮询架构详解
- [ ] MCP 6 层配置合并逻辑
- [ ] compact 3 级压缩实现
- [ ] Ink 渲染引擎定制

---

*最后更新：2026-03-31*  
*版本：Claude Code v2.1.88*
