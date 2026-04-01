# Claude Code Snap 深度学习笔记

**研究日期**: 2026-03-31  
**来源**: https://github.com/huangrichao2020/claude-code-snap  
**代码规模**: ~1,900 文件，512,000+ 行代码

---

## 🎯 核心发现

Claude Code 是一个**生产级 Agent CLI 系统**，其架构设计有很多值得学习的地方。

---

## 📐 架构设计思想

### 1. 分层架构

```
用户输入
    ↓
[CLI 层] commands.ts — 解析 slash 命令
    ↓
[协调层] QueryEngine.ts — LLM 调用核心引擎
    ↓
[工具层] tools/ — 40+ 个独立工具模块
    ↓
[服务层] services/ — 外部服务集成
    ↓
[执行层] Bash/File/Git 等操作
```

**关键洞察**: 每一层职责清晰，工具独立可测试。

---

### 2. 工具系统设计

每个工具都是独立模块：

```typescript
// Tool.ts 定义基础接口
interface Tool {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  permissions: PermissionModel;
  execute: (input: any, context: Context) => Promise<Result>;
}

// 示例：FileReadTool
class FileReadTool implements Tool {
  name = 'file_read';
  inputSchema = z.object({ path: z.string() });
  
  async execute(input, context) {
    // 1. 权限检查
    await this.checkPermission(input.path);
    
    // 2. 执行读取
    const content = await fs.readFile(input.path);
    
    // 3. 返回结果
    return { success: true, content };
  }
}
```

**关键洞察**:
- ✅ 工具 = Schema + 权限 + 执行逻辑
- ✅ 每个工具独立可测试
- ✅ 权限系统内置

---

### 3. 权限系统

```typescript
// src/hooks/toolPermission/
enum PermissionMode {
  DEFAULT = 'default',      // 每次询问
  PLAN = 'plan',            // 计划模式自动批准
  BYPASS = 'bypass',        // 绕过权限
  AUTO = 'auto'             // 根据信任度自动
}

// 权限检查流程
async function checkPermission(tool, input, context) {
  const mode = context.permissionMode;
  
  if (mode === 'auto') {
    const trust = await calculateTrust(tool, input);
    if (trust > THRESHOLD) return APPROVED;
  }
  
  if (mode === 'plan') {
    if (isSafeOperation(tool)) return APPROVED;
  }
  
  // 否则询问用户
  return await promptUser(tool, input);
}
```

**关键洞察**: 权限不是简单的允许/拒绝，而是有**多级信任模型**。

---

### 4. 上下文管理

```typescript
// src/context.ts
interface Context {
  // 系统上下文
  cwd: string;
  user: string;
  shell: string;
  os: string;
  
  // 会话上下文
  conversationHistory: Message[];
  currentTask: Task | null;
  openFiles: Set<string>;
  
  // 项目上下文
  gitRepo: GitInfo | null;
  dependencies: PackageInfo[];
  recentChanges: FileChange[];
  
  // 记忆
  longTermMemories: Memory[];
  skillMemories: Skill[];
}

// 上下文收集
async function collectContext(): Promise<Context> {
  const [system, session, project, memory] = await Promise.all([
    collectSystemContext(),    // 并行预取
    collectSessionContext(),
    collectProjectContext(),
    collectMemories(),
  ]);
  
  return { ...system, ...session, ...project, memory };
}
```

**关键洞察**: 
- ✅ 上下文分层（系统/会话/项目/记忆）
- ✅ 并行预取优化启动时间
- ✅ 懒加载重上下文

---

### 5. 成本追踪

```typescript
// src/cost-tracker.ts
class CostTracker {
  private tokenUsage: TokenUsage = {
    input: 0,
    output: 0,
    cache: 0,
  };
  
  trackUsage(response: LLMResponse) {
    this.tokenUsage.input += response.usage.inputTokens;
    this.tokenUsage.output += response.usage.outputTokens;
    
    // 实时计算成本
    const cost = this.calculateCost();
    this.notifyUser(cost);
  }
  
  calculateCost(): number {
    const inputCost = this.tokenUsage.input * INPUT_PRICE;
    const outputCost = this.tokenUsage.output * OUTPUT_PRICE;
    return inputCost + outputCost;
  }
}
```

**关键洞察**: **透明度建立信任**，用户随时知道花了多少钱。

---

### 6. 功能标志系统

```typescript
// 使用 Bun 的功能标志进行死代码消除
import { feature } from 'bun:bundle'

const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null

// 不活跃代码在构建时完全剥离
// 减少运行时开销
```

**关键洞察**: 功能标志不仅用于运行时开关，还用于**构建时优化**。

---

### 7. 多代理协调

```typescript
// src/coordinator/
class AgentCoordinator {
  private agents: Map<string, Agent>;
  
  async createSubAgent(task: Task): Promise<Agent> {
    const agent = new Agent({
      parent: this.currentAgent,
      task: task,
      tools: this.selectTools(task),
    });
    
    this.agents.set(agent.id, agent);
    return agent;
  }
  
  async coordinate(): Promise<Result> {
    // 多代理并行工作
    const results = await Promise.all(
      this.agents.values().map(agent => agent.execute())
    );
    
    // 汇总结果
    return this.mergeResults(results);
  }
}
```

**关键洞察**: 子代理可以**并行工作**，协调器负责汇总。

---

## 🎨 UI/UX 设计

### 终端 UI 架构

```
src/components/        # Ink UI 组件 (~140 个)
├── Header.tsx         # 顶部状态栏
├── MessageList.tsx    # 消息列表
├── ToolCall.tsx       # 工具调用展示
├── Progress.tsx       # 进度指示器
├── CostDisplay.tsx    # 成本显示
└── InputPrompt.tsx    # 输入提示
```

**关键洞察**: 使用 **React + Ink** 构建声明式终端 UI，组件可复用。

---

### 透明度展示

```tsx
// 展示思考过程
<ThinkingProcess>
  <Step icon="🔍">分析用户需求...</Step>
  <Step icon="📋">查找相关文件...</Step>
  <Step icon="✏️">开始修改代码...</Step>
  <Step icon="✅">完成！</Step>
</ThinkingProcess>

// 展示工具调用
<ToolCall tool="file_edit">
  <File path="src/app.ts" />
  <Diff old="..." new="..." />
  <Reason>修复类型错误</Reason>
</ToolCall>
```

**关键洞察**: **可视化执行过程**建立用户信任。

---

## 🔑 关键设计模式

### 1. 并行预取模式

```typescript
// main.tsx — 启动时并行预取
startMdmRawRead()      // 读取配置
startKeychainPrefetch() // 预取密钥
preconnectAPI()         // 预连接 API

// 在重模块评估之前开始，减少启动时间
```

**应用**: 启动时并行加载配置、密钥、网络连接。

---

### 2. 懒加载模式

```typescript
// 重模块延迟加载
const OpenTelemetry = await import('@opentelemetry/api');
const gRPC = await import('@grpc/grpc-js');

// 只在需要时加载
```

**应用**: 遥测、gRPC、分析模块懒加载。

---

### 3. 工具发现模式

```typescript
// 延迟工具发现
class ToolSearchTool implements Tool {
  async execute(query: string) {
    // 动态搜索可用工具
    const tools = await this.discoverTools(query);
    return tools;
  }
}
```

**应用**: 当工具数量多时，支持动态发现。

---

### 4. 计划模式

```typescript
// 先进入计划模式，确认后再执行
async function enterPlanMode(task: Task) {
  const plan = await generatePlan(task);
  const approved = await userApprove(plan);
  
  if (approved) {
    await executePlan(plan);
  }
}
```

**应用**: 复杂任务先出计划，用户确认再执行。

---

## 💡 对新一代 Agent 外壳的启发

### 1. 架构设计

| 借鉴点 | 应用方式 |
|--------|----------|
| 分层架构 | 用户界面 → 协调层 → 工具层 → 执行层 |
| 工具独立 | 每个工具 = Schema + 权限 + 执行 |
| 权限分级 | 默认/计划/自动/绕过 多级信任 |

### 2. 用户体验

| 借鉴点 | 应用方式 |
|--------|----------|
| 透明度 | 展示思考过程、决策依据 |
| 成本追踪 | 实时显示 token 使用和成本 |
| 可中断 | 用户随时可以打断执行 |

### 3. 性能优化

| 借鉴点 | 应用方式 |
|--------|----------|
| 并行预取 | 启动时并行加载配置、密钥 |
| 懒加载 | 重模块延迟加载 |
| 功能标志 | 构建时剥离不活跃代码 |

### 4. 记忆系统

| 借鉴点 | 应用方式 |
|--------|----------|
| 分层记忆 | 短期（会话）/长期（跨会话） |
| 自动提取 | 从对话中自动提取记忆 |
| 技能记忆 | 可重用工作流作为记忆 |

---

## 📝 行动计划

### 第一阶段：学习（1 周）
- [ ] 阅读 QueryEngine.ts 核心逻辑
- [ ] 分析 Tool.ts 接口设计
- [ ] 研究权限系统实现

### 第二阶段：原型（2 周）
- [ ] 实现基础工具系统
- [ ] 设计权限模型
- [ ] 构建简单 UI

### 第三阶段：迭代（持续）
- [ ] 用户测试
- [ ] 性能优化
- [ ] 功能扩展

---

## 🔗 关键文件参考

| 文件 | 行数 | 学习重点 |
|------|------|----------|
| `src/QueryEngine.ts` | ~46K | LLM 调用、流式响应、工具循环 |
| `src/Tool.ts` | ~29K | 工具类型定义、权限模型 |
| `src/commands.ts` | ~25K | 命令注册和执行 |
| `src/context.ts` | - | 上下文收集和管理 |
| `src/hooks/toolPermission/` | - | 权限检查逻辑 |

---

*下次更新：详细分析 QueryEngine.ts 核心逻辑*
