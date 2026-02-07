# Google Gemini 配置指南

## 概述

此插件现已支持 Google Gemini API。你可以使用 Gemini 2.0 Flash、Gemini 1.5 Pro 等模型。

## 配置步骤

### 1. 获取 API Key

1. 访问 [Google AI Studio](https://aistudio.google.com/app/apikey)
2. 点击 "Create API Key" 创建新的 API 密钥
3. 复制生成的 API Key（格式类似：`AIzaSy...`）

### 2. 配置插件

1. 打开 VS Code 设置（`Cmd/Ctrl + ,`）
2. 搜索 "Augment Proxy"
3. 设置以下选项：
   - **Provider**: 选择 `Google Gemini`
   - **Google: Model**: 选择模型（默认：`gemini-2.0-flash-exp`）
   - **Google: Base Url**: 保持默认 `https://generativelanguage.googleapis.com/v1beta/models`

### 3. 启动代理

1. 打开命令面板（`Cmd/Ctrl + Shift + P`）
2. 运行命令：`Augment Proxy: 启动代理服务器`
3. 输入你的 Google API Key
4. 等待代理启动成功

### 4. 注入插件

1. 运行命令：`Augment Proxy: 注入插件`
2. 重启 VS Code
3. 现在 Augment 将使用 Google Gemini API

## 可用模型

### Gemini 3.0 系列（最新）
- `gemini-3-pro-preview` - Gemini 3.0 Pro 预览版（推荐，最强能力）

### Gemini 2.0 系列
- `gemini-2.0-flash-exp` - Gemini 2.0 Flash 实验版（速度快）
- `gemini-exp-1206` - Gemini 2.0 实验版
- `gemini-2.0-flash-thinking-exp-01-21` - 带思考模式的 Flash 版本

### Gemini 1.5 系列
- `gemini-1.5-pro` - Gemini 1.5 Pro（稳定版）
- `gemini-1.5-flash` - Gemini 1.5 Flash（快速版）

## 功能支持

✅ 支持的功能：
- 文本生成
- 多轮对话
- 工具调用（Agent 模式）
- 图片理解（多模态）
- 流式输出

## 故障排除

### API Key 错误
- 确保 API Key 格式正确（以 `AIzaSy` 开头）
- 检查 API Key 是否已启用 Gemini API
- 访问 [Google Cloud Console](https://console.cloud.google.com/) 检查配额

### 连接错误
- 检查网络连接
- 确认防火墙未阻止 `generativelanguage.googleapis.com`
- 如果在中国大陆，可能需要使用代理

### 模型不可用
- 某些模型可能需要申请访问权限
- 尝试使用 `gemini-2.0-flash-exp` 或 `gemini-1.5-flash`

## 参考资料

- [Google Gemini API 文档](https://ai.google.dev/gemini-api/docs)
- [Google AI Studio](https://aistudio.google.com/)
- [定价信息](https://ai.google.dev/pricing)

## 注意事项

1. **免费配额**：Google Gemini API 提供免费配额，但有速率限制
2. **数据隐私**：请求会发送到 Google 服务器，注意敏感信息
3. **模型选择**：Gemini 3.0 Pro 能力最强，2.0 Flash 速度最快
