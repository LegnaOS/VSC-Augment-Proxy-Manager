## 🪟 Windows 平台兼容性修复

### 修复内容

**1. `proxy.localhost` DNS 解析失败 (ENOTFOUND)**

Windows 不支持 `*.localhost` 子域名 DNS 解析（仅支持 `localhost`），导致 Augment 扩展无法连接代理服务器，进入无限重试循环。

- **修复前**: `http://proxy.localhost:8765` → Windows ENOTFOUND 错误
- **修复后**: `http://127.0.0.1:8765` → 全平台通用，跳过 DNS 解析
- **影响**: macOS/Linux 用户无影响，Windows 用户从 v3.1.0 升级后自动修复

**2. Sharp 模块 native binding 加载失败**

Windows 上 `sharp` 模块（`@huggingface/transformers` 的依赖）的 native binding 可能因缺少 Visual C++ Redistributable 或 Node ABI 版本不匹配而加载失败，导致本地 Embedding 模型无法使用。

- **修复前**: Sharp 加载失败 → transformers.js 初始化失败 → 回退 BM25 纯文本搜索
- **修复后**: 在 import transformers.js 前 mock `sharp` 模块，返回 `null` → transformers.js 跳过图像处理功能 → 文本 Embedding 正常工作
- **原理**: `sharp` 仅用于图像处理，文本 Embedding 任务不需要它
- **影响**: 无性能损失，功能完全正常

### 技术细节

| 文件 | 改动 |
|------|------|
| `src/proxy.ts:624` | `proxy.localhost` → `127.0.0.1` |
| `src/rag/embeddings.ts:loadLocalModel()` | 在 import transformers.js 前用 Module.require hook mock `sharp` 模块 |

### 升级说明

从 v3.1.0 升级的用户：
- 首次启动代理时，`alreadyConfigured` 检查会检测到 URL 变化（`proxy.localhost` → `127.0.0.1`）
- 自动重写 `augment.advanced.completionURL` 配置并触发窗口重载
- 无需手动操作，自动修复

## 📦 安装

下载 `augment-proxy-manager-3.1.1.vsix` 后在 VS Code 中安装：

**扩展** → **⋯** → **从 VSIX 安装**

