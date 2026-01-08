# Augment Proxy Manager

Proxy Augment Code API requests to other AI providers.

**Supported Platforms: macOS / Windows / Linux**

## Supported Providers

| Provider | API Format | Default Model |
|----------|------------|---------------|
| **MiniMax** | Anthropic Compatible | MiniMax-M2.2 |
| **Anthropic** | Anthropic Native | claude-sonnet-4-20250514 |
| **DeepSeek** | Anthropic Compatible | deepseek-chat |
| **GLM (Zhipu)** | OpenAI Compatible | glm-4.7 |
| **OpenAI** | OpenAI Native | gpt-4 |
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

- ✅ Streaming Response (SSE)
- ✅ Tool Use / Function Calling
- ✅ Multi-turn Conversation
- ✅ One-click Inject/Restore Augment Plugin
- ✅ Sidebar Control Panel

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

**Method 1: Standalone Script (Recommended)**

1. **Close VSCode completely** (required!)
2. **Run PowerShell as Administrator**
3. Execute the injection script:

```powershell
# Navigate to extension directory
cd "$env:USERPROFILE\.vscode\extensions\augment-proxy.augment-proxy-manager-*"

# Run injection script
.\inject-windows.ps1
```

4. Start VSCode and enable the proxy server

**Method 2: Run VSCode as Administrator**

1. Close all VSCode windows completely
2. Right-click VSCode icon → Select "Run as administrator"
3. Open project and click "Inject Plugin"

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
