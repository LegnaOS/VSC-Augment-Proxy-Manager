# Augment Proxy Manager

[English Version](README.md)

将 Augment Code 的 API 请求代理到其他 AI 供应商。使用你自己的 API 密钥，享受 Augment 强大的界面和代理能力。

**支持平台: macOS / Windows / Linux**

## 支持的供应商

| 供应商 | API 格式 | 默认模型 |
|--------|----------|----------|
| **MiniMax** | Anthropic 兼容 | MiniMax-M2.2 |
| **Anthropic** | Anthropic 原生 | claude-sonnet-4-20250514 |
| **DeepSeek** | Anthropic 兼容 | deepseek-chat |
| **GLM (智谱)** | OpenAI 兼容 | glm-4.7 |
| **OpenAI** | OpenAI 原生 | gpt-4 |
| **Custom** | Anthropic/OpenAI | - |

## 使用方法

### 1. 注入插件
在侧边栏点击"注入插件"，将代理端点注入到 Augment 扩展中。

### 2. 配置 API Key
选择供应商并输入对应的 API Key。

### 3. 启动代理
点击"启动代理"，在 `127.0.0.1:8765` 运行本地代理服务器。

### 4. 重新加载窗口
按 `Cmd+Shift+P` → `Developer: Reload Window` 使注入生效。

## 功能特性

- ✅ **流式响应** - 实时 SSE 流式输出
- ✅ **工具调用** - 完整的 Agent 能力支持
- ✅ **多轮对话** - 上下文感知的聊天
- ✅ **本地代码索引** - 绕过云端同步，使用本地代码搜索
- ✅ **一键注入/恢复** - 简单的 Augment 插件修补
- ✅ **侧边栏控制面板** - 直观的配置界面

## 配置选项

| 设置 | 描述 | 默认值 |
|------|------|--------|
| `augmentProxy.provider` | AI 供应商 | `anthropic` |
| `augmentProxy.port` | 代理端口 | `8765` |
| `augmentProxy.{provider}.baseUrl` | API 端点 | 供应商默认 |
| `augmentProxy.{provider}.model` | 模型名称 | 供应商默认 |

## 命令

- `Augment Proxy: Start Proxy Server` - 启动代理服务器
- `Augment Proxy: Stop Proxy Server` - 停止代理服务器
- `Augment Proxy: Configure API Provider` - 配置 API 供应商
- `Augment Proxy: Inject Plugin` - 注入插件
- `Augment Proxy: Restore Original Plugin` - 恢复原始插件

## 注意事项

- MiniMax 不支持图片/文档输入
- 注入后需要重新加载 VSCode 窗口
- API Key 存储在 VSCode SecretStorage 中
- "not yet fully synced" 警告可以忽略 - 使用本地搜索代替

## 故障排除

### 注入失败: EACCES permission denied

如果因权限问题注入失败，需要先修改 Augment 插件文件权限。

#### macOS / Linux

```bash
# 查找 Augment 插件版本
ls ~/.vscode/extensions/ | grep augment.vscode-augment

# 修复权限（将 X.XXX.X 替换为实际版本）
chmod 644 ~/.vscode/extensions/augment.vscode-augment-X.XXX.X/out/extension.js

# 或一次性修复所有版本
chmod 644 ~/.vscode/extensions/augment.vscode-augment-*/out/extension.js
```

#### Windows

Windows 上 VSCode 进程会锁定文件，请使用独立注入脚本：

**方法：独立脚本（推荐）**

1. **在 VSCode 中安装 Augment 和 Augment Proxy Manager 扩展**
2. **完全关闭 VSCode**（必须！）
3. **打开文件资源管理器**，导航到：
   ```
   %userprofile%\.vscode\extensions\legna.augment-proxy-manager-0.7.34
   ```
4. **启用 PowerShell 脚本执行**（以管理员身份运行 PowerShell 一次）：
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned
   ```
5. **运行注入脚本**：双击 `inject-windows.ps1` 或在 PowerShell 中运行：
   ```powershell
   .\inject-windows.ps1
   ```
6. **启动 VSCode** 并从侧边栏启用代理服务器

### 错误: Could not register service worker

这是由 VSCode 缓存损坏导致的，清除缓存即可解决。

#### Windows

```powershell
# 1. 完全关闭 VSCode
# 2. 删除缓存目录
Remove-Item -Recurse -Force "$env:APPDATA\Code\CachedData"
# 3. 重新打开 VSCode
```

#### macOS

```bash
# 1. 完全关闭 VSCode
# 2. 删除缓存目录
rm -rf ~/Library/Application\ Support/Code/CachedData
# 3. 重新打开 VSCode
```

#### Linux

```bash
# 1. 完全关闭 VSCode
# 2. 删除缓存目录
rm -rf ~/.config/Code/CachedData
# 3. 重新打开 VSCode
```

## 许可证

MIT

