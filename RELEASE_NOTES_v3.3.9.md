# Augment Proxy Manager v3.3.9 - Upstream 502/503/504 保守重试

## 核心结论

这版不是再修 parser，而是给 OpenAI-compatible 上游加一个最小兜底：

- 当 `/v1/responses` 返回 `502 / 503 / 504`
- 或者请求过程中出现 timeout / `ECONNRESET` / `socket hang up`

代理会做 **一次** 保守自动重试。

目的很简单：别让一次中转抖动把整轮对话直接打死。

## 本次修复

### 1. Transient upstream retry
- 识别 `502 / 503 / 504`
- 识别 `upstream request failed` / `upstream_error` / `bad gateway` / `gateway timeout`
- 小延迟 backoff 后自动重试 1 次

### 2. Transport-level retry
- 对以下瞬时传输错误新增同样的单次重试：
  - timeout
  - `ECONNRESET`
  - `ECONNREFUSED`
  - `ETIMEDOUT`
  - `socket hang up`

### 3. Better logs
- 请求日志新增：
  - `tools` 数量
  - `bodyBytes`
  - `continuation`
  - `retry` 次数
- 继续出问题时能更快判断到底是 payload 触发，还是上游随机抽风

## 验证情况

- TypeScript diagnostics：通过
- 本地 compile：`npm run compile` 已通过
- 适合继续打包 `.vsix` 供真实上游回归测试

## 兼容性

- 不改变正常成功请求的行为
- 不影响 `400` 类真实请求错误的显式暴露
- 不影响 Anthropic / Google provider