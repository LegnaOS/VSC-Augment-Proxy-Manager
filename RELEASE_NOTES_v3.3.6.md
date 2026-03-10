# Augment Proxy Manager v3.3.6 - OpenAI Responses 适配与 Custom Wire API 修复

## 核心结论

v3.3.6 主要修的是 custom OpenAI 兼容端点在 `responses` wire API 下“请求发出去了但完全没输出”的协议层错误。

根因不是网络，也不是 key，而是代理此前一直按 `chat.completions` 的请求体与 SSE 事件格式去处理 `responses`，导致文本增量、tool calls、续轮信号全都吃不到。

## 本次修复

### 1. Custom OpenAI `wireApi` 配置链路补齐
- 新增 `augmentProxy.custom.wireApi`
- 支持 `chat.completions` / `responses`
- sidebar 仅在 `custom + openai` 时显示 `OpenAI Wire API` 选项
- runtime 启动与热更新都会同步读取该配置

### 2. OpenAI Responses 请求体与 endpoint 归一化
- custom endpoint 会根据 wire protocol 自动归一化到 `/v1/chat/completions` 或 `/v1/responses`
- `responses` 模式下使用 `input` / `instructions` / `previous_response_id`
- tools 会转换成 `responses` 所需的扁平 `function` schema

### 3. Responses 流式解析与续轮修复
- 支持解析 `response.output_text.delta`
- 支持解析 `response.output_item.added` / `response.output_item.done`
- 支持解析 `response.function_call_arguments.delta` / `.done`
- 支持解析 `response.completed` / `error`
- tool continuation 改为 `function_call_output`，不再错误复用 chat message replay

## 验证情况

- IDE diagnostics：核心改动文件无 TypeScript diagnostics
- 本地 CLI compile 未完成：当前环境缺少已安装依赖，`node_modules/.bin/tsc` 不存在
- 因此本版本需要在装好依赖后补跑一次 `npm run compile` 与 `.vsix` 打包验证

## 已知限制

- 若本机未安装依赖，无法直接执行 `tsc` / `vsce` 打包
- 某些第三方 OpenAI-compatible `responses` 端点可能存在非标准事件名；当前已兼容主流 OpenAI Responses 事件，但仍取决于上游实现质量