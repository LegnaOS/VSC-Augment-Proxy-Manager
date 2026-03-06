# Augment Proxy Manager v3.3.4 - Continuity 修复与协议状态承接

## 核心结论

v3.3.4 的改动集中在代理层的 continuation handling、history projection、state endpoint compatibility 和 per-conversation serialization：

- continuation `"..."` 仅作为 continuation signal 处理，不再改写用户消息内容
- 原始 `chat_history` 保留，压缩结果单独写入 `compressed_chat_history`
- `save-chat`、`record-*`、`context-canvas/list` 新增最小状态写入与读取逻辑
- 同一 `conversation_id` 的请求通过 `state.conversationQueues` 串行化处理

## 本次修复

### 1. Continuity 主链修复
- continuation `"..."` 按 continuation signal 处理，不再通过 prompt 改写参与消息编译
- 原始 `chat_history` 保留为会话原始记录
- 压缩结果单独写入 `compressed_chat_history`
- provider 统一从 canonical / normalized timeline 编译消息

### 2. 状态端点最小实现
以下端点已从固定成功响应调整为最小状态实现：

- `/save-chat`
- `/record-session-events`
- `/record-user-events`
- `/record-request-events`
- `/context-canvas/list`
- `/generate-conversation-title`
- `/notifications/mark-read`（兼容处理）

代理层新增以下内存状态容器，用于保存最小会话状态：

- `conversationStates`
- `canvasStates`
- `sessionEventStore`
- `userEventStore`
- `requestEventStore`

### 3. 会话级请求串行化
- 请求队列统一挂到全局 `state.conversationQueues`
- 同一 `conversation_id` 的请求按顺序执行，避免并发交错影响工具调用链

## 验证结果

已完成本地 runtime smoke：

- `save-chat`
- `record-session-events`
- `record-user-events`
- `record-request-events`
- `context-canvas/list`
- `generate-conversation-title`

以上端点均返回与会话状态相关的结构化结果，而不是固定 `success: true` 响应。
