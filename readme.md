# Augment Proxy Manager

[中文版本](README_zh.md)

Proxy Augment Code API requests to other AI providers. Use Augment's powerful UI and agent capabilities with your own API keys.

**Supported Platforms: macOS / Windows / Linux**

## Supported Providers

| Provider | API Format | Default Model |
|----------|------------|---------------|
| **MiniMax** | Anthropic Compatible | MiniMax-M2.2 |
| **Anthropic** | Anthropic Native | claude-sonnet-4-20250514 |
| **DeepSeek** | Anthropic Compatible | deepseek-chat |
| **GLM (Zhipu)** | OpenAI Compatible | glm-4.7 |
| **OpenAI** | OpenAI Native | gpt-4 |
| **Google Gemini** | Google Native | gemini-3-pro-preview |
| **Custom** | Anthropic/OpenAI | - |

## Usage

### 1. Inject Plugin
Click "Inject Plugin" in the sidebar to patch the Augment extension with proxy endpoint.

### 2. Configure API Key
Select a provider and enter the corresponding API Key.

### 3. Start Proxy
Click "Start Proxy" to run the local proxy server at `127.0.0.1:8765`.

### 4. Reload Window
Press `Cmd+Shift+P` → `Developer: Reload Window` to apply the injection.

## Features

- ✅ **Streaming Response** - Real-time SSE streaming
- ✅ **Tool Use / Function Calling** - Full agent capabilities
- ✅ **Multi-turn Conversation** - Context-aware chat
- ✅ **Local Code Index** - Bypass cloud sync, use local codebase search
- ✅ **One-click Inject/Restore** - Easy Augment plugin patching
- ✅ **Sidebar Control Panel** - Intuitive UI for configuration

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `augmentProxy.provider` | AI Provider | `anthropic` |
| `augmentProxy.port` | Proxy Port | `8765` |
| `augmentProxy.{provider}.baseUrl` | API Endpoint | Provider default |
| `augmentProxy.{provider}.model` | Model Name | Provider default |

## Commands

- `Augment Proxy: Start Proxy Server`
- `Augment Proxy: Stop Proxy Server`
- `Augment Proxy: Configure API Provider`
- `Augment Proxy: Inject Plugin`
- `Augment Proxy: Restore Original Plugin`

## Notes

- MiniMax does not support image/document input
- Reload VSCode window after injection
- API Keys are stored in VSCode SecretStorage
- The "not yet fully synced" warning can be ignored - local search is used instead

## Troubleshooting

### Injection Failed: EACCES permission denied

If injection fails due to permission issues, modify the Augment plugin file permissions first.

#### macOS / Linux

```bash
# Find Augment plugin version
ls ~/.vscode/extensions/ | grep augment.vscode-augment

# Fix permissions (replace X.XXX.X with actual version)
chmod 644 ~/.vscode/extensions/augment.vscode-augment-X.XXX.X/out/extension.js

# Or fix all versions at once
chmod 644 ~/.vscode/extensions/augment.vscode-augment-*/out/extension.js
```

#### Windows

VSCode process locks files on Windows. Use the standalone injection script:

**Method: Standalone Script (Recommended)**

1. **Install Augment and Augment Proxy Manager extensions in VSCode**
2. **Close VSCode completely** (required!)
3. **Open File Explorer** and navigate to:
   ```
   %userprofile%\.vscode\extensions\legna.augment-proxy-manager-0.7.34
   ```
4. **Enable PowerShell script execution** (run PowerShell as Administrator once):
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned
   ```
5. **Run the injection script**: Double-click `inject-windows.ps1` or run in PowerShell:
   ```powershell
   .\inject-windows.ps1
   ```
6. **Start VSCode** and enable the proxy server from the sidebar

### Error loading webview: Could not register service worker

This is caused by corrupted VSCode cache. Clear the cache to fix.

#### Windows

```powershell
# 1. Close VSCode completely
# 2. Delete cache directory
Remove-Item -Recurse -Force "$env:APPDATA\Code\CachedData"
# 3. Reopen VSCode
```

#### macOS

```bash
# 1. Close VSCode completely
# 2. Delete cache directory
rm -rf ~/Library/Application\ Support/Code/CachedData
# 3. Reopen VSCode
```

#### Linux

```bash
# 1. Close VSCode completely
# 2. Delete cache directory
rm -rf ~/.config/Code/CachedData
# 3. Reopen VSCode
```

## License

MIT
