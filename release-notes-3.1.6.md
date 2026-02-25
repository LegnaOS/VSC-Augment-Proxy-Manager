# Augment Proxy Manager 3.1.6 发布说明

## 🎯 核心改进：完整符合 Anthropic 官方 SSE 规范

基于 Anthropic 官方流式响应文档，本版本实现了完整的 SSE (Server-Sent Events) 格式支持，解决了自定义 API 端点的流式响应解析问题。

---

## ✨ 新增功能

### 1. **完整的 SSE 事件处理**
- ✅ 正确跳过 `event:` 行，只解析 `data:` 行
- ✅ 支持 `message_start` 事件（消息开始）
- ✅ 支持 `message_stop` 事件（消息结束）
- ✅ 支持 `ping` 事件（心跳保活）
- ✅ 支持 `content_block_start` 事件（内容块开始）
- ✅ 支持 `content_block_delta` 事件（内容增量）
- ✅ 支持 `content_block_stop` 事件（内容块结束）
- ✅ 支持 `message_delta` 事件（消息元数据更新）

### 2. **详细的调试日志**
- ✅ 每个 SSE 事件都有对应的日志输出
- ✅ 文本增量显示前 50 个字符预览
- ✅ 工具调用的开始和完成都有日志
- ✅ JSON 解析错误会显示详细信息
- ✅ Stop reason 会被明确记录

### 3. **增强的错误处理**
- ✅ 不再静默吞掉 JSON 解析错误
- ✅ 错误日志包含失败的数据片段（前 100 字符）
- ✅ 更容易诊断流式响应问题

---

## 🐛 修复的问题

### 核心问题
1. **自定义 API 端点返回空响应** ❌ → ✅ 已修复
   - 根因：SSE 格式解析不完整，未处理 `event:` 行
   - 修复：正确跳过 `event:` 行，只解析 `data:` 行

2. **缺少调试信息** ❌ → ✅ 已修复
   - 根因：空的 `catch {}` 块静默吞掉所有错误
   - 修复：添加详细的事件日志和错误日志

3. **未处理标准 SSE 事件** ❌ → ✅ 已修复
   - 根因：只处理了部分事件类型
   - 修复：完整支持所有 Anthropic 官方事件类型

---

## 📊 SSE 事件流程

根据 Anthropic 官方文档，标准的流式响应包含以下事件序列：

```
1. message_start          → 消息开始（包含空的 content）
2. content_block_start    → 内容块开始（可能是 text 或 tool_use）
3. ping (可选)            → 心跳事件
4. content_block_delta    → 内容增量（多次）
   - text_delta           → 文本增量
   - input_json_delta     → 工具参数增量
   - thinking_delta       → 思考过程增量
5. content_block_stop     → 内容块结束
6. message_delta          → 消息元数据更新（包含 stop_reason）
7. message_stop           → 消息结束
```

---

## 🔧 技术细节

### SSE 格式示例

**标准格式**：
```
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}
```

**解析逻辑**：
```typescript
// 跳过 event 行
if (line.startsWith('event:')) continue;

// 只处理 data 行
if (!line.startsWith('data: ')) continue;

// 提取 JSON 数据
const data = line.slice(6).trim();
const event = JSON.parse(data);
```

### 新增日志示例

```bash
# 事件类型日志
[SSE] Event type: message_start
[SSE] Message started: msg_01ABC123

[SSE] Event type: content_block_delta
[SSE] Text delta: 你好！我是 Claude，很高兴为您服务。

[SSE] Event type: content_block_start
[SSE] Tool use started: str-replace-editor

[SSE] Event type: content_block_stop
[SSE] Tool use completed: str-replace-editor

[SSE] Event type: message_delta
[SSE] Stop reason: end_turn

[SSE] Event type: message_stop
[SSE] Message stopped

# 错误日志
[SSE] JSON parse error: Unexpected token, data: {"type":"invalid"...
```

---

## 🚀 安装方法

### 方法 1: VSCode 命令行
```bash
code --install-extension augment-proxy-manager-3.1.6.vsix
```

### 方法 2: VSCode 界面
1. 打开 VSCode
2. 按 `Cmd+Shift+P` (Mac) 或 `Ctrl+Shift+P` (Windows/Linux)
3. 输入 "Extensions: Install from VSIX..."
4. 选择 `augment-proxy-manager-3.1.6.vsix`

### 方法 3: 完全重装（推荐）
```bash
# 1. 卸载旧版本
code --uninstall-extension legna.augment-proxy-manager

# 2. 安装新版本
code --install-extension augment-proxy-manager-3.1.6.vsix

# 3. 重启 VSCode
```

---

## ✅ 验证安装

### 1. 检查版本
```bash
code --list-extensions --show-versions | grep augment-proxy-manager
# 应该显示: legna.augment-proxy-manager@3.1.6
```

### 2. 查看 SSE 日志
```bash
# 启动代理后查看日志
tail -f ~/.augment-proxy/logs/proxy.log | grep -E "SSE|Event type"
```

### 3. 测试自定义 API
- 配置自定义 API 端点（HTTP 或 HTTPS）
- 设置 format 为 "anthropic"
- 发送测试消息
- 检查日志中的 SSE 事件流

---

## 📝 配置示例

### 自定义 Anthropic 格式 API

```json
{
  "augmentProxy.provider": "custom",
  "augmentProxy.custom.baseUrl": "http://your-api-endpoint.com/v1/messages",
  "augmentProxy.custom.apiKey": "your-api-key",
  "augmentProxy.custom.model": "your-model-name",
  "augmentProxy.custom.format": "anthropic"
}
```

---

## 🔍 故障排查

### 问题 1: 仍然返回空响应

**检查**：
- 确认版本是 3.1.6
- 查看日志中是否有 `[SSE] Event type:` 输出
- 验证 API 端点返回的是标准 SSE 格式

**解决**：
```bash
# 使用 curl 测试 API 端点
curl -N -H "x-api-key: YOUR_KEY" \
     -H "anthropic-version: 2023-06-01" \
     -H "content-type: application/json" \
     -d '{"model":"your-model","messages":[{"role":"user","content":"test"}],"max_tokens":100,"stream":true}' \
     http://your-api-endpoint.com/v1/messages

# 应该看到类似输出：
# event: message_start
# data: {"type":"message_start",...}
```

### 问题 2: JSON 解析错误

**检查**：
- 查看日志中的 `[SSE] JSON parse error` 消息
- 检查 API 返回的数据格式是否正确

**解决**：
- 确认 API 端点返回的是标准 JSON 格式
- 检查是否有额外的空格或换行符
- 验证 `data:` 后面的内容是有效的 JSON

### 问题 3: 事件类型未识别

**检查**：
- 查看日志中的 `[SSE] Event type:` 输出
- 确认事件类型是否在支持列表中

**支持的事件类型**：
- `message_start`
- `message_stop`
- `message_delta`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `ping`

---

## 📚 相关文档

- [Anthropic 官方流式响应文档](https://docs.anthropic.com/en/api/messages-streaming)
- `release-notes-3.1.3.md` - 上下文压缩优化
- `release-notes-3.1.5.md` - 自定义 provider 格式支持

---

## 🔄 版本历史

- **3.1.6** (2026-02-26): 完整 SSE 规范支持 + 详细调试日志
- **3.1.5** (2026-02-26): 自定义 provider 格式检测修复
- **3.1.4** (2026-02-26): RAG 模型加载优化
- **3.1.3** (2026-02-26): 上下文压缩 + 流式响应优化

---

## 📅 发布信息

- **版本**: 3.1.6
- **发布日期**: 2026-02-26
- **文件大小**: 110.83MB
- **文件数**: 1613 个文件
- **兼容性**: VSCode ^1.85.0

---

## 🔮 下一步计划

### 短期（1-2 周）
- [ ] 实现 LLM 压缩（使用官方的 compressionPrompt）
- [ ] 完善工具拦截（添加 `view`、`grep-search`）
- [ ] 优化 Token 计数（使用 `gpt-tokenizer`）
- [ ] 支持 extended thinking 的 signature 验证

### 中期（1-2 月）
- [ ] 实现完整的 21 个官方工具
- [ ] 添加任务管理系统
- [ ] 实现子代理系统
- [ ] 添加性能监控面板

---

**享受完整的 Anthropic SSE 支持！** 🚀
