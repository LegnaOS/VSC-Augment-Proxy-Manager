# Release v2.1.0: Kimi API JSON Mode and Web Search Support

## 🎉 What's New

### ✨ Kimi API Advanced Features

This release adds full support for Kimi (Moonshot AI) API's advanced features, bringing the total Kimi API support to **100%** for core functionality!

#### 1️⃣ JSON Mode Support
- **Structured Output**: Force Kimi to output valid, parseable JSON
- **Use Cases**: Data extraction, structured responses, API integration
- **Implementation**: Automatic `response_format` parameter passthrough
- **Example**:
  ```json
  {
    "response_format": {"type": "json_object"},
    "messages": [
      {"role": "system", "content": "Output JSON: {\"name\": \"...\", \"age\": ...}"},
      {"role": "user", "content": "我叫张三，今年25岁"}
    ]
  }
  ```

#### 2️⃣ Web Search Support
- **Built-in Search**: Use Kimi's native `$web_search` function
- **Zero Configuration**: No need to implement search/crawl functions
- **Automatic Handling**: Proxy intercepts and returns arguments to Kimi
- **Example**:
  ```json
  {
    "tools": [{
      "type": "builtin_function",
      "function": {"name": "$web_search"}
    }]
  }
  ```

### 🐛 Bug Fixes

#### Debug Log Cleanup
- Removed excessive debug logging from OpenAI message construction
- Cleaner console output for better debugging experience

#### Tool Definition Filtering
- Removed `edit-file` from tool definitions sent to AI models
- Prevents wasted round trips when AI tries to use unsupported tools
- AI now directly uses `str-replace-editor` for file editing

#### File Editing Interruption Fix
- Fixed issue where file editing operations would cause conversation to be interrupted
- Conversation now continues properly after intercepted tool execution
- Correct `stop_reason` handling (3 instead of 1)

## 📊 Kimi API Support Matrix

| Feature | Support | Notes |
|:--------|:--------|:------|
| **Streaming** | ✅ 100% | SSE format, [DONE] terminator, streaming tool_calls |
| **Tool Calls** | ✅ 100% | Parallel calls, index field, arguments accumulation |
| **Thinking Mode** | ✅ 100% | reasoning_content field support |
| **JSON Mode** | ✅ 100% | response_format parameter support |
| **Web Search** | ✅ 100% | $web_search builtin_function support |
| **Partial Mode** | ⚠️ 50% | Theoretical support, depends on Augment |
| **File Interface** | ❌ 0% | Not in proxy scope |
| **Token Calculation** | ❌ 0% | Not in proxy scope |
| **Balance Query** | ❌ 0% | Not in proxy scope |

**Core Functionality**: ✅ **100%**  
**Advanced Features**: ✅ **83.3%** (5/6)

## 🔧 Technical Details

### Modified Files
- `src/providers/openai.ts`: Added `responseFormat` parameter support
- `src/tools.ts`: Added `builtin_function` type support and `$web_search` interception
- `src/config.ts`: Added Kimi provider configuration
- `package.json`: Updated version to 2.1.0
- `README.md`: Added JSON Mode and Web Search feature descriptions
- `CHANGELOG.md`: Documented all changes

### Implementation Highlights

**JSON Mode**:
```typescript
// Automatically extracts and passes response_format to Kimi API
const responseFormat = augmentReq.response_format || undefined;
if (responseFormat) {
    requestBody.response_format = responseFormat;
}
```

**Web Search**:
```typescript
// Intercepts $web_search and returns arguments as-is for Kimi to execute
if (toolName === '$web_search') {
    return {
        toolName,
        input,
        intercepted: true,
        result: input  // Return arguments unchanged
    };
}
```

## 📦 Installation

Download `augment-proxy-manager-2.1.0.vsix` and install via:
- VSCode: Extensions → Install from VSIX
- Command line: `code --install-extension augment-proxy-manager-2.1.0.vsix`

## 🚀 Upgrade Notes

No breaking changes. Simply update to v2.1.0 to get all new features.

## 📝 Full Changelog

See [CHANGELOG.md](CHANGELOG.md) for complete version history.

---

**Previous Release**: [v2.0.0](https://github.com/LegnaOS/VSC-Augment-Proxy-Manager/releases/tag/v2.0.0)  
**Repository**: [LegnaOS/VSC-Augment-Proxy-Manager](https://github.com/LegnaOS/VSC-Augment-Proxy-Manager)

