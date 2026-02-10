<br />

<div align="center">

# Augment Proxy Manager

**Use Augment's powerful AI coding agent with any LLM provider.**

Zero-injection · Zero-login · Zero-config

[![Version](https://img.shields.io/badge/version-1.9.0-blue.svg)](https://github.com/LegnaOS/VSC-Augment-Proxy-Manager)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)]()

</div>

---

## How It Works

Augment Proxy Manager runs a local HTTP proxy that intercepts Augment extension requests and forwards them to your chosen AI provider.

**v1.9.0 introduces zero-injection mode** — no code patching, no login required. The proxy automatically configures the Augment extension to route all requests through the local server by leveraging the extension's built-in API Token mode.

```
Augment Extension  →  Local Proxy (:8765)  →  Your AI Provider API
                       ↑ auto-configured
```

When you start the proxy, it sets `augment.advanced.completionURL` to `http://proxy.localhost:{port}` and `augment.advanced.apiToken` to a placeholder token. The Augment extension detects these changes, switches to API Token mode (bypassing OAuth), and routes all traffic through the proxy. When you stop the proxy, it clears the config and the extension returns to normal.

## Supported Providers

| Provider | Format | Default Model |
|:---------|:-------|:-------------|
| **Anthropic** | Native | `claude-sonnet-4-20250514` |
| **MiniMax** | Anthropic Compatible | `MiniMax-M2.2` |
| **DeepSeek** | Anthropic Compatible | `deepseek-chat` |
| **Google Gemini** | Google Native | `gemini-3-pro-preview` |
| **OpenAI** | Native | `gpt-4` |
| **GLM (Zhipu)** | OpenAI Compatible | `GLM-4.7` |
| **Custom** | Anthropic / OpenAI | — |

## Quick Start

1. **Install** this extension alongside the official [Augment](https://marketplace.visualstudio.com/items?itemName=augment.vscode-augment) extension
2. **Select provider** and enter your API key in the sidebar panel
3. **Start Proxy** — everything else is automatic

That's it. No injection, no reload, no login.

## Features

- **Zero-Injection Bypass** — Auto-configures Augment to use the proxy, no code patching needed
- **Streaming Responses** — Real-time SSE streaming for chat, completion, and instruction
- **Full Agent Mode** — Tool use, file editing, codebase retrieval all work seamlessly
- **Local Code Index** — Built-in RAG indexing, no cloud sync required
- **Thinking Mode** — Supports extended thinking for DeepSeek, MiniMax, and GLM
- **Prompt Caching** — Automatic cache_control injection for supported providers
- **Context Compression** — Smart token-aware compression for Gemini's context window
- **Sidebar Control Panel** — Visual UI for provider selection, API key management, and status

## Configuration

| Setting | Default | Description |
|:--------|:--------|:------------|
| `augmentProxy.provider` | `anthropic` | AI provider |
| `augmentProxy.port` | `8765` | Proxy server port |
| `augmentProxy.{provider}.baseUrl` | *per provider* | API endpoint URL |
| `augmentProxy.{provider}.model` | *per provider* | Model name |

Provider-specific options (thinking mode, caching, compression) are available under `augmentProxy.{provider}.*` in Settings.

API keys are stored securely in VSCode's built-in SecretStorage.

## Cross-Platform Support

Path detection supports all major VSCode variants:

| Editor | macOS / Linux | Windows |
|:-------|:-------------|:--------|
| VSCode | `~/.vscode/extensions` | `%USERPROFILE%\.vscode\extensions` |
| VSCode Insiders | `~/.vscode-insiders/extensions` | `%APPDATA%\Code - Insiders\extensions` |
| Cursor | `~/.cursor/extensions` | `%USERPROFILE%\.cursor\extensions` |
| Windsurf | `~/.windsurf/extensions` | `%USERPROFILE%\.windsurf\extensions` |

## License

MIT
