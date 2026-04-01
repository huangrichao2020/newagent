# Claude Code 技术文档学习笔记

**学习日期**: 2026-03-31  
**来源**: 
- https://plain-sun-1ffe.hunshcn429.workers.dev/ (技术文档网站)
- claude-code-sourcemap (4,756 源码文件)
- claude-code-deep-dive (1,091 行研究报告)

---

## 📋 网站概览

这是一个关于 **Claude Code (Anthropic 官方 AI 编程助手 CLI 工具)** 的技术文档网站。

**版本**: v2.1.88

**内容覆盖**:
- 完整技术文档
- 开发者入门指南
- 架构设计
- 工具系统
- 安全权限
- 项目规模

---

## 🏗️ 架构概览

### 6 层分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                     CLI Entrypoint (cli.tsx)                  │
│  init() → config → shutdown → remote settings → proxy → LSP │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────▼────────────────┐
              │     REPL Screen (REPL.tsx)   │
              │  App → Provider → StatusLine │
└────────────┬────────────────┘
                           │
         ┌─────────────────▼─────────────────┐
         │       QueryEngine (核心循环)       │
         │  submitMessage() → query() → SDK  │
         └──┬──────────┬──────────┬─────────┘
            │          │          │
     ┌──────▼──┐  ┌────▼────┐  ┌─▼──────────┐
     │ Tools   │  │Commands │  │ Services   │
     │ 45+内置 │  │ 120+命令│  │ API/MCP/   │
     │ +MCP扩展│  │ +技能   │  │ Token/Cost │
     └─────────┘  └─────────┘  └────────────┘
            │          │          │
     ┌──────▼──────────▼──────────▼──────────┐
     │          State Management              │
     │  AppState(50+字段) + ToolPermission   │
     └──────────────────┬────────────────────┘
                        │
         ┌──────────────▼──────────────┐
         │     Bridge (远程通信)        │
         │  轮询 → 消息 → 心跳 → 会话  │
         └─────────────────────────────┘
```

### 核心模块

| 模块 | 说明 |
|------|------|
| **CLI Entrypoint** | init() → config → shutdown → remote settings → proxy → LSP |
| **REPL Screen** | App → Provider → StatusLine |
| **QueryEngine** | submitMessage() → query() → SDK |
| **Tools** | 45+ 内置工具 + MCP 扩展 |
| **Commands** | 120+ 命令 + 技能 |
| **Services** | API/MCP/Token/Cost |
| **State Management** | AppState(50+ 字段) + ToolPermission |
| **Bridge** | 轮询 → 消息 → 心跳 → 会话 |

---

## 🔧 工具系统

### 核心特性

- **45+ 内置工具**
- **AsyncGenerator 流式输出**
- **buildTool 工厂模式**
- **MCP 扩展协议**

### 工具分类

| 类别 | 工具示例 |
|------|----------|
| **文件操作** | FileRead, FileEdit, FileWrite, Glob |
| **代码搜索** | Grep, Glob |
| **命令执行** | Bash |
| **任务管理** | TodoWrite, TaskCreate |
| **Agent 协作** | Agent, Skill, MCPTool |
| **用户交互** | AskUserQuestion |
| **其他** | Sleep, WebFetch, WebSearch |

### 工具执行流程

```
模型决定调用工具
    ↓
输入 Schema 校验 (Zod)
    ↓
validateInput
    ↓
PreToolUse Hooks
    ↓
权限决策 (7 种模式)
    ↓
执行 tool.call()
    ↓
记录 analytics / tracing / OTel
    ↓
PostToolUse Hooks
    ↓
返回 tool_result
```

---

## ⚡ 查询引擎

### 核心特性

- **核心 AI 查询循环**
- **Token 预算管理**
- **4 级重试策略**
- **成本跟踪**

### QueryEngine 职责

```typescript
class QueryEngine {
  // 核心方法
  async query(params: QueryParams): Promise<QueryResult>
  
  // 流式处理
  private async streamRequest(requestBody): Promise<StreamResult>
  
  // 工具调用循环
  private async handleToolCalls(toolCalls, onToolCall): Promise<void>
  
  // 思考模式
  async queryWithThinking(params, thinkingConfig): Promise<QueryResult>
  
  // Token 计数
  trackTokenUsage(usage: TokenUsage): void
  
  // 成本跟踪
  calculateCost(usage, model): number
}
```

### 重试策略

```
Level 1: API 超时 → 指数退避重试
Level 2: Rate Limit → 等待 Retry-After 头
Level 3: Server Error → 最多 3 次重试
Level 4: Network Error → 立即重试
```

---

## 🔒 权限与安全

### 7 种权限模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| **default** | 每次询问用户 | 默认安全模式 |
| **plan** | 计划模式自动批准安全操作 | 规划阶段 |
| **bypass** | 绕过权限检查 | 可信环境 |
| **auto** | 根据信任度自动决定 | 高信任用户 |
| **yolo** | 完全自动 | 测试/演示 |
| **enterprise** | 企业策略控制 | 企业部署 |
| **hook** | Hook 拦截决策 | 自定义治理 |

### 安全机制

```
┌─────────────────────────────────────────────────────────┐
│                    工具调用请求                          │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │   PreToolUse Hook       │
          │   (安全拦截第一道防线)   │
          └────────────┬────────────┘
                       │
          ┌────────────▼────────────┐
          │   YOLO 分类器            │
          │   (风险动作识别)         │
          └────────────┬────────────┘
                       │
          ┌────────────▼────────────┐
          │   权限决策引擎           │
          │   (7 种模式 + 企业策略)   │
          └────────────┬────────────┘
                       │
          ┌────────────▼────────────┐
          │   执行 / 拒绝 / 询问     │
          └─────────────────────────┘
```

### 风险动作分类

- **destructive operations** - 删除、覆盖
- **hard-to-reverse** - 数据库迁移、git rebase
- **修改共享状态** - 全局配置、锁文件
- **对外可见动作** - 发布、部署
- **第三方工具上传** - 外部 API 调用

---

## 🌐 BRIDGE 远程通信

### 核心特性

- **轮询架构**
- **JWT 认证**
- **容量唤醒**
- **BoundedUUIDSet 去重**

### 通信流程

```
本地 CLI                    Bridge Server              远程客户端
    │                           │                          │
    │◄────── 轮询请求 ──────────│                          │
    │                           │                          │
    │─────── 消息 ────────────►│                          │
    │                           │────── 推送 ────────────►│
    │                           │                          │
    │◄────── 心跳 ─────────────│                          │
    │                           │                          │
    │─────── 会话状态 ────────►│                          │
    │                           │                          │
```

### JWT 认证流程

```typescript
// 1. 客户端请求 JWT
const jwt = await requestJWT({
  sessionId,
  capabilities: ['read', 'write'],
});

// 2. Bridge 验证 JWT
const verified = await verifyJWT(jwt, {
  audience: 'claude-code-bridge',
  issuer: 'claude-code-cli',
});

// 3. 建立连接
if (verified) {
  establishConnection(sessionId);
}
```

---

## 🧩 插件与技能

### 5 层扩展体系

```
Level 1: Built-in Tools    (45+ 内置工具)
Level 2: Skills            (Markdown workflow package)
Level 3: Plugins           (prompt + metadata + constraint)
Level 4: MCP Servers       (工具 + 行为说明 injection)
Level 5: Custom Agents     (fork / specialization)
```

### MCP 6 层配置

```
1. Global MCP Config      (~/.claude/mcp.json)
2. Project MCP Config     (.claude/mcp.json)
3. Plugin MCP Config      (plugins/*/mcp.json)
4. Frontmatter MCP        (agent frontmatter)
5. Runtime MCP            (动态添加)
6. Environment MCP        (环境变量注入)
```

### 技能系统

```yaml
# Skill 本质
- markdown prompt bundle
- frontmatter metadata
- allowed-tools 声明
- 上下文注入机制
- 可复用工作流

# 使用规则
- task 匹配 skill 时必须调用 Skill tool
- 不能只提 skill 不执行
- slash command 视为 skill 入口
```

---

## 💻 技术栈

| 技术 | 用途 |
|------|------|
| **TypeScript** | 主要开发语言 |
| **Bun** | 运行时 + 构建工具 + 包管理 |
| **React + Ink** | 终端 UI 渲染框架 |
| **Zod v4** | Schema 验证（工具输入/输出） |
| **MCP** | Model Context Protocol 工具扩展协议 |
| **Zustand-like Store** | 轻量级状态管理 |
| **React Compiler Runtime** | 自动记忆化优化 |
| **Yoga Layout** | Flexbox 终端布局引擎 |

---

## 📊 项目规模

| 类别 | 数量 |
|------|------|
| 源码文件 | 500+ |
| 内置工具 | 45+ |
| 命令 | 120+ |
| UI 组件 | 200+ |
| Hooks | 90+ |
| 工具函数 | 150+ |

---

## 🎯 核心设计思想

### 1. Prompt Assembly Architecture

```typescript
getSystemPrompt() {
  // 静态前缀（适合 cache）
  const staticPrefix = [
    getSimpleIntroSection(),
    getSimpleSystemSection(),
    getSimpleDoingTasksSection(),
    getActionsSection(),
    getUsingYourToolsSection(),
    getSimpleToneAndStyleSection(),
    getOutputEfficiencySection(),
  ];
  
  // 动态后缀（按会话条件注入）
  const dynamicSuffix = [
    sessionGuidance,
    memory,
    envInfo,
    language,
    outputStyle,
    mcpInstructions,
    scratchpad,
    tokenBudget,
  ];
  
  return staticPrefix.join('\n') + '\n' + dynamicSuffix.join('\n');
}
```

**关键洞察**: Claude Code 在做 **Prompt assembly with cache economics**。

### 2. Agent Specialization

| Agent | 职责 | 限制 |
|-------|------|------|
| **Explore** | 代码探索 | 只读，不准修改 |
| **Plan** | 架构规划 | 只读，不准执行 |
| **Verification** | 验证测试 | 必须 adversarial |
| **General Purpose** | 通用任务 | - |

### 3. Tool Runtime Governance

```
工具调用 ≠ 直接执行

完整 Pipeline:
输入校验 → Hook 拦截 → 权限决策 → 执行 → 后处理 → 分析
```

### 4. Ecosystem Model Awareness

通过以下机制让模型**知道自己的扩展能力**：
- skills 列表
- agent 列表
- MCP instructions
- session-specific guidance
- command integration

---

## 💡 对新一代 Agent 外壳的启发

### 架构设计

```typescript
class NextGenAgentShell {
  async execute(task: Task) {
    // 1. Prompt 动态拼装
    const systemPrompt = await this.assemblePrompt(task);
    
    // 2. Agent 调度（可能 fork/Explore/Plan/Verify）
    const agent = await this.selectAgent(task);
    
    // 3. 工具执行（带 permission/hook）
    const result = await this.executeWithGovernance(agent, task);
    
    // 4. 验证（对抗性）
    const verified = await this.adversarialVerify(result);
    
    return verified;
  }
}
```

### 关键借鉴点

| 领域 | Claude Code 做法 | 可借鉴 |
|------|-----------------|--------|
| **Prompt** | 模块化 assembly | 动静分离优化 cache |
| **Tool** | 完整 pipeline | Hook 作为 policy layer |
| **Agent** | 专业化分工 | Explore/Plan/Verify |
| **Permission** | 7 种模式 + Hook | 多级信任模型 |
| **Ecosystem** | 模型可感知扩展 | Skill/Plugin/MCP |

---

## 📝 待深入研究

- [ ] QueryEngine 完整实现细节
- [ ] Tool 执行链 Hook 机制
- [ ] Bridge 轮询架构优化
- [ ] MCP 6 层配置合并逻辑
- [ ] YOLO 分类器实现
- [ ] Token 预算管理机制

---

*最后更新：2026-03-31*  
*版本：Claude Code v2.1.88*
