# v3.2.0 - 代理层 Viking/RAG 智能上下文系统

## 🎉 重大更新：完整的代码库理解能力

本版本在代理层实现了完整的 Viking 分层上下文系统和 RAG 检索引擎，使自定义 API 端点也能享受智能上下文注入，大幅提升模型的代码理解能力和响应质量。

---

## ✨ 核心功能

### 1. **Viking 分层上下文系统**
- ✅ L0 层：~100 tokens 极简摘要（文件结构 + 类型签名）
- ✅ L1 层：~2k tokens 详细概要（上下文描述 + 关键代码元素）
- ✅ L2 层：完整内容（按需加载）
- ✅ 自动扫描工作区并生成分层上下文
- ✅ 智能注入 L0 摘要到 system prompt（前 200 个文件，约 5k tokens）

### 2. **RAG 检索引擎**
- ✅ 基于用户查询自动检索相关代码片段
- ✅ 支持 BGE 嵌入模型和 BM25 算法
- ✅ 检索结果自动注入到用户消息
- ✅ 每次查询返回 Top-5 最相关代码

### 3. **自动工作区索引**
- ✅ 代理启动时自动扫描工作区
- ✅ 支持 20+ 种编程语言
- ✅ 智能跳过 node_modules、.git 等目录
- ✅ 增量更新（基于文件 hash）

### 4. **Session Memory**
- ✅ 从用户消息中提取偏好
- ✅ 跨会话记忆用户习惯
- ✅ 自动优化响应风格

---

## 📊 效果对比

| 指标 | 3.1.3 | 3.2.0 | 改善 |
|------|-------|-------|------|
| **代码理解能力** | 低 | 高 | ✅ **显著提升** |
| **响应相关性** | 中等 | 高 | ✅ **显著提升** |
| **上下文感知** | 无 | 完整 | ✅ **新增** |
| **工作区索引** | 无 | 自动 | ✅ **新增** |
| **RAG 检索** | 无 | 支持 | ✅ **新增** |

---

## 🔧 技术实现

### Viking 分层上下文

```typescript
// L0 摘要示例
[proxy.ts] type:module fn:handleChatStream,startProxy,stopProxy exp:startProxy,stopProxy

// L1 概要示例
# src/proxy.ts
Type: module | .ts
Summary: HTTP 代理服务器和路由处理
Functions: handleChatStream, startProxy, stopProxy, refreshConfig
Imports: http, fs, path, vscode
Exports: startProxy, stopProxy, refreshConfig
```

### RAG 检索流程

```typescript
// 1. 用户查询
"如何修改代理端口？"

// 2. RAG 检索
const results = await state.ragIndex.search(query, 5);

// 3. 注入到用户消息
<relevant_code>
[src/proxy.ts]
state.currentConfig.port = config.get('port', 8765);
...
</relevant_code>
```

### 自动索引

```typescript
// 代理启动时自动执行
await scanAndIndexWorkspace(rootPath);
// 扫描 .ts, .js, .py, .java, .go 等 20+ 种语言
// 生成 Viking L0/L1 分层上下文
// 索引到 RAG 引擎
```

---

## 🚀 使用方法

### 安装

```bash
code --install-extension augment-proxy-manager-3.2.0.vsix
```

### 验证

安装后，查看日志应该看到：

```
[VIKING] ✅ Viking Context Store 已初始化
[VIKING] 🔍 扫描工作区: /path/to/project
[VIKING] 📁 发现 150 个代码文件
[VIKING] 📊 进度: 150/150
[VIKING] ✅ 生成了 150 个新的分层上下文
[VIKING] 📊 统计: 150 个资源, L0=3750 tokens, L1=75000 tokens
[RAG] ✅ 已索引 150 个文档到 RAG 引擎
[RAG] ✅ RAG 检索引擎已初始化
[MEMORY] ✅ Session Memory 已初始化
```

### 测试

发送一个代码相关的问题，例如：

```
"这个项目的代理服务器是如何启动的？"
```

你应该看到：

```
[RAG] 🔍 检索到 5 个相关代码片段
[VIKING] 📋 注入 200 个文件的 L0 摘要
```

---

## ⚠️ 注意事项

1. **首次启动会扫描工作区**：大型项目可能需要 10-30 秒
2. **内存占用增加**：Viking 缓存约占用 50-100MB
3. **支持的文件类型**：.ts, .js, .py, .java, .go, .rs, .c, .cpp, .h, .cs, .rb, .php, .swift, .kt, .scala, .md, .json, .yaml, .xml, .html, .css, .vue, .svelte
4. **自动跳过目录**：node_modules, .git, dist, build, out, .vscode

---

## 🔄 从 3.1.3 升级

```bash
# 1. 卸载旧版本
code --uninstall-extension legna.augment-proxy-manager

# 2. 安装新版本
code --install-extension augment-proxy-manager-3.2.0.vsix

# 3. 重启 VSCode
```

---

## 📝 配置

无需额外配置，Viking/RAG 会自动启用。如果需要禁用：

```json
{
  "augmentProxy.viking.enabled": false,
  "augmentProxy.rag.enabled": false
}
```

---

**享受智能代码理解！** 🚀
