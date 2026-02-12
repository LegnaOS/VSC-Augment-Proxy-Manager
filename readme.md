<br />

<div align="center">

# Augment Proxy Manager

**用任意 AI 供应商驱动 Augment 的强大编码 Agent。**

零注入 · 零登录 · 零配置

[![Version](https://img.shields.io/badge/version-2.1.4-blue.svg)](https://github.com/LegnaOS/VSC-Augment-Proxy-Manager)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)]()

</div>

---

## 工作原理

Augment Proxy Manager 运行一个本地 HTTP 代理服务器，拦截 Augment 扩展的 API 请求并转发到你选择的 AI 供应商。

**v1.9 引入零注入模式** — 无需修改代码、无需登录。代理利用 Augment 扩展内置的 API Token 模式，自动配置请求路由。

```
Augment 扩展  →  本地代理 (:8765)  →  你的 AI 供应商 API
                  ↑ 自动配置
```

启动代理时，自动设置 `augment.advanced.completionURL` 指向本地代理，`augment.advanced.apiToken` 为占位 token。Augment 扩展检测到配置变更后，切换到 API Token 模式（绕过 OAuth），所有流量通过代理转发。停止代理时，自动清除配置，扩展恢复正常。

## 支持的供应商

| 供应商 | 协议格式 | 默认模型 |
|:-------|:--------|:---------|
| **Anthropic** | 原生 | `claude-sonnet-4-20250514` |
| **MiniMax** | Anthropic 兼容 | `MiniMax-M2.2` |
| **DeepSeek** | Anthropic 兼容 | `deepseek-chat` |
| **Google Gemini** | Google 原生 | `gemini-3-pro-preview` |
| **OpenAI** | 原生 | `gpt-4` |
| **GLM (智谱)** | OpenAI 兼容 | `GLM-4.7` |
| **Kimi (月之暗面)** | OpenAI 兼容 | `moonshot-v1-auto` |
| **自定义** | Anthropic / OpenAI | — |

## 快速开始

1. **安装**本扩展，同时安装官方 [Augment](https://marketplace.visualstudio.com/items?itemName=augment.vscode-augment) 扩展
2. 在侧边栏面板中**选择供应商**并输入 API Key
3. **启动代理** — 其他全部自动完成

就这样。无需注入、无需重载、无需登录。

## 功能特性

- **零注入绕过** — 自动配置 Augment 使用代理，无需修改任何代码
- **流式响应** — 聊天、补全、指令全程实时 SSE 流式传输
- **完整 Agent 模式** — 工具调用、文件编辑、代码库检索全部正常工作
- **本地代码索引** — 内置 RAG 语义搜索索引，无需云端同步
- **思考模式** — 支持 DeepSeek、MiniMax、GLM 的扩展思考 (Thinking)
- **JSON Mode** — 支持 Kimi API 的结构化 JSON 输出模式
- **联网搜索** — 支持 Kimi 内置的 `$web_search` 联网搜索功能
- **Prompt 缓存** — 自动为支持的供应商注入 cache_control
- **上下文压缩** — 基于 token 使用率的智能对话历史压缩
- **配置热更新** — 切换供应商或模型无需重启代理，实时生效
- **侧边栏控制面板** — 可视化界面管理供应商、API Key 和运行状态

## 配置项

| 设置项 | 默认值 | 说明 |
|:-------|:------|:-----|
| `augmentProxy.provider` | `anthropic` | AI 供应商 |
| `augmentProxy.port` | `8765` | 代理服务器端口 |
| `augmentProxy.enableContextCompression` | `true` | 启用智能上下文压缩 |
| `augmentProxy.compressionThreshold` | `80` | 压缩触发阈值 (%) |
| `augmentProxy.{provider}.baseUrl` | *按供应商* | API 端点地址 |
| `augmentProxy.{provider}.model` | *按供应商* | 模型名称 |

各供应商的专属选项（思考模式、缓存等）在设置中 `augmentProxy.{provider}.*` 下配置。

API Key 安全存储在 VSCode 内置的 SecretStorage 中。

## 跨平台支持

支持所有主流 VSCode 变体的路径检测：

| 编辑器 | macOS / Linux | Windows |
|:------|:-------------|:--------|
| VSCode | `~/.vscode/extensions` | `%USERPROFILE%\.vscode\extensions` |
| VSCode Insiders | `~/.vscode-insiders/extensions` | `%APPDATA%\Code - Insiders\extensions` |
| Cursor | `~/.cursor/extensions` | `%USERPROFILE%\.cursor\extensions` |
| Windsurf | `~/.windsurf/extensions` | `%USERPROFILE%\.windsurf\extensions` |

## 更新日志

### v2.1.4
- 🛠️ **完整支持 `apply_patch` 工具** — 支持 Augment 的两种 patch 格式（diff 格式和完整文件替换）
- 🤖 **GLM-5 支持** — 更新智谱 AI 默认模型为 `glm-5`
- 🔧 修复 patch 解析器的 substring 逻辑，正确处理缩进
- 🔧 自动检测 patch 格式，智能选择 `str-replace-editor` 或 `save-file`

### v2.1.3
- 🌙 **Kimi Coding Plan 支持** — 支持月之暗面 Coding Plan API（需要特殊订阅）
- 🔧 修复 Kimi API 端点配置
- 🔧 完善 Anthropic 格式检测逻辑

### v2.1.0
- 🌙 **Kimi (月之暗面) 支持** — 新增 Kimi 标准 API 支持
- 🔍 **JSON Mode** — 支持 Kimi 的结构化 JSON 输出
- 🌐 **联网搜索** — 支持 Kimi 内置的 `$web_search` 功能

### v1.9.1
- 🐛 修复模型选择器后显示 "noCanvas" 的问题
- 🔄 切换供应商或模型后自动生效，无需重启代理
- 📊 上下文压缩配置从 Google 专属移至全局，适用于所有供应商
- 📊 上下文/Token 统计在侧边栏刷新后保持显示

### v1.9.0
- 🚀 零注入模式 — 自动配置 Augment 扩展
- 🤖 完整 Agent 模式支持
- 🔍 本地 RAG 语义搜索索引
- 💬 思考模式 / Prompt 缓存 / 上下文压缩

## 许可证

MIT
