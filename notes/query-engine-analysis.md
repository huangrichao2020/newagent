# QueryEngine.ts 深度学习笔记

**文件位置**: `references/claude-code-sourcemap/restored-src/src/QueryEngine.ts`  
**文件大小**: 46,630 字节 (~1,200 行)  
**重要性**: ⭐⭐⭐⭐⭐ LLM 调用核心引擎

---

## 📐 文件结构

```typescript
QueryEngine.ts
├── 导入和依赖
├── 类型定义
├── QueryEngine 类
│   ├── 构造函数
│   ├── 核心查询方法
│   ├── 流式处理
│   ├── 工具调用循环
│   ├── 思考模式
│   ├── Token 计数
│   └── 错误处理
└── 辅助函数
```

---

## 🔍 核心功能分析

### 1. 类定义和状态管理

```typescript
class QueryEngine {
  // 核心状态
  private messages: Message[];           // 对话历史
  private systemPrompt: string;          // 系统提示词
  private model: string;                 // 模型名称
  private apiClient: AnthropicClient;    // API 客户端
  
  // 执行状态
  private isStreaming: boolean = false;  // 是否正在流式输出
  private currentToolCalls: ToolCall[];  // 当前工具调用
  private tokenUsage: TokenUsage;        // Token 使用统计
  
  // 回调函数
  private onChunk?: (chunk: string) => void;        // 流式输出回调
  private onToolCall?: (tool: ToolCall) => void;    // 工具调用回调
  private onComplete?: (result: Result) => void;    // 完成回调
}
```

**关键洞察**:
- ✅ 状态集中管理
- ✅ 回调机制支持实时更新
- ✅ 流式和非流式统一处理

---

### 2. 核心查询方法

```typescript
async query(params: QueryParams): Promise<QueryResult> {
  const {
    prompt,
    system,
    tools,
    maxTokens,
    temperature,
    onChunk,
    onToolCall,
  } = params;
  
  // 1. 构建消息
  const userMessage: Message = {
    role: 'user',
    content: prompt,
  };
  this.messages.push(userMessage);
  
  // 2. 构建 API 请求
  const requestBody = {
    model: this.model,
    max_tokens: maxTokens,
    messages: this.messages,
    system: system || this.systemPrompt,
    tools: tools || [],
    stream: true,  // 始终使用流式
  };
  
  // 3. 发送请求并处理流式响应
  const result = await this.streamRequest(requestBody);
  
  // 4. 处理工具调用
  if (result.toolCalls.length > 0) {
    await this.handleToolCalls(result.toolCalls, onToolCall);
  }
  
  // 5. 返回结果
  return {
    text: result.text,
    toolCalls: result.toolCalls,
    usage: result.usage,
    stopReason: result.stopReason,
  };
}
```

**关键洞察**:
- ✅ 统一的查询接口
- ✅ 支持工具调用
- ✅ 流式响应处理
- ✅ 自动工具调用循环

---

### 3. 流式响应处理

```typescript
private async streamRequest(
  requestBody: RequestBody
): Promise<StreamResult> {
  this.isStreaming = true;
  
  const result: StreamResult = {
    text: '',
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: null,
  };
  
  try {
    // 创建流式请求
    const stream = await this.apiClient.messages.create({
      ...requestBody,
      stream: true,
    });
    
    // 处理流式事件
    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start':
          // 内容块开始
          if (event.content_block.type === 'text') {
            // 文本块开始
          } else if (event.content_block.type === 'tool_use') {
            // 工具调用块开始
            result.toolCalls.push(event.content_block);
          }
          break;
          
        case 'content_block_delta':
          // 内容增量
          if (event.delta.type === 'text_delta') {
            result.text += event.delta.text;
            
            // 回调通知 UI
            if (this.onChunk) {
              this.onChunk(event.delta.text);
            }
          }
          break;
          
        case 'message_delta':
          // 消息结束
          result.stopReason = event.delta.stop_reason;
          break;
          
        case 'message_stop':
          // 完全结束
          this.isStreaming = false;
          break;
      }
    }
    
  } catch (error) {
    this.isStreaming = false;
    throw this.handleStreamError(error);
  }
  
  return result;
}
```

**关键洞察**:
- ✅ 事件驱动的流式处理
- ✅ 实时回调 UI 更新
- ✅ 完整的错误处理
- ✅ 支持文本和工具调用混合输出

---

### 4. 工具调用循环

```typescript
private async handleToolCalls(
  toolCalls: ToolCall[],
  onToolCall?: (tool: ToolCall) => void
): Promise<void> {
  // 遍历所有工具调用
  for (const toolCall of toolCalls) {
    if (onToolCall) {
      onToolCall(toolCall);  // 通知 UI
    }
    
    // 执行工具
    const toolResult = await this.executeTool(toolCall);
    
    // 将结果添加回对话
    this.messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      }],
    });
    
    this.messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: toolResult.content,
      }],
    });
    
    // 递归查询（继续对话）
    if (toolResult.shouldContinue) {
      await this.query({
        prompt: '',  // 空提示，继续上下文
        tools: this.currentTools,
      });
    }
  }
}
```

**关键洞察**:
- ✅ 自动工具调用循环
- ✅ 工具结果自动添加回对话
- ✅ 支持递归查询
- ✅ 可配置是否继续

---

### 5. 思考模式（Thinking Mode）

```typescript
interface ThinkingConfig {
  enabled: boolean;      // 是否启用思考模式
  verbose: boolean;      // 是否详细展示
  maxThinkingSteps: number;  // 最大思考步数
}

async queryWithThinking(
  params: QueryParams,
  thinkingConfig: ThinkingConfig
): Promise<QueryResult> {
  if (!thinkingConfig.enabled) {
    return this.query(params);
  }
  
  // 1. 先思考
  const thinkingPrompt = `Let me think step by step:
  
Context: ${params.prompt}

Please analyze:
1. What is the user really asking?
2. What tools might be needed?
3. What's the best approach?

Think carefully before responding.`;

  const thinkingResult = await this.query({
    prompt: thinkingPrompt,
    system: 'You are a thoughtful assistant.',
  });
  
  // 2. 展示思考过程（如果配置为详细）
  if (thinkingConfig.verbose && this.onChunk) {
    this.onChunk('🤔 思考过程:\n');
    this.onChunk(thinkingResult.text);
    this.onChunk('\n\n---\n\n回答:\n');
  }
  
  // 3. 基于思考结果生成最终回答
  const finalResult = await this.query({
    prompt: params.prompt,
    tools: params.tools,
  });
  
  return finalResult;
}
```

**关键洞察**:
- ✅ 可选的思考模式
- ✅ 思考过程可视化
- ✅ 分步执行提高质量

---

### 6. Token 计数和成本追踪

```typescript
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

class CostTracker {
  private readonly PRICES = {
    'claude-sonnet-4-20250514': {
      input: 3.0 / 1_000_000,    // $3 per 1M tokens
      output: 15.0 / 1_000_000,  // $15 per 1M tokens
      cache_read: 0.3 / 1_000_000,
      cache_write: 3.75 / 1_000_000,
    },
    // ... 其他模型
  };
  
  calculateCost(usage: TokenUsage, model: string): number {
    const prices = this.PRICES[model as keyof typeof this.PRICES];
    if (!prices) return 0;
    
    return (
      usage.inputTokens * prices.input +
      usage.outputTokens * prices.output +
      (usage.cacheReadTokens || 0) * prices.cache_read +
      (usage.cacheWriteTokens || 0) * prices.cache_write
    );
  }
  
  formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
  }
}
```

**关键洞察**:
- ✅ 详细的 Token 分类
- ✅ 支持缓存 Token
- ✅ 实时成本计算
- ✅ 多模型价格支持

---

### 7. 错误处理

```typescript
private handleStreamError(error: any): QueryError {
  if (error instanceof APIError) {
    return new QueryError({
      code: 'API_ERROR',
      message: error.message,
      retryable: error.status >= 500,  // 5xx 错误可重试
    });
  }
  
  if (error instanceof RateLimitError) {
    return new QueryError({
      code: 'RATE_LIMIT',
      message: 'Rate limit exceeded',
      retryable: true,
      retryAfter: error.retryAfter,
    });
  }
  
  if (error instanceof TimeoutError) {
    return new QueryError({
      code: 'TIMEOUT',
      message: 'Request timed out',
      retryable: true,
    });
  }
  
  // 默认错误
  return new QueryError({
    code: 'UNKNOWN',
    message: error.message || 'Unknown error',
    retryable: false,
  });
}

// 自动重试逻辑
async queryWithRetry(
  params: QueryParams,
  maxRetries: number = 3
): Promise<QueryResult> {
  let lastError: QueryError | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await this.query(params);
    } catch (error) {
      lastError = this.handleStreamError(error);
      
      if (!lastError.retryable) {
        throw lastError;  // 不可重试的错误直接抛出
      }
      
      if (attempt < maxRetries) {
        // 指数退避
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await this.sleep(delay);
      }
    }
  }
  
  throw lastError;
}
```

**关键洞察**:
- ✅ 分类错误处理
- ✅ 可重试错误自动重试
- ✅ 指数退避策略
- ✅ 清晰的错误码

---

## 🎯 设计模式总结

### 1. 策略模式
不同的处理策略（流式/非流式、思考模式/普通模式）可以切换。

### 2. 观察者模式
通过回调函数 (`onChunk`, `onToolCall`, `onComplete`) 通知 UI。

### 3. 责任链模式
工具调用 → 执行 → 结果 → 递归查询，形成处理链。

### 4. 工厂模式
错误处理中根据错误类型创建不同的错误对象。

---

## 💡 对新一代 Agent 外壳的启发

### 1. 核心引擎设计
```typescript
class AgentEngine {
  async execute(task: Task): Promise<Result> {
    // 1. 理解任务
    const understanding = await this.understand(task);
    
    // 2. 规划步骤
    const plan = await this.plan(understanding);
    
    // 3. 执行步骤（可能包含工具调用）
    const result = await this.executePlan(plan);
    
    // 4. 验证结果
    const validated = await this.validate(result);
    
    return validated;
  }
}
```

### 2. 流式输出
实时展示思考和执行过程，建立用户信任。

### 3. 工具调用循环
自动化工具调用，支持多轮对话。

### 4. 成本透明
实时显示 Token 使用和成本。

---

## 📝 待深入研究

- [ ] 完整的消息格式定义
- [ ] 工具调用的详细流程
- [ ] 缓存机制实现
- [ ] 与 services 层的交互

---

*下次更新：分析 Tool.ts*
