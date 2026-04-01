# Claude Code 深度研究综合笔记

**研究日期**: 2026-03-31  
**资料来源**: claude-code-deep-dive (1,091 行完整报告)  
**核心判断**: Claude Code 是 Agent Operating System，不是简单 CLI 包装器

---

## 🎯 核心洞见

### 一句话总结

> Claude Code 的价值，不是一段 prompt，而是一整套把 prompt、tool、permission、agent、skill、plugin、hook、MCP、cache 和产品体验统一起来的 **Agent Operating System**。

### 护城河分析

Claude Code 的真正秘密在于**制度化好习惯**，而不是依赖模型即兴发挥：

| 领域 | 普通 Agent | Claude Code |
|------|------------|-------------|
| **Prompt** | 静态文本 | 模块化 runtime assembly |
| **Tool** | 直接调用 | permission/hook/analytics pipeline |
| **Agent** | 万能 worker | 多角色分工系统 |
| **Skill** | 说明文档 | prompt-native workflow package |
| **Plugin** | 外挂扩展 | prompt+metadata+constraint 扩展机制 |
| **MCP** | 工具桥 | 工具 + 行为说明 injection plane |

---

## 📐 架构全景

### 核心模块

```
src/
├── entrypoints/        # CLI / init / MCP / SDK
├── constants/          # prompt.ts (主系统提示词)
├── tools/              # 40+ 工具实现
├── services/           # tools/mcp/analytics
├── utils/              # 底层能力
├── commands/           # 50+ slash 命令
├── components/         # 140+ TUI 组件
├── coordinator/        # 多 agent 协调
├── memdir/             # 记忆系统
├── plugins/            # 插件生态
├── hooks/              # Hook 系统
├── bootstrap/          # 状态初始化
└── tasks/              # 任务管理
```

### 入口层设计

```typescript
src/entrypoints/
├── cli.tsx             # 本地 CLI
├── init.ts             # 初始化流程
├── mcp.ts              # MCP 模式
└── sdk/                # SDK 消费者
```

**关键洞察**: 同一个 agent runtime，服务多个入口和交互表面。

---

## 📝 Prompt 架构

### 系统提示词总装 (`prompts.ts`)

```typescript
getSystemPrompt() {
  // 静态前缀（适合 cache）
  const staticPrefix = [
    getSimpleIntroSection(),        // 身份定义
    getSimpleSystemSection(),       // runtime reality
    getSimpleDoingTasksSection(),   // 行为哲学
    getActionsSection(),            // 风险规范
    getUsingYourToolsSection(),     // 工具使用规范
    getSimpleToneAndStyleSection(), // 交互风格
    getOutputEfficiencySection(),   // 输出效率
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

### 关键 Section 分析

#### 1. 行为哲学 (`getSimpleDoingTasksSection()`)

这是 Claude Code 行为稳定性的核心：

- ❌ 不要加用户没要求的功能
- ❌ 不要过度抽象
- ❌ 不要瞎重构
- ❌ 不要乱加 comments/docstrings
- ❌ 不要做不必要的 error handling
- ❌ 不要设计 future-proof abstraction
- ✅ 先读代码再改代码
- ✅ 不要轻易创建新文件
- ✅ 结果要如实汇报

**价值**: 制度化工程规范，防止行为漂移。

#### 2. 工具使用规范 (`getUsingYourToolsSection()`)

```
读文件 → 优先 FileRead，不要 cat/head/tail/sed
改文件 → 优先 FileEdit，不要 sed/awk
新建文件 → 优先 FileWrite，不要 echo 重定向
搜文件 → 优先 Glob
搜内容 → 优先 Grep
Bash → 只保留给真正需要 shell 的场景
```

**价值**: 定义正确的 tool usage grammar。

#### 3. 风险动作规范 (`getActionsSection()`)

需要确认的风险动作：
- destructive operations
- hard-to-reverse operations
- 修改共享状态
- 对外可见动作

**价值**: blast radius 思维编码进 system prompt。

### Prompt Cache Boundary

```typescript
SYSTEM_PROMPT_DYNAMIC_BOUNDARY

// 边界前：静态内容，可 cache
// 边界后：用户/会话特定内容
```

**关键洞察**: Claude Code 在做 **Prompt assembly with cache economics**，连 token 成本与缓存命中都工程化优化了。

---

## 🤖 Agent 系统

### 内建 Agents 分工

| Agent | 职责 | 限制 |
|-------|------|------|
| **General Purpose** | 通用任务 | - |
| **Explore** | 代码探索 | 只读，不准修改 |
| **Plan** | 架构规划 | 只读，不准执行 |
| **Verification** | 验证测试 | 必须 adversarial |
| **Guide** | 使用指导 | - |
| **Statusline Setup** | 环境配置 | - |

### Explore Agent（只读专家）

```typescript
// 绝对禁止
- 不能创建/修改/删除/移动文件
- 不能写临时文件
- 不能用重定向/heredoc 写文件

// 允许的操作
- Glob / Grep / FileRead
- Bash 只读命令：ls, git status, git log, cat, head, tail
- 尽量并行用工具
```

### Plan Agent（架构师）

```typescript
// 职责
- 只读，不准改文件
- 理解需求
- 探索代码库、模式、架构
- 输出 step-by-step implementation plan
- 列出 Critical Files for Implementation
```

### Verification Agent（对抗性验证）

这是最值钱的 Agent 设计：

```typescript
// 核心定位：try to break it
// 两类失败模式：
// 1. verification avoidance：只看代码、不跑检查、写 PASS 就走
// 2. 被前 80% 迷惑：UI 看起来还行、测试也过了，就忽略最后 20% 的问题

// 强制验证步骤
- build
- test suite
- linter / type-check
- 根据变更类型做专项验证
- frontend：浏览器自动化验证
- backend：curl/fetch 实测
- CLI：检查 stdout/stderr/exit code
- migration：测 up/down 和已有数据
- refactor：测 public API surface
- 必须做 adversarial probes
- 每个 check 必须带 command 和 output observed

// 最终输出
VERDICT: PASS / FAIL / PARTIAL
```

**价值**: 对抗 LLM 常见的"差不多就算了"心态。

---

## 🔗 Agent 调度链

### 完整调用链

```
用户请求
    ↓
主模型决定调用 Agent 工具
    ↓
AgentTool.call() 解析输入
    ↓
判断：teammate / fork / built-in / background / worktree / remote
    ↓
选择 agent definition
    ↓
构造 prompt messages
    ↓
构造/继承 system prompt
    ↓
组装工具池
    ↓
创建 agent-specific ToolUseContext
    ↓
注册 hooks / skills / MCP servers
    ↓
runAgent()
    ↓
query() ← 真正的模型对话循环
    ↓
记录 transcript、处理 lifecycle、清理资源
    ↓
返回结果
```

### Fork Path vs Normal Path

| 特性 | Fork Path | Normal Path |
|------|-----------|-------------|
| **system prompt** | 继承父线程 | 基于 agentDefinition 生成 |
| **context** | 完整继承 | 只给所需上下文 |
| **tools** | 尽量一致（cache 命中） | 按 agent 过滤 |
| **cache** | byte-identical prefix | 新 cache |
| **用途** | 研究任务、中间输出多 | 专职 agent |

**关键洞察**: Fork 不是"再开一个普通 agent"，而是**为了 cache 和 context 继承专门优化过的执行路径**。

### Background vs Foreground

```typescript
// Background Agent
- 独立 abort controller
- 后台运行
- 完成后 notification 回到主线程
- 可选自动 summarization
- 不鼓励偷看输出文件

// Foreground Agent
- 主线程等待结果
- 可被 background 化
- progress tracking
```

---

## 🛠️ 工具执行链

### 完整 Pipeline

```
1. 找 tool
2. 解析 MCP metadata
3. 输入 schema 校验
4. validateInput
5. Bash speculative classifier check
6. PreToolUse hooks
7. 解析 hook permission result
8. 权限决策
9. 根据 updatedInput 修正输入
10. 真正执行 tool.call()
11. 记录 analytics / tracing / OTel
12. PostToolUse hooks
13. 处理 structured output / tool_result
14. 失败 → PostToolUseFailure hooks
```

### Hook 系统

```typescript
// Hook 类型
- PreToolUse
- PostToolUse
- PostToolUseFailure

// Hook 可以返回
- message
- blockingError
- updatedInput
- permissionBehavior (allow/ask/deny)
- preventContinuation
- stopReason
- additionalContexts
- updatedMCPToolOutput
```

**关键洞察**: Hook 是 **runtime policy layer**，不是简单的日志记录。

### 权限决策耦合

```typescript
resolveHookPermissionDecision() {
  // hook allow 不一定绕过 settings 规则
  // 如果需要 user interaction，仍要走统一 permission flow
  // hook 的权限语义被严格嵌进总权限模型
}
```

---

## 🌿 生态系统

### Skill：Workflow Package

```yaml
# Skill 本质
- markdown prompt bundle
- frontmatter metadata
- 可声明 allowed-tools
- 可按需注入上下文
- 可复用工作流压缩

# 使用规则
- task 匹配 skill 时必须调用 Skill tool
- 不能只提 skill 不执行
- slash command 视为 skill 入口
```

### Plugin：扩展机制

```typescript
// 插件能提供的能力
- markdown commands
- SKILL.md skill 目录
- commandsMetadata
- userConfig
- shell frontmatter
- allowed-tools
- model / effort hints
- runtime 变量替换 (${CLAUDE_PLUGIN_ROOT} 等)
```

### MCP：行为说明注入

```typescript
// MCP 同时注入
1. 新工具
2. 如何使用这些工具的说明 (getMcpInstructionsSection)

// 这让 MCP 的价值远高于简单 tool registry
```

---

## 💡 核心设计思想

### 1. 制度化好习惯

> 不把"好习惯"交给模型即兴发挥，而是写进 prompt 和 runtime 规则里。

### 2. 上下文是稀缺资源

所有设计围绕上下文优化：
- system prompt 动静边界
- prompt cache boundary
- fork path 共享 cache
- skill 按需注入
- function result clearing

### 3. Agent 专业化分工

> 研究和探索不用污染主线程，规划和实现分离，验证独立出来对抗"实现者 bias"。

### 4. 生态模型可感知

通过 skills 列表、agent 列表、MCP instructions，让模型**知道自己的扩展能力是什么**。

---

## 📊 关键文件索引

### Prompt 核心

| 文件 | 说明 |
|------|------|
| `src/constants/prompts.ts` | 主系统提示词 |
| `src/tools/AgentTool/prompt.ts` | Agent 协议 |
| `src/tools/SkillTool/prompt.ts` | Skill 协议 |

### Agent 核心

| 文件 | 说明 |
|------|------|
| `src/tools/AgentTool/AgentTool.tsx` | 调度总控 |
| `src/tools/AgentTool/runAgent.ts` | 子 agent runtime |
| `src/tools/AgentTool/built-in/exploreAgent.ts` | Explore |
| `src/tools/AgentTool/built-in/planAgent.ts` | Plan |
| `src/tools/AgentTool/built-in/verificationAgent.ts` | Verification |

### 工具执行核心

| 文件 | 说明 |
|------|------|
| `src/services/tools/toolExecution.ts` | 执行 pipeline |
| `src/services/tools/toolHooks.ts` | Hook 系统 |

---

## 🎯 对新一代 Agent 外壳的启发

### 1. 架构设计

```
用户界面
    ↓
Prompt Assembly (动态拼装)
    ↓
Agent Orchestrator (多角色分工)
    ↓
Tool Runtime (permission/hook/analytics)
    ↓
执行层
```

### 2. Prompt 工程

- 模块化 section，不是 monolithic 文本
- 动静分离，优化 cache
- 运行时注入，不是静态配置

### 3. Agent 设计

- 专业化分工（Explore/Plan/Verification）
- Fork 语义（cache 继承）
- Background/Foreground 生命周期

### 4. 工具系统

- 完整执行 pipeline
- Hook 作为 policy layer
- 权限模型嵌入

### 5. 生态系统

- Skill = workflow package
- Plugin = prompt+metadata+constraint
- MCP = 工具 + 行为说明

---

## 📝 待深入研究

- [ ] `query.ts` - 主会话循环
- [ ] `resumeAgent.ts` - agent 恢复机制
- [ ] `loadSkillsDir` - skills 完整加载链
- [ ] `pluginLoader` - 插件加载细节
- [ ] `coordinator/*` - 多 agent 协调器

---

*最后更新：2026-03-31*  
*参考资料：claude-code-deep-dive (1,091 行完整报告)*
