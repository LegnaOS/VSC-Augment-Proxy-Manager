# Augment Proxy Manager

[English Version](README.md)

**🚀 无需订阅，用第三方模型享受 Augment 的全部能力！**

将 Augment Code 的 API 请求代理到第三方 AI 供应商。使用你自己的 API 密钥，享受 Augment 强大的界面、Agent 能力和代码理解功能。

**支持平台: macOS / Windows / Linux**

---

## 📖 目录

- [工作原理](#-工作原理)
- [快速开始](#-快速开始)
- [支持的供应商](#-支持的供应商)
- [完整功能清单](#-完整功能清单)
- [详细配置](#-详细配置)
- [最佳实践](#-最佳实践)
- [故障排除](#-故障排除)
- [技术架构](#-技术架构)

---

## 🔧 工作原理

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Augment 插件 (UI界面)                        │
│     聊天面板 │ 代码补全 │ Agent模式 │ 工具调用 │ 代码搜索            │
└─────────────────────────────────────────────────────────────────────┘
                                │
                          ⬇️ 所有请求被拦截
                                │
┌─────────────────────────────────────────────────────────────────────┐
│                      本地代理服务器 (端口 8765)                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  请求拦截层                                                   │    │
│  │  - 模拟认证状态（永久Pro订阅）                                 │    │
│  │  - 消息格式转换（Anthropic↔OpenAI）                           │    │
│  │  - SSE流式响应处理                                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  本地RAG引擎                                                  │    │
│  │  - TF-IDF 代码索引                                            │    │
│  │  - SHA256 内容去重                                            │    │
│  │  - 增量更新（mtime缓存）                                       │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                │
                          ⬇️ 转发到你选择的AI
                                │
┌─────────────────────────────────────────────────────────────────────┐
│                      第三方 AI 供应商                                │
│      MiniMax │ Anthropic │ DeepSeek │ 智谱GLM │ OpenAI              │
└─────────────────────────────────────────────────────────────────────┘
```

**核心机制：**

1. **注入代码** 修改 Augment 扩展，将所有 API 请求重定向到 `localhost:8765`
2. **代理服务器** 模拟 Augment 认证状态，返回"已认证、Pro订阅"
3. **消息转发** 将聊天请求转换为目标供应商格式并转发
4. **本地RAG** 接管代码搜索请求，使用本地 TF-IDF 索引响应

---

## 🚀 快速开始

### 第一步：安装插件

1. 在 VSCode 扩展商店搜索并安装 **Augment** 官方插件
2. 安装 **Augment Proxy Manager** 插件（本插件）

### 第二步：注入代理

> ⚠️ 注入会修改 Augment 插件的 extension.js 文件，自动创建备份

#### macOS / Linux

1. 打开 VSCode 侧边栏的 **Augment Proxy** 面板
2. 点击 **「注入插件」** 按钮
3. 确认后等待注入完成
4. 按提示 **重载窗口** (`Cmd+Shift+P` → `Developer: Reload Window`)

#### Windows（需要特殊步骤）

Windows 上 VSCode 会锁定插件文件，必须完全关闭 VSCode 后注入：

1. **完全关闭 VSCode**（任务栏也要退出）
2. 打开 PowerShell，导航到插件目录：
   ```powershell
   cd $env:USERPROFILE\.vscode\extensions\legna.augment-proxy-manager-*
   ```
3. 首次运行需启用脚本执行（管理员权限）：
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
   ```
4. 运行注入脚本：
   ```powershell
   .\inject-windows.ps1
   ```
5. 启动 VSCode

### 第三步：配置 API Key

1. 在侧边栏选择 **AI 供应商**（如 DeepSeek、MiniMax）
2. 输入对应的 **API Key**
3. 点击 **保存**

### 第四步：启动代理

1. 点击 **「启动代理」** 按钮
2. 状态栏显示 `📡 Proxy ✓` 表示运行中
3. 现在可以正常使用 Augment 的所有功能了！

---

## 🤖 支持的供应商

| 供应商 | API 格式 | 默认模型 | 特点 |
|--------|----------|----------|------|
| **MiniMax** | Anthropic 兼容 | MiniMax-M2.2 | 国产首选，支持长上下文 |
| **DeepSeek** | Anthropic 兼容 | deepseek-chat | 高性价比，支持推理模式 |
| **Anthropic** | Anthropic 原生 | claude-sonnet-4-20250514 | Claude 原生 |
| **GLM (智谱)** | OpenAI 兼容 | glm-4.7 | 国产代码专用模型 |
| **OpenAI** | OpenAI 原生 | gpt-4 | GPT 系列 |
| **Google Gemini** | Google 原生 | gemini-3-pro-preview | 最新 Gemini 3.0，支持多模态 |
| **Custom** | 可选 | 自定义 | 任意兼容端点 |

### 供应商特别说明

**MiniMax**
- ✅ 支持 Prompt Cache（节省 Token）
- ✅ 支持扩展思维链
- ❌ 不支持图片/文档输入

**DeepSeek**
- ✅ 支持 `deepseek-reasoner` 推理模式
- ✅ 配置项：`augmentProxy.deepseek.enableThinking`

**Google Gemini**
- ✅ 支持多模态（图片理解）
- ✅ 提供免费配额
- ✅ 支持工具调用（Agent 模式）
- 📖 详细配置请参考 [Google Gemini 配置指南](GOOGLE_GEMINI_SETUP.md)

**Custom（自定义）**
- 支持任何 Anthropic 或 OpenAI 兼容的 API 端点
- 需配置 `augmentProxy.custom.format` 为 `anthropic` 或 `openai`

---

## ✨ 完整功能清单

### Augment 原生能力（完整支持）

| 功能 | 状态 | 说明 |
|------|------|------|
| 💬 **聊天对话** | ✅ | 多轮对话、上下文记忆 |
| 📝 **代码编辑** | ✅ | 智能重写、重构建议 |
| 🛠️ **Agent 模式** | ✅ | 自主执行多步骤任务 |
| 🔧 **工具调用** | ✅ | 文件操作、终端命令、浏览器 |
| 📄 **Smart Paste** | ✅ | 智能粘贴格式转换 |
| 🔍 **代码搜索** | ✅ | 本地 RAG 替代云端 |
| 📊 **流式输出** | ✅ | 实时 SSE 响应 |

### 本地增强能力

| 功能 | 说明 |
|------|------|
| 🗂️ **本地代码索引** | TF-IDF + SHA256 去重，无需云端同步 |
| ⚡ **增量更新** | 基于 mtime 缓存，只索引变更文件 |
| 🔒 **完全离线** | 代码永不上传，保护隐私 |
| 🔄 **自动恢复** | 注入自动创建备份，一键还原 |

### 不可用功能

| 功能 | 原因 |
|------|------|
| ❌ 代码补全 (Tab) | 需要 Augment 专有模型 |
| ❌ 远程 MCP 工具 | 需要 Augment 云服务 |
| ❌ 云端代码同步 | 被本地 RAG 替代 |

---

## ⚙️ 详细配置

### VSCode 设置

在 `settings.json` 中配置：

```jsonc
{
  // 选择 AI 供应商
  "augmentProxy.provider": "deepseek",

  // 代理端口（默认 8765）
  "augmentProxy.port": 8765,

  // DeepSeek 配置
  "augmentProxy.deepseek.baseUrl": "https://api.deepseek.com/anthropic/v1/messages",
  "augmentProxy.deepseek.model": "deepseek-chat",
  "augmentProxy.deepseek.enableThinking": true,

  // MiniMax 配置
  "augmentProxy.minimax.baseUrl": "https://api.minimaxi.com/anthropic/v1/messages",
  "augmentProxy.minimax.model": "MiniMax-M2.2",

  // 自定义端点配置
  "augmentProxy.custom.baseUrl": "https://your-api.com/v1/messages",
  "augmentProxy.custom.model": "your-model",
  "augmentProxy.custom.format": "anthropic"  // 或 "openai"
}
```

### 命令面板

按 `Cmd+Shift+P`（Windows: `Ctrl+Shift+P`）可执行：

| 命令 | 说明 |
|------|------|
| `Augment Proxy: Start Proxy Server` | 启动代理服务器 |
| `Augment Proxy: Stop Proxy Server` | 停止代理服务器 |
| `Augment Proxy: Configure API Provider` | 配置供应商 |
| `Augment Proxy: Inject Plugin` | 注入插件 |
| `Augment Proxy: Restore Original Plugin` | 恢复原始插件 |
| `Augment Proxy: Show Status` | 显示详细状态 |

---

## 💡 最佳实践

### 1. 选择合适的模型

```
日常编程 → DeepSeek Chat（性价比高）
复杂推理 → DeepSeek Reasoner（深度思考）
长上下文 → MiniMax M2.2（200K 上下文）
最高质量 → Claude Sonnet（需自有API）
```

### 2. 优化代码搜索

本地 RAG 索引会自动扫描工作区，以下类型会被索引：
- 代码文件：`.ts`, `.js`, `.py`, `.go`, `.rs`, `.java` 等
- 配置文件：`.json`, `.yaml`, `.toml` 等
- 文档：`.md`, `.txt`

**排除的目录**：`node_modules`, `.git`, `dist`, `build`, `__pycache__` 等

### 3. 调试技巧

打开 DevTools Console（`Help > Toggle Developer Tools`），可以使用：

```javascript
// 查看代理状态
__AUGMENT_PROXY__.status()

// 临时禁用代理（回退到原始请求）
__AUGMENT_PROXY__.disable()

// 重新启用
__AUGMENT_PROXY__.enable()

// 开启调试日志
__AUGMENT_PROXY__.setDebug(true)
```

### 4. Augment 更新后

Augment 插件更新后会覆盖注入代码，需要：
1. 点击 **「恢复原始」** 清理旧备份
2. 重新点击 **「注入插件」**
3. 重载窗口

---

## 🔧 故障排除

### 问题：注入失败 (EACCES permission denied)

**macOS / Linux:**
```bash
# 修复权限
chmod 644 ~/.vscode/extensions/augment.vscode-augment-*/out/extension.js
```

**Windows:**
必须完全关闭 VSCode 后使用 `inject-windows.ps1` 脚本。

### 问题：Could not register service worker

清除 VSCode 缓存：

**Windows:**
```powershell
Remove-Item -Recurse -Force "$env:APPDATA\Code\CachedData"
```

**macOS:**
```bash
rm -rf ~/Library/Application\ Support/Code/CachedData
```

**Linux:**
```bash
rm -rf ~/.config/Code/CachedData
```

### 问题：代理连接失败

1. 检查代理是否启动（状态栏显示 `📡 Proxy ✓`）
2. 检查端口是否被占用：
   ```bash
   lsof -i :8765  # macOS/Linux
   netstat -ano | findstr 8765  # Windows
   ```
3. 查看输出日志：`View > Output > Augment Proxy`

### 问题："not yet fully synced" 警告

这是正常的！因为我们没有使用 Augment 云端同步，本地 RAG 会接管代码搜索。

### 问题：聊天无响应

1. 确认 API Key 已正确配置
2. 检查网络是否能访问 AI 供应商
3. 查看 Output 日志中的错误信息

---

## 🏗️ 技术架构

### 项目结构

```
augment-proxy-vscode/
├── src/
│   ├── extension.ts      # 主入口，包含代理服务器和注入逻辑
│   └── rag/
│       └── index.ts      # 本地 RAG 引擎
├── injection.js          # 精简版注入代码模板
├── inject-windows.ps1    # Windows 专用注入脚本
└── package.json          # 扩展配置
```

### 核心组件

**1. 代理服务器 (handleProxyRequest)**
- 监听 `localhost:8765`
- 路由所有 Augment API 端点
- 处理消息格式转换

**2. 注入代码 (generateInjectionCode)**
- 拦截 `fetch` 和 `http.request`
- 重定向 `*.augmentcode.com` → `localhost:8765`
- 模拟认证状态

**3. RAG 引擎 (RAGContextIndex)**
- `MtimeCache`: 修改时间缓存
- `BlobStorage`: SHA256 内容去重
- `TFIDFEngine`: 文本相关性搜索

### 支持的 API 端点

| 端点 | 功能 | 处理方式 |
|------|------|----------|
| `/chat-stream` | 聊天对话 | 转发到 AI 供应商 |
| `/instruction-stream` | 指令执行 | 转发到 AI 供应商 |
| `/agents/codebase-retrieval` | 代码搜索 | 本地 RAG 响应 |
| `/getPluginState` | 认证状态 | 返回模拟状态 |
| `/completion` | 代码补全 | 返回空（不支持） |
| `/batch-upload` | 文件上传 | 返回成功（本地忽略） |

---

## 📜 许可证

MIT

---

## 🙏 致谢

感谢 Augment 团队创造了如此优秀的代码助手界面和 Agent 能力。本项目仅用于学习和个人使用，不鼓励任何商业用途。

