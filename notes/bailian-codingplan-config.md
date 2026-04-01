# 配置百炼 CodingPlan 指南

**研究日期**: 2026-03-31  
**来源**: claude-code-minimax 项目  
**目标**: 将 claude-code 配置为使用阿里云百炼 CodingPlan API

---

## 📋 背景

claude-code-minimax 项目通过修改跳过了 Claude 的预检登录验证，支持使用任何兼容 Anthropic API 格式的第三方大模型 API。

---

## 🎯 百炼 CodingPlan API

阿里云百炼的 CodingPlan 是一个代码生成和分析模型，理论上可以通过兼容层接入 claude-code。

### API 信息

| 项目 | 值 |
|------|------|
| API 提供商 | 阿里云百炼 |
| API 端点 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 认证方式 | Bearer Token (API Key) |
| 兼容格式 | OpenAI / Anthropic |

---

## ⚙️ 配置方法

### 方法 1: 环境变量（推荐）

```bash
# 设置环境变量
export ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export ANTHROPIC_API_KEY=sk-your-api-key-here
export ANTHROPIC_MODEL=codingplan

# 启动 claude-code
cd ~/Desktop/研究新一代\ agent\ 外壳/references/claude-code-minimax
bun run dev
```

### 方法 2: 一行命令

```bash
ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
ANTHROPIC_API_KEY=sk-your-api-key-here \
ANTHROPIC_MODEL=codingplan \
bun run dev
```

---

## 🔑 获取 API Key

1. 登录阿里云百炼控制台：https://bailian.console.aliyun.com/
2. 进入 API 管理页面
3. 创建或获取 API Key
4. 确保开通了 CodingPlan 模型服务

---

## 🧪 测试连接

### 测试脚本

```bash
# 创建测试文件
cat > test-api.sh << 'EOF'
#!/bin/bash

API_KEY="sk-your-api-key-here"
BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"

# 测试 API 连接
curl -X POST "$BASE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "codingplan",
    "messages": [
      {
        "role": "user",
        "content": "Hello, test connection"
      }
    ],
    "max_tokens": 100
  }'

echo ""
EOF

chmod +x test-api.sh
./test-api.sh
```

### 预期响应

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "codingplan",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

---

## 🔧 可能需要的适配修改

### 1. 检查 API 兼容性

百炼 API 需要兼容 Anthropic 格式。如果不兼容，可能需要添加适配层。

检查位置：`src/services/api/claude.ts`

### 2. 修改系统提示词

某些模型可能需要特定的系统提示词格式。

检查位置：`src/constants/system.ts`

### 3. 调整 Token 计数

不同模型的 Token 计算方式可能不同。

检查位置：`src/utils/tokens.ts`

---

## 📝 配置文件（可选）

创建 `.env` 文件在项目根目录：

```bash
# .env
ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ANTHROPIC_API_KEY=sk-your-api-key-here
ANTHROPIC_MODEL=codingplan

# 可选：调试模式
DEBUG=true
LOG_LEVEL=debug
```

---

## 🐛 故障排查

### 问题 1: 认证失败

**症状**: `401 Unauthorized`

**解决**:
- 检查 API Key 是否正确
- 确认 API Key 有足够权限
- 检查是否开通了 CodingPlan 服务

### 问题 2: 模型不存在

**症状**: `404 Model not found`

**解决**:
- 检查模型名称是否正确
- 确认模型在您的区域可用
- 联系阿里云支持

### 问题 3: 格式不兼容

**症状**: API 返回格式错误

**解决**:
- 检查 API 是否真的兼容 Anthropic 格式
- 可能需要添加适配层
- 考虑使用 OpenAI 兼容模式

---

## 💡 进阶配置

### 使用代理

```bash
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080
```

### 自定义超时

```bash
export API_TIMEOUT=60000  # 60 秒
```

### 启用调试日志

```bash
export DEBUG=true
export LOG_LEVEL=debug
```

---

## 📚 参考资料

- [claude-code-minimax 项目](https://github.com/huangrichao2020/claude-code-minimax)
- [阿里云百炼文档](https://help.aliyun.com/zh/model-studio/)
- [CodingPlan API 文档](https://help.aliyun.com/zh/model-studio/developer-reference/codingplan)

---

## ⚠️ 注意事项

1. **API 费用**: 使用百炼 API 会产生费用，请注意用量
2. **速率限制**: 不同 API Key 有不同的速率限制
3. **数据隐私**: 注意代码和数据的隐私保护
4. **兼容性**: 百炼 API 可能不完全兼容 Anthropic 格式

---

*最后更新：2026-03-31*  
*状态：待测试验证*
