# Augment Proxy Manager v3.3.8 - Responses Tool Call 别名合并修复

## 核心结论

v3.3.8 修的是 `responses` 工具调用聚合里的脏数据问题：

- 同一个 function call 在 SSE partial 事件里常见是 `call_...`
- 到 completed / output item 又可能变成 `fc_...`

旧实现直接拿不同 id `set` 进 `Map`，于是同一调用会裂成两条记录。其中那条没名字的脏记录被回落成了字面量 `tool`，最后执行层自然找不到 tool definition。

这版做的不是花活，就是把 **同一 tool call 重新并回同一条数据**。

## 本次修复

### 1. Responses tool call alias merge
- 合并 `call_id`
- 合并 `item.id / item_id`
- 合并 `output_index`
- 同一 function call 不再因为不同事件使用不同 id 被拆成两条

### 2. 禁止脏默认值污染
- partial 事件拿不到 `name` 时先留空
- 等 `output_item` / `response.completed` 再回填真实工具名
- 不再伪造默认工具名 `tool`

### 3. Defensive finalize
- 最终仍然没有真实 `name` 的 tool call 会被丢弃
- 同时输出 warning log，便于继续定位上游异常 payload
- 避免执行层再报：`Cannot find tool definition for tool 'tool'`

## 验证情况

- TypeScript diagnostics：通过
- 本地 compile：`npm run compile` 已通过
- 适合继续打包 `.vsix` 供实际对话流测试

## 兼容性

- 不影响 `chat.completions`
- 不影响 Anthropic / Google provider
- 只收敛 OpenAI `responses` 下的 tool-call 聚合逻辑