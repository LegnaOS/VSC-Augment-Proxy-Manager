<br />

<div align="center">

# Augment Proxy Manager

**用任意 AI 供应商驱动 Augment 的强大编码 Agent。**

零注入 · 零登录 · 零配置

[![Version](https://img.shields.io/badge/version-3.1.1-blue.svg)](https://github.com/LegnaOS/VSC-Augment-Proxy-Manager)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)]()

</div>

---

## 工作原理

Augment Proxy Manager 运行一个本地 HTTP 代理服务器，拦截 Augment 扩展的 API 请求并转发到你选择的 AI 供应商。

```
Augment 扩展  →  本地代理 (:8765)  →  你的 AI 供应商 API
                  ↑ 自动配置          ↑ Viking 上下文增强
```

启动代理时，自动设置 `augment.advanced.completionURL` 指向本地代理，`augment.advanced.apiToken` 为占位 token。Augment 扩展检测到配置变更后，切换到 API Token 模式（绕过 OAuth），所有流量通过代理转发。停止代理时，自动清除配置，扩展恢复正常。

## 支持的供应商

| 供应商 | 协议格式 | 默认模型 |
|:-------|:--------|:---------|
| **Anthropic** | 原生 | `claude-sonnet-4-20250514` |
| **MiniMax** | Anthropic 兼容 | `MiniMax-M2.2` |
| **DeepSeek** | Anthropic 兼容 | `deepseek-chat` |
| **Google Gemini** | Google 原生 | `gemini-3-pro-preview` |
| **OpenAI** | 原生 | `gpt-4` |
| **GLM (智谱)** | OpenAI 兼容 | `glm-5` |
| **Kimi (月之暗面)** | OpenAI 兼容 | `moonshot-v1-auto` |
| **自定义** | Anthropic / OpenAI | — |

## 快速开始

1. **安装**本扩展，同时安装官方 [Augment](https://marketplace.visualstudio.com/items?itemName=augment.vscode-augment) 扩展
2. 在侧边栏面板中**选择供应商**并输入 API Key
3. **启动代理** — 其他全部自动完成

就这样。无需注入、无需重载、无需登录。

## 功能特性

### 🧠 v3.0 — 智能上下文引擎

- **Viking 分层上下文** — 借鉴 [OpenViking](https://github.com/volcengine/OpenViking) 的文件系统范式，L0 摘要 / L1 结构 / L2 全文三级按需加载，精准控制注入 token 量
- **目录聚合 + 递归下钻** — 向量初筛 → 目录级聚合 → Top 目录递归下钻，用结构化信号弥补向量精度不足
- **Session Memory** — 自动从对话中提取用户偏好（语言/框架/代码风格），LevelDB 持久化，跨会话长期记忆
- **本地模型选择** — 侧边栏可视化选择 5 种本地 Embedding 模型（22MB ~ 118MB），支持运行时切换，下载进度实时显示
- **远程 Embedding API** — 支持 GLM / OpenAI / 自定义远程 Embedding，远程失败自动回退本地
- **HuggingFace 镜像加速** — 内置 hf-mirror.com 国内镜像，模型下载速度大幅提升
- **下载取消 + 缓存自动修复** — 支持取消正在进行的模型下载；检测到缓存损坏自动清理并重新下载
- **智能缓存检测** — 已下载的模型直接从本地加载，不重复检查下载
- **OOM 崩溃防护** — 大模型加载导致 extension host 崩溃时，自动回退到默认小模型

### 🔌 代理核心

- **零注入绕过** — 自动配置 Augment 使用代理，无需修改任何代码
- **流式响应** — 聊天、补全、指令全程实时 SSE 流式传输
- **完整 Agent 模式** — 工具调用、文件编辑、代码库检索全部正常工作
- **配置热更新** — 切换供应商或模型无需重启代理，实时生效

### 🔍 RAG 语义搜索

- **本地代码索引** — 内置 RAG 语义搜索，无需云端同步
- **5 种 Embedding 模型** — MiniLM / BGE / E5 系列，含多语言模型，侧边栏一键下载切换
- **模型专属缓存** — 不同模型独立缓存文件，切换模型不丢失历史缓存

### ⚡ 增强功能

- **OMC 编排增强** — 集成 [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)，6 种编排模式 + 魔法关键词
- **思考模式** — 支持 DeepSeek、MiniMax、GLM 的扩展思考 (Thinking)
- **Prompt 缓存** — 自动为支持的供应商注入 cache_control
- **上下文压缩** — 基于 token 使用率的智能对话历史压缩
- **侧边栏控制面板** — 可视化界面管理全部配置和运行状态

## 本地 Embedding 模型

v3.0 支持在侧边栏选择并下载本地 Embedding 模型，无需配置远程 API 即可使用语义搜索：

| 模型 | 大小 | 维度 | 语言 | 说明 |
|:-----|:-----|:-----|:-----|:-----|
| MiniLM-L6 | 22MB | 384 | English | 最小最快，基础语义搜索 |
| MiniLM-L12 | 33MB | 384 | English | 12 层，比 L6 更准 |
| BGE-Small | 33MB | 384 | English | BAAI BGE 小模型，代码搜索效果好 |
| **BGE-Base** ⭐ | 109MB | 768 | English | 性价比最高，推荐 |
| E5-Multi-Small | 118MB | 384 | 多语言 | 支持中/英/日/韩 |

模型基于 [Xenova/transformers.js](https://github.com/xenova/transformers.js) ONNX 格式，首次使用自动下载到本地缓存。

## 配置项

| 设置项 | 默认值 | 说明 |
|:-------|:------|:-----|
| `augmentProxy.provider` | `anthropic` | AI 供应商 |
| `augmentProxy.port` | `8765` | 代理服务器端口 |
| `augmentProxy.enableContextCompression` | `true` | 启用智能上下文压缩 |
| `augmentProxy.compressionThreshold` | `80` | 压缩触发阈值 (%) |
| `augmentProxy.{provider}.baseUrl` | *按供应商* | API 端点地址 |
| `augmentProxy.{provider}.model` | *按供应商* | 模型名称 |
| `augmentProxy.omc.enabled` | `false` | 启用 OMC 编排增强 |
| `augmentProxy.omc.mode` | `team` | OMC 编排模式 |
| `augmentProxy.embedding.localModel` | `Xenova/all-MiniLM-L6-v2` | 本地 Embedding 模型 |
| `augmentProxy.embedding.enabled` | `false` | 启用远程 Embedding API |
| `augmentProxy.embedding.provider` | `glm` | 远程 Embedding 供应商 |
| `augmentProxy.embedding.mirror` | `""` | HuggingFace 下载镜像 (hf-mirror.com) |

各供应商的专属选项（思考模式、缓存等）在设置中 `augmentProxy.{provider}.*` 下配置。

API Key 安全存储在 VSCode 内置的 SecretStorage 中。

## 架构

```
src/
├── extension.ts          # 扩展入口
├── proxy.ts              # HTTP 代理服务器 + 初始化
├── messages.ts           # Augment 协议解析 + System Prompt 注入
├── sidebar.ts            # 侧边栏 Webview UI
├── config.ts             # 供应商配置
├── globals.ts            # 全局状态 (Viking/SessionMemory/RAG/Embedding)
├── context-manager.ts    # 上下文管理
├── context-compression.ts # 智能压缩
├── injection.ts          # Augment 扩展自动配置
├── omc.ts                # OMC 编排增强
├── tools.ts              # 工具调用处理
├── providers/
│   ├── anthropic.ts      # Anthropic 流式转发
│   ├── openai.ts         # OpenAI 流式转发
│   └── google.ts         # Google Gemini 流式转发
└── rag/
    ├── index.ts           # RAG 索引 + Viking 增强搜索
    ├── embeddings.ts      # Embedding 引擎 (本地 5 模型 + 远程 API)
    ├── viking-context.ts  # Viking L0/L1/L2 分层上下文
    ├── session-memory.ts  # Session Memory 长期记忆
    ├── code-parser.ts     # 代码解析器
    ├── context-generator.ts # 上下文生成
    └── storage.ts         # LevelDB 持久化存储
```

## 跨平台支持

| 编辑器 | macOS / Linux | Windows |
|:------|:-------------|:--------|
| VSCode | `~/.vscode/extensions` | `%USERPROFILE%\.vscode\extensions` |
| VSCode Insiders | `~/.vscode-insiders/extensions` | `%APPDATA%\Code - Insiders\extensions` |
| Cursor | `~/.cursor/extensions` | `%USERPROFILE%\.cursor\extensions` |
| Windsurf | `~/.windsurf/extensions` | `%USERPROFILE%\.windsurf\extensions` |

## 更新日志

### v3.1.0 — 文件编辑引擎重构 + Diff 渲染

**🔧 文件编辑引擎重构（核心改进）**
- **修复文件编辑终止 bug** — AI 调用 apply_patch / str-replace-editor / save-file 后不再直接断开连接，工具执行结果正确回传给 AI 继续生成
- **三 Provider 循环架构** — OpenAI / Anthropic / Google 三个 Provider 全部重构为循环模式：拦截工具 → 本地执行 → 结果回传 AI → 继续生成，最多 25 轮迭代
- **强制精确编辑** — save-file 对已有文件直接拒绝（REJECTED），强制 AI 使用 str-replace-editor / apply_patch 做精确编辑，杜绝全量覆盖
- **新文件本地创建** — save-file 对新文件直接本地执行（含递归建目录），apply_patch 的 `*** Create File:` 子操作也正确执行
- **系统提示词注入** — 自动注入 `<file_editing_rules>` 规则块，从提示词层面引导 AI 使用正确的编辑工具

**📊 Diff 渲染（流式输出）**
- 拦截的文件编辑操作在聊天中实时渲染 diff，而不是只显示 `✅ apply_patch`
- 行级 diff（≤50 行）：显示 `- 删除行` / `+ 新增行`，最多各展示 12 行
- 大文件覆盖（>50 行）：显示行数变化摘要 `(1200 → 1250 lines)`
- 新建文件：显示前 15 行预览
- `renderDiffText()` 统一渲染函数，三个 Provider 共用

**🔍 OpenViking 上下文增强**
- 借鉴 [OpenViking](https://github.com/volcengine/OpenViking) 文件系统范式的 Viking 分层上下文系统
- L0 摘要 / L1 结构 / L2 全文三级按需加载，精准控制注入 token 量
- 向量初筛 → 目录聚合 → Top 目录递归下钻，用结构化信号弥补向量精度不足
- 对弱模型（GLM-5 等）的代码理解能力提升尤为显著

### v3.0.1 — 稳定性修复

**🛡️ 崩溃防护**
- 修复 `augmentConfig.update()` 重复写入导致窗口无限重载的问题
- 新增 OOM 崩溃检测：大模型加载导致 extension host 崩溃时，下次启动自动回退到默认小模型 (MiniLM-L6 22MB)
- 模型初始化改为后台异步 (fire-and-forget)，不再阻塞插件启动
- `deactivate()` 在自动恢复场景下不再清除 Augment 配置

**⚡ 性能优化**
- 智能缓存检测：已下载的模型直接从本地加载，跳过下载流程和进度回调
- 移除两个过大的模型 (BGE-Large 335MB、E5-Base 278MB)，避免 OOM 风险

**🔧 Bug 修复**
- 修复下载进度条直接显示 100% 的问题 (transformers.js v3 状态名变更)
- 修复 checkbox 设置 (OMC/远程 Embedding) 不持久化的问题
- 修复 `embedding.enabled` 错误地阻止本地模型加载的问题 ("BM25 mode")
- 新增 HuggingFace 镜像加速 (hf-mirror.com)
- 新增下载取消功能
- 新增缓存损坏自动检测清理并重新下载

**🎨 UI 改进**
- 侧边栏重构：本地模型 (默认) 与远程 Embedding API (可选) 分区显示
- 新增取消下载按钮

### v3.0.0 — 智能上下文引擎

**🧠 Viking 分层上下文系统**
- 借鉴 [OpenViking](https://github.com/volcengine/OpenViking) 上下文数据库理念
- L0 摘要 (~100 tokens) / L1 结构化 (~2K tokens) / L2 全文，三级按需加载
- 向量初筛 → 目录聚合 → Top 目录递归下钻 → 结果合并加权
- 用结构化文件系统信号弥补向量精度不足，对弱模型提升尤为显著

**📦 本地模型选择**
- 侧边栏可视化选择 5 种本地 Embedding 模型 (22MB ~ 118MB)
- 支持运行时一键切换模型，自动重新初始化
- 下载进度条显示文件名和百分比
- 模型专属缓存文件，切换不丢失历史数据
- HuggingFace 镜像加速 (hf-mirror.com)，国内下载速度大幅提升
- 支持取消下载；缓存损坏自动检测清理并重新下载

**🧬 Session Memory 长期记忆**
- 自动从用户消息中提取偏好（编程语言、框架、代码风格）
- 记录 Agent 经验和教训
- LevelDB 持久化，跨会话保持记忆
- 自动注入 System Prompt，AI 具备长期记忆能力

**🌐 远程 Embedding API**
- 支持 GLM embedding-3 / OpenAI text-embedding-3-small / 自定义 API
- 远程 API 失败自动回退本地模型
- 远程/本地独立缓存，维度不冲突

### v3.1.1
- 🪟 **Windows 兼容性修复** — `proxy.localhost` DNS 解析失败改用 `127.0.0.1`，全平台通用
- 🧠 **Sharp 模块兼容性修复** — Mock `sharp` 模块避免 Windows 上 native binding 失败，确保本地 Embedding 模型可用

### v3.1.0
- 🔧 **文件编辑引擎重构** — 修复 AI 调用文件编辑工具后连接终止的致命 bug，三 Provider 全部重构为循环架构
- 📊 **Diff 渲染** — 拦截的文件编辑操作实时渲染 diff 到聊天界面
- 🎯 **强制精确编辑** — `save-file` 对已有文件直接拒绝，强制 AI 使用 `str-replace-editor`
- 🔍 **OpenViking 上下文增强** — Viking L0/L1/L2 分层上下文，向量初筛 + 目录聚合 + 递归下钻

### v3.0.1
- 🛡️ **崩溃防护** — 修复 extension host 崩溃循环，OOM 防护，智能缓存检测
- 🪞 **HuggingFace 镜像** — 支持镜像加速下载
- 🎨 **UI 优化** — 侧边栏本地模型与远程 API 分区显示

### v3.0.0
- 🧠 **Viking 分层上下文** — L0 摘要 / L1 结构化 / L2 全文，三级按需加载
- 🧬 **Session Memory** — 长期记忆，自动提取偏好和经验
- 🌐 **远程 Embedding API** — 支持 GLM/OpenAI/自定义 API
- 📦 **7 种本地模型** — MiniLM-L6/L12, BGE-Small/Base, E5-Multi-Small 等

### v2.1.5
- 🚀 **OMC 编排增强** — 集成 oh-my-claudecode，6 种编排模式
- 🔮 **魔法关键词** — ultrawork/search/analyze/ultrathink 自动增强
- 🧠 **Embedding 配置 UI** — 侧边栏可视化配置
- 🔧 修复配置保存 race condition

### v2.1.4
- 🛠️ 完整支持 `apply_patch` 工具
- 🤖 GLM-5 支持

### v2.1.0
- 🌙 Kimi (月之暗面) 支持 + JSON Mode + 联网搜索

### v1.9.0
- 🚀 零注入模式 + 完整 Agent 模式 + RAG 语义搜索 + 上下文压缩

## 许可证

MIT
