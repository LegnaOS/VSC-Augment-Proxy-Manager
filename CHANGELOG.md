# Changelog

All notable changes to the Augment Proxy Manager extension will be documented in this file.

## [2.1.0] - 2026-02-10

### ✨ New Features
- **Kimi (月之暗面) API Support**: Added support for Moonshot AI's Kimi API
  - OpenAI-compatible API format
  - Default model: `moonshot-v1-auto`
  - Default endpoint: `https://api.moonshot.cn/v1/chat/completions`
- **JSON Mode Support**: Added support for Kimi API's structured JSON output mode
  - Supports `response_format: {"type": "json_object"}` parameter
  - Automatically passed through from Augment requests to Kimi API
  - Enables reliable structured data extraction
- **Web Search Support**: Added support for Kimi's built-in `$web_search` function
  - Supports `type: "builtin_function"` tool type
  - Automatically intercepts and returns arguments to Kimi for execution
  - Enables AI to perform web searches without custom implementation

### 🐛 Bug Fixes
- **Debug log cleanup**: Removed excessive debug logging from OpenAI message construction
- **Tool definition filtering**: Removed `edit-file` from tool definitions sent to AI models to prevent wasted round trips
- **File editing interruption fix**: Fixed issue where file editing operations would cause conversation to be interrupted instead of continuing

## [2.0.0] - 2026-02-10

### 🎉 Major Release - Complete File Editing Overhaul

This release represents a complete rewrite of the file editing interception system based on deep reverse engineering of the Augment VS Code extension (v0.778.0).

### ✨ New Features

#### Advanced `str-replace-editor` Implementation
- **Multi-entry replacements**: Support for `old_str_1`/`new_str_1`, `old_str_2`/`new_str_2`, etc. (up to 20 entries)
- **Three-tier matching algorithm**:
  1. Exact verbatim matching
  2. Line number-based disambiguation (with 20% tolerance)
  3. Basic fuzzy matching (trimmed line matching)
- **Insert command support**: `insert` command for adding content at specific line numbers
- **Line ending preservation**: Automatically detects and preserves original line endings (CRLF/LF)

#### Unified Tool Interception Architecture
- **All providers now support interception**: Anthropic, OpenAI, and Google providers all use the same interception logic
- **Proper result handling**: Intercepted tool results are correctly returned to the AI as `tool_result_node` (type 1)
- **Consistent behavior**: All providers now handle file editing tools identically

### 🔧 Improvements

#### `edit-file` Tool Handling
- **Changed from conversion to error**: Previously converted to `view` tool (wasting a round trip)
- **Now returns clear error**: Instructs AI to use `str-replace-editor` instead
- **Better user experience**: AI immediately knows to use the correct tool

#### Provider-Specific Enhancements
- **Anthropic provider**: Added `convertOrInterceptFileEdit` call in `tool_use` completion handler
- **Google provider**: Added `fixToolCallInput` and `convertOrInterceptFileEdit` in `functionCall` handler
- **OpenAI provider**: Fixed intercepted result handling to return `tool_result_node` instead of `null`

### 🐛 Bug Fixes
- Fixed issue where intercepted tools would not return results to the AI
- Fixed single-replacement limitation in `str-replace-editor`
- Fixed missing line number disambiguation
- Fixed lack of fuzzy matching fallback

### 📚 Technical Details

Based on reverse engineering analysis of Augment extension's implementation:
- `PC` class (str-replace-editor): Complete implementation including `handleStrReplace`, `handleInsert`, `singleStrReplace`
- `g$e` class (edit-file): Server-side API call mechanism
- Checkpoint system: `addCheckpoint()` → `qt().writeFile()` → `WorkspaceEdit.replace()`
- Line ending handling: `OD()` normalization, `JX()` detection, `sUe()` restoration

### 🔄 Breaking Changes
- `edit-file` tool now returns an error instead of converting to `view`
- `processToolCallForAugment` now returns `tool_result_node` for intercepted tools instead of `null`

### 📦 Files Changed
- `src/tools.ts`: Complete rewrite of `convertOrInterceptFileEdit` function
- `src/providers/anthropic.ts`: Added interception logic
- `src/providers/google.ts`: Added interception logic
- `src/providers/openai.ts`: Fixed intercepted result handling

---

## [1.9.1] - Previous Release

Previous version with basic file editing support.

