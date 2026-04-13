<br />

<div align="center">

# Augment Proxy Manager

**Augment 前端 + 多模型后端的本地协议代理。**

零注入 · 零登录 · 零配置

[![Version](https://img.shields.io/badge/version-3.5.0-blue.svg)](https://github.com/LegnaOS/VSC-Augment-Proxy-Manager)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)]()

[English](README.md) · [中文](README_CN.md)

</div>

---

## How It Works

Augment Proxy Manager runs a local HTTP proxy server that intercepts the Augment extension's API requests and forwards them to your chosen AI provider.

The proxy layer handles Augment's request format, context projection, tool calls, and state endpoints, then translates everything to the target model backend.

```
Augment Extension  →  Local Proxy (:8765)  →  Your AI Provider API
                       ↑ Auto-configured       ↑ Viking context enhancement
```

When the proxy starts, it automatically sets `augment.advanced.completionURL` to point at the local proxy and `augment.advanced.apiToken` to a placeholder token. The Augment extension detects the config change, switches to API Token mode (bypassing OAuth), and routes all traffic through the proxy. When the proxy stops, the config is cleared and the extension returns to normal.

## Supported Providers

| Provider | Protocol | Default Model |
|:---------|:---------|:--------------|
| **Anthropic** | Native | `claude-sonnet-4-20250514` |
| **MiniMax** | Anthropic-compatible | `MiniMax-M2.2` |
| **DeepSeek** | Anthropic-compatible | `deepseek-chat` |
| **Google Gemini** | Google Native | `gemini-3-pro-preview` |
| **OpenAI** | Native | `gpt-4` |
| **GLM (Zhipu)** | OpenAI-compatible | `glm-4.7` |
| **Kimi (Moonshot)** | OpenAI-compatible | `kimi-k2.5` |
| **Kimi Coding Plan** | Anthropic Messages-compatible | `kimi-for-coding` |
| **Custom** | Anthropic / OpenAI | — |

## Quick Start

1. **Install** this extension alongside the official [Augment](https://marketplace.visualstudio.com/items?itemName=augment.vscode-augment) extension
2. **Select a provider** and enter your API Key in the sidebar panel
3. **Start the proxy** — everything else is automatic

That's it. No injection, no reload, no login required.

## Features

### v3.4 — Agent Tool System Evolution

- **Tool type system** — Generic `Tool<Input,Output>` architecture inspired by Claude Code, `buildTool()` factory pattern, fail-closed safety defaults (`isReadOnly=false`, `isConcurrencySafe=false`)
- **ToolRegistry** — Unified tool registration, lookup (with aliases), dispatch, and format conversion as a global singleton
- **Concurrent partitioned execution** — Read-only tools (Glob/Grep/FileRead/ListDirectory/CodebaseSearch) run in parallel automatically; write tools run strictly in serial, following Claude Code's `partitionToolCalls` strategy
- **5 new Agent tools**:
  - `bash` — Shell command execution (120s timeout, 10MB output buffer)
  - `glob` — File pattern search (`**/*.ts`, `src/**/*.js`)
  - `grep` — Content search (prefers ripgrep, falls back to grep)
  - `file_read` — Enhanced file reading (line numbers, line range selection, 2MB limit)
  - `list_directory` — Directory listing (file type + size annotations)
- **Auto-injected tool schemas** — JSON Schemas for new tools are automatically injected into Anthropic/OpenAI/Gemini tool_definitions
- **Unified interception across 3 providers** — Anthropic/OpenAI/Google forwarding paths all integrate ToolRegistry async interception; new tools execute directly in the proxy layer
- **Modularized existing tools** — str-replace-editor, save-file, apply_patch, task list, codebase_search and 7 other tools extracted from a 1427-line if/else chain into independent modules
- **Shared tool utilities** — Patch parser (Augment V4A + Unified Diff), path correction, and generic input fixing extracted into reusable `shared/` modules

### v3.0 — Intelligent Context Engine

- **Viking layered context** — Inspired by [OpenViking](https://github.com/volcengine/OpenViking)'s filesystem paradigm: L0 summary / L1 structure / L2 full text, three tiers loaded on demand for precise token budget control
- **Directory aggregation + recursive drill-down** — Vector pre-filter → directory-level aggregation → top directory recursive drill-down, using structural signals to compensate for vector precision gaps
- **Session Memory** — Automatically extracts user preferences (language/framework/coding style) from conversations, persisted with LevelDB for cross-session long-term memory
- **Local model selection** — Visual selection of 5 local embedding models (22MB–118MB) in the sidebar, with runtime switching and real-time download progress
- **Remote Embedding API** — Supports GLM / OpenAI / custom remote embeddings, with automatic fallback to local on failure
- **HuggingFace mirror acceleration** — Built-in hf-mirror.com mirror for significantly faster model downloads in China
- **Download cancellation + cache auto-repair** — Cancel in-progress model downloads; corrupted caches are automatically detected, cleaned, and re-downloaded
- **Smart cache detection** — Already-downloaded models load directly from local cache without re-checking downloads
- **OOM crash protection** — When a large model causes extension host crashes, automatically falls back to the default small model on next startup

### Proxy Core

- **Zero-injection bypass** — Automatically configures Augment to use the proxy without modifying any code
- **Streaming responses** — Real-time SSE streaming for chat, completion, and instructions
- **Full Agent mode** — Tool calls, file editing, and codebase retrieval all work correctly
- **Protocol translation layer** — Proxy accepts Augment's request format and translates to Anthropic / OpenAI / Google backend protocols
- **Continuity fix** — Preserves original `chat_history`, writes compressed results to `compressed_chat_history` to prevent multi-step task context corruption
- **Minimal state endpoints** — `/save-chat`, `/record-session-events`, `/record-user-events`, `/record-request-events`, `/context-canvas/list` upgraded from fixed success responses to minimal state implementations
- **Kimi tool chain compatibility** — Fills in `tool_call_id` / `tool_name` mappings, stabilizes `tool_use ↔ tool_result` adjacency
- **Kimi reasoning/thinking replay** — `<think>...</think>` in continuation history is split and replayed into `reasoning_content` / `thinking`
- **Hot config reload** — Switch providers or models without restarting the proxy

### RAG Semantic Search

- **Local code indexing** — Built-in RAG semantic search, no cloud sync required
- **5 embedding models** — MiniLM / BGE / E5 series including multilingual models, one-click download and switch from the sidebar
- **Per-model caching** — Each model has independent cache files; switching models doesn't lose historical cache

### Enhancements

- **OMC orchestration** — Integrates [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) with 6 orchestration modes + magic keywords
- **Thinking mode** — Supports extended thinking for DeepSeek, MiniMax, and GLM
- **Prompt caching** — Automatically injects `cache_control` for supported providers
- **Context compression** — Intelligent chat history compression based on token usage ratio
- **Sidebar control panel** — Visual interface for managing all configuration and runtime status

## Local Embedding Models

v3.0 supports selecting and downloading local embedding models from the sidebar — no remote API configuration needed for semantic search:

| Model | Size | Dimensions | Language | Notes |
|:------|:-----|:-----------|:---------|:------|
| MiniLM-L6 | 22MB | 384 | English | Smallest and fastest, basic semantic search |
| MiniLM-L12 | 33MB | 384 | English | 12 layers, more accurate than L6 |
| BGE-Small | 33MB | 384 | English | BAAI BGE small model, good for code search |
| **BGE-Base** ⭐ | 109MB | 768 | English | Best value, recommended |
| E5-Multi-Small | 118MB | 384 | Multilingual | Supports Chinese/English/Japanese/Korean |

Models use [Xenova/transformers.js](https://github.com/xenova/transformers.js) ONNX format and are automatically downloaded to local cache on first use.

## Configuration

| Setting | Default | Description |
|:--------|:--------|:------------|
| `augmentProxy.provider` | `anthropic` | AI provider |
| `augmentProxy.port` | `8765` | Proxy server port |
| `augmentProxy.enableContextCompression` | `true` | Enable intelligent context compression |
| `augmentProxy.compressionThreshold` | `80` | Compression trigger threshold (%) |
| `augmentProxy.{provider}.baseUrl` | *per provider* | API endpoint URL |
| `augmentProxy.{provider}.model` | *per provider* | Model name |
| `augmentProxy.omc.enabled` | `false` | Enable OMC orchestration |
| `augmentProxy.omc.mode` | `team` | OMC orchestration mode |
| `augmentProxy.embedding.localModel` | `Xenova/all-MiniLM-L6-v2` | Local embedding model |
| `augmentProxy.embedding.enabled` | `false` | Enable remote Embedding API |
| `augmentProxy.embedding.provider` | `glm` | Remote embedding provider |
| `augmentProxy.embedding.mirror` | `""` | HuggingFace download mirror (hf-mirror.com) |

Provider-specific options (thinking mode, caching, etc.) are configured under `augmentProxy.{provider}.*` in settings.

API Keys are securely stored in VSCode's built-in SecretStorage.

## Architecture

```
src/
├── extension.ts          # Extension entry point
├── proxy.ts              # HTTP proxy server + initialization
├── messages.ts           # Augment protocol parsing + System Prompt injection
├── sidebar.ts            # Sidebar Webview UI
├── config.ts             # Provider configuration
├── globals.ts            # Global state (Viking/SessionMemory/RAG/Embedding/ToolRegistry)
├── context-manager.ts    # Context management
├── context-compression.ts # Intelligent compression
├── injection.ts          # Augment extension auto-configuration
├── omc.ts                # OMC orchestration enhancement
├── tools.ts              # Tool call handling (thin delegation to tools/)
├── tools/                # v3.4.0 tool system
│   ├── Tool.ts           # Core interface + buildTool() factory
│   ├── ToolRegistry.ts   # Tool registry (lookup/dispatch/concurrent partitioned execution)
│   ├── ToolResultFormatter.ts # Diff rendering + result formatting
│   ├── extra-tool-schemas.ts  # New tool JSON Schemas (tri-format injection)
│   ├── index.ts           # Registration entry point
│   ├── StrReplaceEditorTool.ts  # Precise editing (insert/str_replace/3-tier matching)
│   ├── SaveFileTool.ts          # New file creation (rejects existing files)
│   ├── ApplyPatchTool.ts        # Diff/Patch application
│   ├── TaskListTool.ts          # Task list management
│   ├── EditFileTool.ts          # Error stub (redirects to str-replace-editor)
│   ├── WebSearchTool.ts         # Kimi $web_search passthrough
│   ├── CodebaseSearchTool.ts    # RAG local search
│   ├── BashTool.ts              # Shell command execution
│   ├── GlobTool.ts              # File pattern search
│   ├── GrepTool.ts              # Content search (ripgrep/grep)
│   ├── FileReadTool.ts          # Enhanced file reading
│   ├── ListDirectoryTool.ts     # Directory listing
│   └── shared/
│       ├── patch-parser.ts      # Augment V4A + Unified Diff parser
│       ├── path-utils.ts        # Path prefix correction
│       └── input-fixer.ts       # Generic input fixing
├── providers/
│   ├── anthropic.ts      # Anthropic streaming + ToolRegistry interception
│   ├── openai.ts         # OpenAI streaming + ToolRegistry interception
│   └── google.ts         # Google Gemini streaming + ToolRegistry interception
└── rag/
    ├── index.ts           # RAG index + Viking-enhanced search
    ├── embeddings.ts      # Embedding engine (5 local models + remote API)
    ├── viking-context.ts  # Viking L0/L1/L2 layered context
    ├── session-memory.ts  # Session Memory long-term memory
    ├── code-parser.ts     # Code structure parser
    ├── context-generator.ts # Context generation
    └── storage.ts         # LevelDB persistent storage
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
v3.0.0  Viking layered context + Session Memory + local embeddings
  ↓
v3.1.0  File editing engine rewrite + tri-provider loop architecture + diff rendering
  ↓
v3.3.x  OpenAI Responses protocol + Kimi tool chain closure + state endpoints
  ↓
v3.4.0  Agent tool system evolution — Tool type system + ToolRegistry
         + 5 new tools (Bash/Glob/Grep/FileRead/ListDir)
         + concurrent partitioned execution + tri-provider unified interception
```

## Changelog

### v3.4.1 — GLM Tool Loop Messages Fix

- **GLM tool calling multi-turn replay fix** — GLM coding endpoint (`/api/coding/paas/v4`) doesn't support standard OpenAI tool calling multi-turn replay format (`assistant(tool_calls) + tool(results)`), consistently triggering `messages parameter invalid` 400 errors on continuation
- **GLM message folding strategy** — For GLM provider, historical `assistant(tool_calls) + tool(results)` are automatically folded into plain text `assistant + user` message pairs, completely bypassing multi-turn replay compatibility issues
- **Internal tool loop sync fix** — The proxy's internal tool loop (intercepted tool execution fed back to AI) also uses plain text folding for GLM, ensuring tool chain closure
- **Conditional reasoning_content injection** — Only injected for DeepSeek/Kimi; skipped for GLM/OpenAI

### v3.4.0 — Agent Tool System Evolution

**Architecture Refactor — Inspired by Claude Code Tool Type System**
- New `Tool` generic interface + `buildTool()` factory pattern with fail-closed safety defaults
- New `ToolRegistry` for unified tool lookup (with aliases), dispatch, and concurrent partitioned execution
- Split the 1427-line `convertOrInterceptFileEdit()` if/else chain in `tools.ts` into 7 independent tool modules
- Patch parser, path correction, and input fixing extracted into reusable `shared/` modules
- `processToolCallForAugment` converted to async for ToolRegistry async interception

**5 New Agent Tools**
- `bash` — Shell command execution (child_process.spawn, 120s timeout, 10MB output buffer)
- `glob` — File pattern search (find + excludes node_modules/.git/dist, 200 result limit)
- `grep` — Content search (prefers ripgrep, falls back to grep, supports regex/case/context lines)
- `file_read` — Enhanced file reading (cat -n format line numbers, offset/limit line range, 2MB limit)
- `list_directory` — Directory listing (directories first, file size annotations)

**Tri-Provider Unified Interception**
- Anthropic / OpenAI / Google forwarding paths all integrate ToolRegistry async interception
- New tool JSON Schemas auto-injected into three formats via `extra-tool-schemas.ts`
- Read-only tools run in parallel automatically; write tools run strictly in serial
- Tool result size truncation (50KB limit)

**New Files (20 files, 1625 lines)**
```
src/tools/Tool.ts, ToolRegistry.ts, ToolResultFormatter.ts, extra-tool-schemas.ts, index.ts
src/tools/StrReplaceEditorTool.ts, SaveFileTool.ts, ApplyPatchTool.ts, TaskListTool.ts
src/tools/EditFileTool.ts, WebSearchTool.ts, CodebaseSearchTool.ts
src/tools/BashTool.ts, GlobTool.ts, GrepTool.ts, FileReadTool.ts, ListDirectoryTool.ts
src/tools/shared/patch-parser.ts, path-utils.ts, input-fixer.ts
```

**Modified Files (6 files)**
- `globals.ts` — Added toolRegistry field
- `proxy.ts` — Initialize ToolRegistry
- `tools.ts` — Three convertToolDefinitions inject new tool schemas + processToolCallForAugment async conversion
- `providers/anthropic.ts` — Tool loop integrates ToolRegistry async interception
- `providers/openai.ts` — Auto-integrated via processToolCallForAugment
- `providers/google.ts` — Tool loop integrates ToolRegistry async interception

### v3.3.10 — Responses Second-Turn Assistant History Encoding Fix

- **assistant history fix** — When manually replaying history messages in `responses` mode, assistant role content is no longer incorrectly encoded as `input_text`; now uses protocol-correct `output_text`
- **second-turn stability** — Fixes "first turn works, second turn consistently 502" issues caused by invalid assistant history payloads
- **tool-call hygiene** — Historical `assistant.tool_calls` entries missing `function.name` are discarded outright, preventing bad `function_call` items from being sent upstream
- **compatibility** — Only affects OpenAI `responses` history message conversion; no changes to `chat.completions`, Anthropic, or Google paths

### v3.3.9 — Upstream 502/503/504 Conservative Retry

- **transient upstream retry** — Adds a single conservative auto-retry for `502 / 503 / 504` transient upstream errors, reducing the chance of `responses` requests being killed by intermittent relay failures
- **transport retry** — Timeout, `ECONNRESET`, `socket hang up` and other transient transport errors also go through the same single-retry path
- **better execution logs** — Request logs now include `tools` count, body size, continuation state, and retry count for easier upstream compatibility debugging
- **safety** — Only retries obvious transient failures; `400`-class real request errors are never masked as recoverable

### v3.3.8 — Responses Tool Call Alias Merge Fix

- **responses tool alias merge** — Merges `call_id`, `item.id / item_id`, and `output_index` identifiers to prevent the same function call from being split into two records across streaming events and completed payloads
- **no fake tool name** — Responses parser no longer pollutes incomplete tool calls with the literal name `tool`; waits for the final payload to backfill the real name
- **defensive finalize** — Tool calls that still lack a real name after finalization are discarded with a warning, preventing the execution layer from reporting `Cannot find tool definition for tool 'tool'`
- **compatibility** — Fix only affects OpenAI `responses` tool-call aggregation logic; no changes to `chat.completions`, Anthropic, or Google paths

### v3.3.7 — OpenAI Provider Wire API Fix + Responses Auto-Fallback

- **openai provider wireApi** — `wireApi` is no longer bound only to `custom`; the `openai` provider can now explicitly choose `chat.completions` or `responses`
- **endpoint suffix normalization** — When the base URL already ends with `/chat/completions` or `/responses`, runtime replaces it with the correct suffix for the target protocol instead of sticking with the wrong endpoint
- **protocol inference** — Automatically infers `responses/chat.completions` from the base URL, reducing config/runtime inconsistencies that cause misdirected requests
- **legacy protocol fallback** — If upstream returns `Unsupported legacy protocol` / `Please use /v1/responses`, the proxy automatically switches to `responses` and retries once
- **sidebar config** — Control panel now shows and saves `OpenAI Wire API` for the `openai` provider, no longer limited to `custom + openai`

### v3.3.6 — OpenAI Responses Adaptation + Custom Wire API

- **OpenAI `responses` wire API** — Custom OpenAI-compatible endpoints can now explicitly choose `chat.completions` or `responses`, fixing the issue where `wire_api = "responses"` sends requests but produces no output
- **endpoint normalization** — Custom base URLs are now auto-completed to `/v1/chat/completions` or `/v1/responses` based on wire protocol, reducing endpoint ambiguity
- **responses SSE parser** — New parsing for `response.output_text.delta`, `response.function_call_arguments.*`, `response.completed` and other events; both text streams and tool calls land correctly
- **tool continuation** — `responses` mode now uses `previous_response_id + function_call_output` for continuation instead of incorrectly reusing chat history replay logic
- **sidebar config** — Control panel adds `OpenAI Wire API` dropdown, shown only for `custom + openai` to avoid polluting other provider configs

### v3.3.5 — Kimi Tool Chain Closure + Standard API Reasoning Fix

- **Kimi standard API continuation** — Fills in `reasoning_content` during `assistant + tool_calls` history replay, fixing Moonshot/Kimi second-turn continuation 400 errors
- **Kimi Coding / Anthropic tool chain** — Fills in `tool_call_id → tool_use_id` and `tool_name` mappings, fixing `tool_call_id is not found` / tool adjacency misalignment
- **timeline normalization** — Adds turn merge / adjacency stabilize / forward-vs-reversed scoring to reduce tool chain breakage from dirty history
- **thinking replay** — `<think>...</think>` and `thought_signature` in `kimi-anthropic` history are now replayed as Anthropic `thinking` blocks
- **known issues** — `api.kimi.com/coding/v1/messages` requires a valid Kimi Coding subscription; standard API `429 engine_overloaded_error` is an upstream capacity issue, not a local protocol error

### v3.3.4 — Continuity Fix + Protocol State Handling

- **continuation handling** — `"..."` is treated as a continuation signal without rewriting user message content
- **history projection** — Original `chat_history` is preserved; compressed results are written to `compressed_chat_history`
- **state endpoints** — `save-chat` / `record-*` / `context-canvas/list` upgraded with minimal state write and read logic
- **request serialization** — Requests for the same `conversation_id` are serialized through `state.conversationQueues`
- **runtime smoke** — Verified: `save-chat`, `record-session-events`, `record-user-events`, `record-request-events`, `context-canvas/list`, `generate-conversation-title`

### v3.1.4 — Agent Loop Fix + Task System Activation

**Critical Fixes**
- **Fixed Agent stopping after one operation** — Anthropic/OpenAI provider stop_reason logic was wrong: when AI returned tool calls (e.g., `view` to read a file), `stopReason === 'end_turn'` incorrectly terminated the conversation, preventing subsequent tasks from executing. Now only checks `toolCalls.length === 0`, consistent with Google provider
- **Fixed task list tools not working** — `view_tasklist`, `update_tasks`, `add_tasks`, `reorganize_tasklist` only had system prompt text descriptions but lacked JSON Schema tool definition injection. AI models couldn't see these tools in the API `tools` parameter. All three providers now inject complete schemas
- **Fixed Viking L0 context injection being silently dropped** — `proxy.ts` wrote Viking L0 to `augmentReq.system_prompt`, but `buildSystemPrompt()` never read that field, causing context to be silently discarded. Now correctly merged

### v3.1.0 — File Editing Engine Rewrite + Diff Rendering

**File Editing Engine Rewrite (Core Improvement)**
- **Fixed file editing termination bug** — AI calling apply_patch / str-replace-editor / save-file no longer disconnects; tool execution results are correctly fed back to AI for continued generation
- **Tri-provider loop architecture** — OpenAI / Anthropic / Google providers all refactored to loop mode: intercept tool → local execution → feed results back to AI → continue generation, up to 25 iterations
- **Forced precise editing** — save-file rejects existing files (REJECTED), forcing AI to use str-replace-editor / apply_patch for precise edits, eliminating full-file overwrites
- **New file local creation** — save-file creates new files locally (with recursive directory creation); apply_patch's `*** Create File:` sub-operations also execute correctly
- **System prompt injection** — Automatically injects `<file_editing_rules>` rule block, guiding AI to use correct editing tools at the prompt level

**Diff Rendering (Streaming Output)**
- Intercepted file editing operations render diffs in real-time in chat, instead of just showing `✅ apply_patch`
- Line-level diff (≤50 lines): shows `- deleted lines` / `+ added lines`, up to 12 lines each
- Large file overwrites (>50 lines): shows line count change summary `(1200 → 1250 lines)`
- New files: shows first 15 lines preview
- `renderDiffText()` unified rendering function shared across all three providers

**OpenViking Context Enhancement**
- Viking layered context system inspired by [OpenViking](https://github.com/volcengine/OpenViking)'s filesystem paradigm
- L0 summary / L1 structure / L2 full text, three tiers loaded on demand for precise token budget control
- Vector pre-filter → directory aggregation → top directory recursive drill-down, using structural signals to compensate for vector precision gaps
- Particularly significant improvement for weaker models' (GLM-5, etc.) code comprehension capabilities

### v3.0.1 — Stability Fixes

**Crash Protection**
- Fixed `augmentConfig.update()` repeated writes causing infinite window reloads
- Added OOM crash detection: when large model loading causes extension host crashes, automatically falls back to default small model (MiniLM-L6 22MB) on next startup
- Model initialization changed to background async (fire-and-forget), no longer blocks extension startup
- `deactivate()` no longer clears Augment config during auto-recovery scenarios

**Performance Optimization**
- Smart cache detection: already-downloaded models load directly from local, skipping download flow and progress callbacks
- Removed two oversized models (BGE-Large 335MB, E5-Base 278MB) to avoid OOM risk

**Bug Fixes**
- Fixed download progress bar jumping straight to 100% (transformers.js v3 status name change)
- Fixed checkbox settings (OMC/remote Embedding) not persisting
- Fixed `embedding.enabled` incorrectly blocking local model loading ("BM25 mode")
- Added HuggingFace mirror acceleration (hf-mirror.com)
- Added download cancellation
- Added cache corruption auto-detection, cleanup, and re-download

**UI Improvements**
- Sidebar refactored: local models (default) and remote Embedding API (optional) displayed in separate sections
- Added cancel download button

### v3.0.0 — Intelligent Context Engine

**Viking Layered Context System**
- Inspired by [OpenViking](https://github.com/volcengine/OpenViking)'s context database concept
- L0 summary (~100 tokens) / L1 structured (~2K tokens) / L2 full text, three tiers loaded on demand
- Vector pre-filter → directory aggregation → top directory recursive drill-down → result merge with weighting
- Structural filesystem signals compensate for vector precision gaps, particularly significant for weaker models

**Local Model Selection**
- Visual selection of 5 local embedding models (22MB–118MB) in the sidebar
- Runtime one-click model switching with automatic re-initialization
- Download progress bar showing filename and percentage
- Per-model cache files; switching doesn't lose historical data
- HuggingFace mirror acceleration (hf-mirror.com) for significantly faster downloads in China
- Download cancellation support; cache corruption auto-detection, cleanup, and re-download

**Session Memory — Long-Term Memory**
- Automatically extracts user preferences (programming language, framework, coding style) from messages
- Records Agent experiences and lessons learned
- LevelDB persistence for cross-session memory retention
- Auto-injected into System Prompt, giving AI long-term memory capabilities

**Remote Embedding API**
- Supports GLM embedding-3 / OpenAI text-embedding-3-small / custom API
- Remote API failure automatically falls back to local model
- Remote/local independent caches with no dimension conflicts

### v3.1.4
- 🔴 **Critical fix** — Agent stopping after one operation (stop_reason logic error)
- 🔧 **Task system activation** — Four task list tools injected with complete JSON Schema definitions
- 🔧 **Viking L0 context fix** — Context injection no longer silently dropped

### v3.1.1
- 🪟 **Windows compatibility fix** — `proxy.localhost` DNS resolution failure replaced with `127.0.0.1`, universal across platforms
- 🧠 **Sharp module compatibility fix** — Mock `sharp` module to avoid Windows native binding failures, ensuring local embedding models work

### v3.1.0
- 🔧 **File editing engine rewrite** — Fixed fatal bug where AI calling file editing tools terminated the connection; all three providers refactored to loop architecture
- 📊 **Diff rendering** — Intercepted file editing operations render diffs in real-time in chat
- 🎯 **Forced precise editing** — `save-file` rejects existing files, forcing AI to use `str-replace-editor`
- 🔍 **OpenViking context enhancement** — Viking L0/L1/L2 layered context with vector pre-filter + directory aggregation + recursive drill-down

### v3.0.1
- 🛡️ **Crash protection** — Fixed extension host crash loop, OOM protection, smart cache detection
- 🪞 **HuggingFace mirror** — Mirror-accelerated downloads
- 🎨 **UI optimization** — Sidebar local models and remote API displayed in separate sections

### v3.0.0
- 🧠 **Viking layered context** — L0 summary / L1 structured / L2 full text, three tiers loaded on demand
- 🧬 **Session Memory** — Long-term memory with automatic preference and experience extraction
- 🌐 **Remote Embedding API** — Supports GLM/OpenAI/custom API
- 📦 **5 local models** — MiniLM-L6/L12, BGE-Small/Base, E5-Multi-Small

### v2.1.5
- 🚀 **OMC orchestration** — Integrates oh-my-claudecode with 6 orchestration modes
- 🔮 **Magic keywords** — ultrawork/search/analyze/ultrathink auto-enhancement
- 🧠 **Embedding config UI** — Visual configuration in sidebar
- 🔧 Fixed config save race condition

### v2.1.4
- 🛠️ Full `apply_patch` tool support
- 🤖 GLM-5 support

### v2.1.0
- 🌙 Kimi (Moonshot) support + JSON Mode + web search

### v1.9.0
- 🚀 Zero-injection mode + full Agent mode + RAG semantic search + context compression

## License

MIT
