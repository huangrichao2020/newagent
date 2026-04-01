# Tool.ts 深度学习笔记

**文件位置**: `references/claude-code-sourcemap/restored-src/src/Tool.ts`  
**文件大小**: 29,516 字节 (~800 行)  
**重要性**: ⭐⭐⭐⭐⭐ 工具类型定义和权限模型

---

## 📐 核心接口定义

### 1. Tool 基础接口

```typescript
interface Tool {
  // 基本信息
  readonly name: string;           // 工具名称（唯一标识）
  readonly description: string;    // 工具描述
  readonly inputSchema: ZodSchema; // 输入参数 Schema（Zod 验证）
  
  // 权限控制
  readonly permissions: PermissionModel;
  readonly requiresApproval: boolean;
  
  // 执行方法
  execute(
    input: z.infer<this['inputSchema']>,
    context: ExecutionContext
  ): Promise<ToolResult>;
  
  // 可选方法
  validate?(input: any): ValidationResult;
  getDescription?(): string;
  getExamples?(): ToolExample[];
}
```

**关键洞察**:
- ✅ 使用 Zod 进行类型安全的参数验证
- ✅ 权限模型内置
- ✅ 统一的执行接口

---

### 2. 权限模型

```typescript
enum PermissionLevel {
  DANGEROUS = 'dangerous',    // 危险操作（删除文件、执行命令）
  SENSITIVE = 'sensitive',    // 敏感操作（读取文件、网络请求）
  SAFE = 'safe',              // 安全操作（搜索、列出文件）
}

interface PermissionModel {
  level: PermissionLevel;     // 权限级别
  scopes?: string[];          // 作用域（如允许的文件路径）
  maxInvocations?: number;    // 最大调用次数
  timeout?: number;           // 超时时间（毫秒）
}

// 权限检查流程
async function checkPermission(
  tool: Tool,
  input: any,
  context: ExecutionContext,
  mode: PermissionMode
): Promise<PermissionResult> {
  const { level, scopes, maxInvocations } = tool.permissions;
  
  // 1. 检查调用次数
  if (maxInvocations) {
    const count = await getInvocationCount(tool.name);
    if (count >= maxInvocations) {
      return {
        granted: false,
        reason: `Maximum invocations (${maxInvocations}) exceeded`,
      };
    }
  }
  
  // 2. 检查作用域
  if (scopes) {
    const inScope = await checkScopes(input, scopes);
    if (!inScope) {
      return {
        granted: false,
        reason: 'Operation out of permitted scope',
      };
    }
  }
  
  // 3. 根据模式决定
  switch (mode) {
    case 'bypass':
      return { granted: true };
      
    case 'plan':
      if (level === PermissionLevel.SAFE) {
        return { granted: true };
      }
      break;
      
    case 'auto':
      const trust = await calculateTrust(tool, input, context);
      if (trust > THRESHOLD) {
        return { granted: true };
      }
      break;
  }
  
  // 4. 需要用户批准
  return {
    granted: false,
    requiresApproval: true,
    approvalPrompt: buildApprovalPrompt(tool, input),
  };
}
```

**关键洞察**:
- ✅ 三级权限分类
- ✅ 作用域限制
- ✅ 调用次数限制
- ✅ 多种权限模式
- ✅ 信任度计算

---

### 3. 执行上下文

```typescript
interface ExecutionContext {
  // 会话信息
  sessionId: string;
  userId: string;
  conversationId: string;
  
  // 环境信息
  cwd: string;              // 当前工作目录
  shell: string;            // Shell 类型
  os: string;               // 操作系统
  
  // 项目信息
  gitRepo?: GitInfo;
  dependencies?: PackageInfo[];
  
  // 状态
  currentTask?: Task;
  openFiles?: Set<string>;
  recentChanges?: FileChange[];
  
  // 权限
  permissionMode: PermissionMode;
  
  // 工具
  abortSignal?: AbortSignal;
  progressCallback?: (progress: number) => void;
}
```

**关键洞察**:
- ✅ 完整的上下文信息
- ✅ 支持取消操作
- ✅ 进度回调

---

## 🔧 具体工具实现分析

### 1. BashTool（命令执行）

```typescript
class BashTool implements Tool {
  readonly name = 'bash';
  readonly description = 'Execute a bash command';
  
  readonly inputSchema = z.object({
    command: z.string().describe('The bash command to execute'),
    timeout: z.number().optional().describe('Timeout in seconds'),
  });
  
  readonly permissions = {
    level: PermissionLevel.DANGEROUS,
    scopes: ['allowed_commands'],  // 只允许特定命令
    maxInvocations: 100,
    timeout: 300000,  // 5 分钟
  };
  
  async execute(
    input: z.infer<typeof this.inputSchema>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const { command, timeout } = input;
    
    // 1. 权限检查
    const permission = await checkPermission(this, input, context);
    if (!permission.granted) {
      if (permission.requiresApproval) {
        return {
          success: false,
          requiresApproval: true,
          approvalPrompt: `Execute command: ${command}`,
        };
      }
      return { success: false, error: permission.reason };
    }
    
    // 2. 命令白名单检查
    const allowed = await this.checkCommandAllowlist(command);
    if (!allowed) {
      return {
        success: false,
        error: 'Command not in allowlist',
      };
    }
    
    // 3. 执行命令
    try {
      const result = await execAsync(command, {
        cwd: context.cwd,
        timeout: timeout || this.permissions.timeout,
        signal: context.abortSignal,
      });
      
      return {
        success: true,
        output: result.stdout,
        error: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
  
  private async checkCommandAllowlist(command: string): Promise<boolean> {
    // 解析命令
    const baseCommand = command.split(' ')[0];
    
    // 危险命令黑名单
    const dangerous = [
      'rm -rf /',
      'dd if=/dev/zero',
      'mkfs',
      'chmod -R 777',
      // ... 更多危险命令
    ];
    
    if (dangerous.some(cmd => command.includes(cmd))) {
      return false;
    }
    
    // 允许的命令白名单
    const allowed = [
      'ls', 'cat', 'grep', 'find',
      'git', 'npm', 'yarn', 'pnpm',
      // ... 更多安全命令
    ];
    
    return allowed.includes(baseCommand);
  }
}
```

**关键洞察**:
- ✅ 命令白名单/黑名单
- ✅ 超时控制
- ✅ 取消支持
- ✅ 详细的错误信息

---

### 2. FileReadTool（文件读取）

```typescript
class FileReadTool implements Tool {
  readonly name = 'file_read';
  readonly description = 'Read the contents of a file';
  
  readonly inputSchema = z.object({
    path: z.string().describe('Path to the file to read'),
    encoding: z.enum(['utf-8', 'binary']).optional().default('utf-8'),
  });
  
  readonly permissions = {
    level: PermissionLevel.SENSITIVE,
    scopes: ['allowed_paths'],
    maxInvocations: 500,
  };
  
  async execute(
    input: z.infer<typeof this.inputSchema>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const { path, encoding } = input;
    
    // 1. 路径安全检查
    const resolvedPath = await this.resolvePath(path, context.cwd);
    const isAllowed = await this.checkPathAllowed(resolvedPath);
    
    if (!isAllowed) {
      return {
        success: false,
        error: 'Path not in allowed scopes',
      };
    }
    
    // 2. 检查文件是否存在
    try {
      await fs.access(resolvedPath);
    } catch {
      return {
        success: false,
        error: `File not found: ${resolvedPath}`,
      };
    }
    
    // 3. 检查文件大小
    const stats = await fs.stat(resolvedPath);
    if (stats.size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `File too large (${stats.size} bytes)`,
        maxSize: MAX_FILE_SIZE,
      };
    }
    
    // 4. 读取文件
    try {
      const content = await fs.readFile(resolvedPath, encoding);
      
      // 5. 检测文件类型
      const fileType = await this.detectFileType(resolvedPath, content);
      
      return {
        success: true,
        content: content.toString(),
        metadata: {
          path: resolvedPath,
          size: stats.size,
          type: fileType,
          modified: stats.mtime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
  
  private async resolvePath(path: string, cwd: string): Promise<string> {
    // 解析相对路径
    const resolved = pathLib.resolve(cwd, path);
    
    // 防止目录遍历攻击
    if (!resolved.startsWith(cwd)) {
      throw new Error('Path traversal detected');
    }
    
    return resolved;
  }
  
  private async checkPathAllowed(path: string): Promise<boolean> {
    // 检查是否在允许的路径范围内
    const allowedScopes = [
      context.cwd,  // 当前工作目录
      // ... 其他允许的路径
    ];
    
    return allowedScopes.some(scope => path.startsWith(scope));
  }
}
```

**关键洞察**:
- ✅ 路径遍历攻击防护
- ✅ 文件大小限制
- ✅ 文件类型检测
- ✅ 作用域检查

---

### 3. FileEditTool（文件编辑）

```typescript
class FileEditTool implements Tool {
  readonly name = 'file_edit';
  readonly description = 'Edit a file by replacing a string';
  
  readonly inputSchema = z.object({
    path: z.string().describe('Path to the file to edit'),
    oldString: z.string().describe('String to replace'),
    newString: z.string().describe('Replacement string'),
    expectedReplacements: z.number().optional().describe(
      'Expected number of replacements (default: 1)'
    ),
  });
  
  readonly permissions = {
    level: PermissionLevel.DANGEROUS,
    scopes: ['allowed_paths'],
    maxInvocations: 200,
  };
  
  async execute(
    input: z.infer<typeof this.inputSchema>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const { path, oldString, newString, expectedReplacements = 1 } = input;
    
    // 1. 读取文件
    const readResult = await new FileReadTool().execute(
      { path, encoding: 'utf-8' },
      context
    );
    
    if (!readResult.success) {
      return readResult;
    }
    
    const content = readResult.content as string;
    
    // 2. 查找匹配
    const matches = findAllMatches(content, oldString);
    
    if (matches.length === 0) {
      return {
        success: false,
        error: 'String not found in file',
        suggestions: await this.findSimilarStrings(content, oldString),
      };
    }
    
    if (matches.length !== expectedReplacements) {
      return {
        success: false,
        error: `Found ${matches.length} occurrences, expected ${expectedReplacements}`,
        occurrences: matches.map(m => ({
          line: m.line,
          column: m.column,
          snippet: m.snippet,
        })),
      };
    }
    
    // 3. 生成 diff
    const newContent = content.replace(oldString, newString);
    const diff = generateDiff(content, newContent);
    
    // 4. 用户确认（危险操作）
    if (context.permissionMode !== 'bypass') {
      return {
        success: false,
        requiresApproval: true,
        approvalPrompt: buildApprovalPrompt(diff),
        diff: diff,
      };
    }
    
    // 5. 写入文件
    try {
      await fs.writeFile(path, newContent, 'utf-8');
      
      return {
        success: true,
        replacements: matches.length,
        diff: diff,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
```

**关键洞察**:
- ✅ 精确匹配验证
- ✅ 多匹配处理
- ✅ Diff 生成
- ✅ 用户确认机制

---

## 🎯 工具注册系统

```typescript
// tools.ts - 工具注册表
const toolRegistry = new Map<string, Tool>();

function registerTool(tool: Tool): void {
  if (toolRegistry.has(tool.name)) {
    throw new Error(`Tool '${tool.name}' already registered`);
  }
  toolRegistry.set(tool.name, tool);
}

// 注册所有内置工具
function registerBuiltInTools(): void {
  registerTool(new BashTool());
  registerTool(new FileReadTool());
  registerTool(new FileWriteTool());
  registerTool(new FileEditTool());
  registerTool(new GlobTool());
  registerTool(new GrepTool());
  registerTool(new WebFetchTool());
  registerTool(new WebSearchTool());
  registerTool(new AgentTool());
  registerTool(new SkillTool());
  registerTool(new MCPTool());
  // ... 更多工具
}

// 获取工具
function getTool(name: string): Tool | undefined {
  return toolRegistry.get(name);
}

// 列出所有工具
function listTools(): Tool[] {
  return Array.from(toolRegistry.values());
}

// 工具搜索（延迟发现）
async function searchTools(query: string): Promise<Tool[]> {
  const allTools = listTools();
  const scores = await Promise.all(
    allTools.map(async tool => ({
      tool,
      score: await calculateRelevanceScore(tool, query),
    }))
  );
  
  return scores
    .filter(s => s.score > THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .map(s => s.tool);
}
```

**关键洞察**:
- ✅ 集中注册管理
- ✅ 工具搜索功能
- ✅ 延迟发现机制

---

## 💡 对新一代 Agent 外壳的启发

### 1. 工具定义模板

```typescript
abstract class BaseTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: ZodSchema;
  abstract readonly permissions: PermissionModel;
  
  abstract execute(input: any, context: ExecutionContext): Promise<ToolResult>;
  
  // 通用方法
  async validate(input: any): Promise<ValidationResult> {
    return this.inputSchema.safeParse(input);
  }
  
  getDescription(): string {
    return this.description;
  }
  
  getExamples(): ToolExample[] {
    return [];
  }
}
```

### 2. 权限分级

| 级别 | 示例 | 处理方式 |
|------|------|----------|
| DANGEROUS | 执行命令、删除文件 | 必须用户批准 |
| SENSITIVE | 读取文件、网络请求 | 计划模式自动 |
| SAFE | 搜索、列出文件 | 自动批准 |

### 3. 安全机制

- ✅ 命令白名单/黑名单
- ✅ 路径遍历防护
- ✅ 文件大小限制
- ✅ 调用次数限制
- ✅ 超时控制
- ✅ 取消支持

### 4. 用户体验

- ✅ 清晰的错误信息
- ✅ 匹配建议
- ✅ Diff 预览
- ✅ 进度回调

---

## 📝 待深入研究

- [ ] 完整的工具列表和分类
- [ ] MCP 工具集成
- [ ] 技能系统实现
- [ ] 工具组合优化

---

*下次更新：分析 commands.ts 和权限系统*
