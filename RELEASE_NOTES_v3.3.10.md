# Augment Proxy Manager v3.3.10 - Responses 二轮 assistant history 编码修复

## 核心结论

这次修的不是 retry，也不是 parser。

真正的问题是：在 OpenAI `responses` 模式下，手工回放历史消息时，`assistant` 角色内容被错误编码成了 `input_text`。

第一轮没有 assistant history，所以能过；第二轮一旦带上上一轮 assistant 回复，上游就可能直接返回 `502 upstream_error`。

## 本次修复

### 1. Assistant history 改为 `output_text`
- `role: "assistant"` 的历史 message 内容不再使用 `input_text`
- 改为符合 Responses 语义的 `output_text`

### 2. 覆盖普通 assistant 与 assistant+tool_calls 两条路径
- 普通 assistant 历史消息会正确编码为 `output_text`
- 带 `tool_calls` 的 assistant 历史消息，其文本部分也会正确编码为 `output_text`

### 3. 清理脏 tool call
- 若历史 `assistant.tool_calls` 缺失 `function.name`
- 直接丢弃，不再构造坏的 `function_call` item 去污染上游请求

## 验证情况

- TypeScript diagnostics：通过
- 本地 compile：`npm run compile` 已通过

## 兼容性

- 仅影响 OpenAI `responses` 历史消息转换逻辑
- 不影响 `chat.completions`
- 不影响 Anthropic / Google provider