<br />

<div align="center">

# Augment Proxy Manager

**Use any AI model as the backend for the Augment VSCode extension.**

Zero Injection · Zero Login · Zero Configuration

[![Version](https://img.shields.io/badge/version-3.4.1-blue.svg)](https://github.com/LegnaOS/VSC-Augment-Proxy-Manager)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)]()

[English](README.md) · [中文](README_CN.md)

</div>

---

## How It Works

Augment Proxy Manager runs a local HTTP proxy that intercepts the
Augment extension's API requests and forwards them to your chosen AI provider.

```
Augment Extension  →  Local Proxy (:8765)  →  Your AI Provider API
                       ↑ Auto-configured       ↑ Viking context injection
```

When the proxy starts, it automatically sets
`augment.advanced.completionURL` to point at the local proxy and
`augment.advanced.apiToken` to a placeholder token. The Augment
extension detects the config change, switches to API Token mode
(bypassing OAuth), and routes all traffic through the proxy. When the
proxy stops, the config is cleared and the extension returns to normal.

## Supported Providers

| Provider | Protocol | Default Model |
|:---------|:---------|:-------------|
| **Anthropic** | Native | `claude-sonnet-4-20250514` |
| **MiniMax** | Anthropic-compatible | `MiniMax-M2.2` |
| **DeepSeek** | Anthropic-compatible | `deepseek-chat` |
| **Google Gemini** | Google Native | `gemini-3-pro-preview` |
| **OpenAI** | Native | `gpt-4` |
| **GLM (Zhipu)** | OpenAI-compatible | `glm-4.7` |
| **Kimi (Moonshot)** | OpenAI-compatible | `kimi-k2.5` |
| **Kimi Coding Plan** | Anthropic Messages | `kimi-for-coding` |
| **Custom** | Anthropic / OpenAI | — |

## Quick Start

1. **Install** this extension alongside the official
   [Augment](https://marketplace.visualstudio.com/items?itemName=augment.vscode-augment) extension
2. **Select a provider** and enter your API key in the sidebar panel
3. **Start the proxy** — everything else is automatic

That's it. No code injection, no reload, no login required.

## Features

### v3.4 — Agent Tool System

- **Tool type system** — Generic `Tool<Input,Output>` interface with `buildTool()` factory, fail-closed safety defaults
- **ToolRegistry** — Unified tool registration, lookup (with aliases), dispatch, and concurrent partitioned execution
- **Concurrency partitioning** — Read-only tools run in parallel, write tools run serially
- **5 new agent tools**: `bash`, `glob`, `grep`, `file_read`, `list_directory`
- **Auto-injected schemas** — New tool JSON schemas auto-injected into Anthropic/OpenAI/Gemini formats
- **Unified interception** — All three provider paths integrate ToolRegistry async interception

### v3.0 — Intelligent Context Engine

- **Viking layered context** — Inspired by [OpenViking](https://github.com/volcengine/OpenViking): L0 summary / L1 structure / L2 full content, loaded on demand
- **Directory aggregation + recursive drill-down** — Vector pre-filter → directory aggregation → top directory drill-down
- **Session Memory** — Auto-extracts user preferences from conversations, persisted via LevelDB
- **Local embedding models** — 5 ONNX models (22MB–118MB), one-click download and switch from the sidebar
- **Remote Embedding API** — GLM / OpenAI / custom remote embedding with automatic local fallback

### Proxy Core

- **Zero-injection bypass** — Auto-configures Augment to use the proxy without modifying any code
- **Streaming responses** — Real-time SSE streaming for chat, completion, and instructions
- **Full Agent mode** — Tool calls, file editing, codebase retrieval all work correctly
- **Protocol translation** — Unified Augment request format translated to Anthropic / OpenAI / Google backends
- **Outbound proxy support** — HTTP_PROXY/HTTPS_PROXY/NO_PROXY for corporate environments (CONNECT tunneling)
- **Request correlation** — Every outbound API call tagged with `x-request-id` for debugging
- **Transient error retry** — Automatic single retry on 502/503/504 and transport errors
- **Hot-reload config** — Switch providers or models without restarting the proxy

### RAG Semantic Search

- **Local code index** — Built-in TF-IDF + BM25 + semantic hybrid search, no cloud sync needed
- **5 embedding models** — MiniLM / BGE / E5 series including multilingual
- **Per-model cache** — Independent cache files per model, switching doesn't lose history

### Enhancements

- **OMC orchestration** — Integrates [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) with 6 orchestration modes
- **Thinking mode** — Extended thinking support for DeepSeek, MiniMax, GLM, Claude, Gemini
- **Prompt caching** — Auto-injects `cache_control` for supported providers
- **Context compression** — Token-aware intelligent chat history compression
- **Sidebar control panel** — Visual UI for all configuration and runtime status

## Local Embedding Models

| Model | Size | Dims | Language | Notes |
|:------|:-----|:-----|:---------|:------|
| MiniLM-L6 | 22MB | 384 | English | Smallest and fastest |
| MiniLM-L12 | 33MB | 384 | English | 12 layers, more accurate |
| BGE-Small | 33MB | 384 | English | Good for code search |
| **BGE-Base** ⭐ | 109MB | 768 | English | Best value, recommended |
| E5-Multi-Small | 118MB | 384 | Multilingual | Chinese/English/Japanese/Korean |

Models use [Xenova/transformers.js](https://github.com/xenova/transformers.js) ONNX format, auto-downloaded on first use.

## Configuration

| Setting | Default | Description |
|:--------|:--------|:------------|
| `augmentProxy.provider` | `anthropic` | AI provider |
| `augmentProxy.port` | `8765` | Proxy server port |
| `augmentProxy.enableContextCompression` | `true` | Enable smart context compression |
| `augmentProxy.compressionThreshold` | `80` | Compression trigger threshold (%) |
| `augmentProxy.{provider}.baseUrl` | *per provider* | API endpoint URL |
| `augmentProxy.{provider}.model` | *per provider* | Model name |
| `augmentProxy.omc.enabled` | `false` | Enable OMC orchestration |
| `augmentProxy.embedding.localModel` | `Xenova/all-MiniLM-L6-v2` | Local embedding model |
| `augmentProxy.embedding.enabled` | `false` | Enable remote Embedding API |

Provider-specific options (thinking mode, caching, etc.) are under `augmentProxy.{provider}.*`.
API keys are securely stored in VSCode's built-in SecretStorage.

## Architecture

```
src/
├── extension.ts              # Extension entry point
├── proxy.ts                  # HTTP proxy server + routing
├── outbound-proxy.ts         # Outbound HTTPS proxy (CONNECT tunnel) + retry
├── messages.ts               # Augment protocol parsing + system prompt injection
├── sidebar.ts                # Sidebar Webview UI
├── config.ts                 # Provider configuration
├── globals.ts                # Global state
├── context-manager.ts        # Context management
├── context-compression.ts    # Smart compression
├── omc.ts                    # OMC orchestration
├── tools/                    # v3.4.0 tool system
│   ├── Tool.ts               # Core interface + buildTool() factory
│   ├── ToolRegistry.ts       # Registry (lookup/dispatch/concurrent execution)
│   ├── StrReplaceEditorTool, SaveFileTool, ApplyPatchTool, BashTool
│   ├── GlobTool, GrepTool, FileReadTool, ListDirectoryTool
│   └── shared/               # Patch parser, path utils, input fixer
├── providers/
│   ├── anthropic.ts          # Anthropic streaming + proxy + retry
│   ├── openai.ts             # OpenAI streaming + proxy
│   └── google.ts             # Google Gemini streaming
└── rag/
    ├── index.ts              # RAG index + Viking-enhanced search
    ├── embeddings.ts          # Embedding engine (5 local + remote API)
    ├── viking-context.ts     # Viking L0/L1/L2 layered context
    ├── session-memory.ts     # Session memory (LevelDB)
    └── storage.ts            # LevelDB persistence
```

## Cross-Platform Support

| Editor | macOS / Linux | Windows |
|:-------|:-------------|:--------|
| VSCode | `~/.vscode/extensions` | `%USERPROFILE%\.vscode\extensions` |
| VSCode Insiders | `~/.vscode-insiders/extensions` | `%APPDATA%\Code - Insiders\extensions` |
| Cursor | `~/.cursor/extensions` | `%USERPROFILE%\.cursor\extensions` |
| Windsurf | `~/.windsurf/extensions` | `%USERPROFILE%\.windsurf\extensions` |

## Evolution

```
v1.9.0  Zero-injection proxy + RAG semantic search
  ↓
v2.1.x  Kimi/GLM multi-provider + OMC orchestration
  ↓
v3.0.0  Viking layered context + Session Memory + local embedding
  ↓
v3.1.0  File editing engine rewrite + 3-provider loop architecture
  ↓
v3.3.x  OpenAI Responses protocol + Kimi tool chain + state endpoints
  ↓
v3.4.0  Agent tool system — Tool types + ToolRegistry + 5 new tools
  ↓
v3.4.1  GLM tool loop fix + outbound proxy support
```

## License

MIT
