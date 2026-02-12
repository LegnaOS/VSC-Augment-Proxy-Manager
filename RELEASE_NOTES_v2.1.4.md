# Augment Proxy Manager v2.1.4

## 🎉 新功能

### 🛠️ 完整支持 `apply_patch` 工具

Augment 扩展使用 `apply_patch` 工具进行文件编辑，本版本完整实现了对该工具的支持：

- **双格式支持**：自动识别并处理两种 patch 格式
  - **Diff 格式**：使用 `@@` 上下文定位符、`-` 删除行、`+` 添加行的标准 diff 格式
  - **完整替换格式**：直接提供完整文件内容的替换格式
- **智能路由**：根据 patch 格式自动选择合适的执行方式
  - Diff 格式 → 使用 `str-replace-editor` 进行精确替换
  - 完整替换 → 使用 `save-file` 直接写入
- **正确的缩进处理**：修复了 substring 逻辑，确保代码缩进完全保留

### 🤖 GLM-5 支持

- 更新智谱 AI (GLM) 默认模型为最新的 `glm-5`
- 提供更强大的代码理解和生成能力

## 🔧 Bug 修复

- 修复 patch 解析器的 substring 逻辑，正确去除 `"- "` 和 `"+ "` 前缀（包括空格）
- 修复上下文行识别逻辑，确保 `@@` 定位符被正确跳过
- 修复完整文件替换时 oldContent 和 newContent 相同的问题

## 📦 安装

下载 `augment-proxy-manager-2.1.4.vsix` 文件，然后在 VSCode 中：

1. 打开命令面板（`Cmd+Shift+P` / `Ctrl+Shift+P`）
2. 输入 `Extensions: Install from VSIX...`
3. 选择下载的 `.vsix` 文件

或使用命令行：

```bash
code --install-extension augment-proxy-manager-2.1.4.vsix
```

## 🔗 相关链接

- [GitHub 仓库](https://github.com/LegnaOS/VSC-Augment-Proxy-Manager)
- [问题反馈](https://github.com/LegnaOS/VSC-Augment-Proxy-Manager/issues)

---

**完整更新日志**：

### v2.1.4
- 🛠️ **完整支持 `apply_patch` 工具** — 支持 Augment 的两种 patch 格式（diff 格式和完整文件替换）
- 🤖 **GLM-5 支持** — 更新智谱 AI 默认模型为 `glm-5`
- 🔧 修复 patch 解析器的 substring 逻辑，正确处理缩进
- 🔧 自动检测 patch 格式，智能选择 `str-replace-editor` 或 `save-file`

### v2.1.3
- 🌙 **Kimi Coding Plan 支持** — 支持月之暗面 Coding Plan API（需要特殊订阅）
- 🔧 修复 Kimi API 端点配置
- 🔧 完善 Anthropic 格式检测逻辑

### v2.1.0
- 🌙 **Kimi (月之暗面) 支持** — 新增 Kimi 标准 API 支持
- 🔍 **JSON Mode** — 支持 Kimi 的结构化 JSON 输出
- 🌐 **联网搜索** — 支持 Kimi 内置的 `$web_search` 功能

