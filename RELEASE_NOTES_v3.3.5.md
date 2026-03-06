# Augment Proxy Manager v3.3.5 - Kimi 工具链闭环与标准 API reasoning 修复

## 核心结论

v3.3.5 集中修 Kimi / Moonshot 相关的两条主链：

- Kimi standard API (`https://api.moonshot.cn/v1/chat/completions`) continuation 历史回放缺失 `reasoning_content`
- Kimi Coding Anthropic 兼容链上的 `tool_call_id` / `tool_result` / thinking 回放不完整

## 本次修复

### 1. Standard API `reasoning_content` 补齐
- `assistant + tool_calls` 历史消息现在会从 `<think>...</think>` 中拆出 `reasoning_content`
- replay `assistant` tool call 消息时，若只有 reasoning 无正文，会发送 `content: null`
- 修复 Moonshot/Kimi continuation 第二轮因缺失 `reasoning_content` 返回 `400 invalid_request_error`

### 2. Kimi Coding / Anthropic 工具链闭环
- `tool_result` 兼容读取 `tool_call_id` / `tool_use_id` / `id`
- `tool_result` 补带 `tool_name`
- 增加 tool turn adjacency stabilize，降低 `tool_use` / `tool_result` 错位
- 保留带工具调用的空 assistant turn，避免误删合法历史

### 3. Thinking 历史回放
- `kimi-anthropic` 历史中的 `<think>...</think>` 会回放为 Anthropic `thinking`
- 若存在 `thought_signature`，会一并回放到 `signature`

## 验证结果

- `npm run compile` 通过
- 针对 `splitReasoningContentFromText()` 的 smoke 通过
- `augmentToOpenAIMessages()` / `augmentToAnthropicMessages()` 的工具链历史重建 smoke 通过

## 已知问题

- `api.kimi.com/coding/v1/messages` 需要有效的 Kimi Coding subscription；无效或过期 key 会返回 `401 authentication_error`
- 标准 API 可能返回 `429 engine_overloaded_error`；这表示请求结构已通过校验，但上游引擎过载