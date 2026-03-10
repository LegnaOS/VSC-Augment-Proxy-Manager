# Augment Proxy Manager v3.3.7 - OpenAI Provider Wire API 修正与 Responses 自动回退

## 核心结论

v3.3.7 修的是 v3.3.6 还没砍到根上的那一刀：实际 runtime 走的是 `openai` provider 路径，但 `wireApi` 之前只绑定在 `custom` 上，结果请求仍然错误发到 `/v1/chat/completions`。

所以这版不是再补 parser，而是把 **协议选择链路** 真正打通。

## 本次修复

### 1. `openai` provider 也支持 `wireApi`
- 新增 `augmentProxy.openai.wireApi`
- 支持 `chat.completions` / `responses`
- sidebar 会对 `openai` provider 展示并保存该配置
- runtime 启动与热更新都会同步读取

### 2. 按目标协议重写 endpoint
- 若 base URL 已经带 `/chat/completions` 或 `/responses`
- runtime 不再原样保留错误后缀
- 会按当前目标协议替换成正确 suffix

### 3. 自动识别与 fallback
- 会从 base URL 自动推断 `responses` / `chat.completions`
- 若上游 400 明确返回：
  - `Unsupported legacy protocol`
  - `Please use /v1/responses`
- 代理会自动 fallback 到 `responses` 重试一次

## 验证情况

- TypeScript diagnostics：核心文件无 diagnostics
- 本地 compile：`npm run compile` 已通过
- 适合继续打包成新的 `.vsix` 供测试

## 风险与兼容性

- 旧的 `chat.completions` 路径仍保留
- `custom + openai` 原有配置继续兼容
- 新增逻辑只影响 OpenAI-format provider 的协议选择，不碰 Anthropic / Google 路径

