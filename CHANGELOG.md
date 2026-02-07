# Changelog

All notable changes to the Augment Proxy Manager extension will be documented in this file.

## [1.8.1] - 2026-02-07

### Fixed
- **Critical timeout fix**: Added 90-second timeout on API requests to prevent 100-second timeout errors from Augment extension
- **Improved error handling**: API response errors now properly close the response stream
- **Better error logging**: Enhanced error messages with stack traces for easier debugging
- **Graceful failure**: Proxy now fails gracefully with clear error messages instead of hanging

### Technical Details
- Added `setTimeout(90000)` on outgoing API requests to AI providers
- Added error handler for API response streams to ensure responses are always closed
- Improved main error handler to guarantee response closure even when headers were already sent
- All error scenarios now properly send end markers to prevent client-side timeouts

### Documentation
- Added `TIMEOUT_FIX.md` with detailed explanation of the timeout issue and fixes
- Added `test-proxy.sh` diagnostic script for testing proxy endpoints

## [1.8.0] - Previous Release

### Features
- Support for multiple AI providers (MiniMax, Anthropic, DeepSeek, GLM, OpenAI, Google Gemini)
- Local RAG-based codebase search
- Streaming responses with tool use support
- Context compression for large conversations
- Sidebar control panel for easy configuration

