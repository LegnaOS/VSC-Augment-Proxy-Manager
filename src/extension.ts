"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const url_1 = require("url");
const { RAGContextIndex } = require('./rag');

// ===== 全局状态 =====
let proxyServer = null;
let statusBarItem;
let outputChannel;
let sidebarProvider;
let extensionContext;
let ragIndex: any = null;  // RAG 索引实例

// ===== 会话级请求队列 =====
// 防止同一会话的并发请求导致工具在 checkingSafety 阶段被取消
// 原因：Augment 扩展会在用户请求后自动发送 "MESSAGE ANALYSIS MODE" 请求
// 导致两个请求同时处理同一会话，触发并发冲突
const conversationQueues = new Map<string, Promise<void>>();

// 当前配置
let currentConfig = {
    provider: 'anthropic',
    port: 8765,
    apiKey: '',
    baseUrl: '',
    model: '',
    // MiniMax 特有配置
    enableCache: true,
    enableInterleavedThinking: true,
    // DeepSeek 特有配置
    enableThinking: true
};
// Provider 配置
const PROVIDERS = ['minimax', 'anthropic', 'deepseek', 'glm', 'openai', 'custom'];
const PROVIDER_NAMES = {
    minimax: 'MiniMax',
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    glm: 'GLM (智谱)',
    openai: 'OpenAI',
    custom: '自定义'
};
const DEFAULT_BASE_URLS = {
    minimax: 'https://api.minimaxi.com/anthropic/v1/messages',
    anthropic: 'https://api.anthropic.com/v1/messages',
    deepseek: 'https://api.deepseek.com/anthropic/v1/messages', // DeepSeek Anthropic 兼容 API
    glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', // 智谱 OpenAI 兼容 API
    openai: 'https://api.openai.com/v1/chat/completions',
    custom: ''
};
const DEFAULT_MODELS = {
    minimax: 'MiniMax-M2.2',
    anthropic: 'claude-sonnet-4-20250514',
    deepseek: 'deepseek-chat',
    glm: 'glm-4.7', // 智谱最新模型
    openai: 'gpt-4',
    custom: ''
};
// 判断是否为 Anthropic 格式
// DeepSeek 提供 Anthropic 兼容 API：https://api.deepseek.com/anthropic/v1/messages
function isAnthropicFormat(provider) {
    return ['anthropic', 'minimax', 'deepseek'].includes(provider);
}
// 判断是否为 OpenAI 格式
function isOpenAIFormat(provider) {
    return ['openai', 'glm'].includes(provider);
}
// Augment 插件路径
function getAugmentExtensionPath() {
    const extensionsDir = path.join(os.homedir(), '.vscode', 'extensions');
    if (!fs.existsSync(extensionsDir)) {
        return null;
    }
    const augmentDirs = fs.readdirSync(extensionsDir)
        .filter(d => d.startsWith('augment.vscode-augment-'))
        .sort();
    if (augmentDirs.length === 0) {
        return null;
    }
    return path.join(extensionsDir, augmentDirs[augmentDirs.length - 1]);
}
function activate(context) {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel('Augment Proxy');
    // 创建侧边栏
    sidebarProvider = new AugmentProxySidebarProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('augmentProxy.sidebar', sidebarProvider));
    // 创建状态栏
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'augmentProxy.showStatus';
    updateStatusBar(false, checkInjectionStatus());
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // 注册命令
    context.subscriptions.push(vscode.commands.registerCommand('augmentProxy.startProxy', startProxy), vscode.commands.registerCommand('augmentProxy.stopProxy', stopProxy), vscode.commands.registerCommand('augmentProxy.configureProvider', configureProvider), vscode.commands.registerCommand('augmentProxy.showStatus', showStatus), vscode.commands.registerCommand('augmentProxy.injectPlugin', injectPlugin), vscode.commands.registerCommand('augmentProxy.restorePlugin', restorePlugin));
    outputChannel.appendLine('Augment Proxy Manager 已激活');

    // 异步初始化 RAG 索引（不阻塞激活）
    initializeRAGIndex().catch(err => {
        outputChannel.appendLine(`[RAG] Background initialization failed: ${err}`);
    });
}
function updateStatusBar(proxyRunning, injected = checkInjectionStatus()) {
    const proxyIcon = proxyRunning ? '$(radio-tower)' : '$(circle-slash)';
    const injectIcon = injected ? '$(check)' : '$(x)';
    statusBarItem.text = `${proxyIcon} Proxy ${injectIcon}`;
    statusBarItem.tooltip = `代理: ${proxyRunning ? '运行中' : '已停止'} | 注入: ${injected ? '已注入' : '未注入'}`;
    statusBarItem.backgroundColor = proxyRunning
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    // 更新侧边栏
    if (sidebarProvider) {
        sidebarProvider.updateStatus(proxyRunning, injected);
    }
}
// ===== 纯 TypeScript 代理服务器 =====
// 处理代理请求
function handleProxyRequest(req, res) {
    const urlPath = req.url || '/';
    outputChannel.appendLine(`[${new Date().toISOString()}] ${req.method} ${urlPath}`);
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    // 路由 - 精确匹配优先
    if (urlPath === '/health' || urlPath === '/') {
        handleHealth(res);
    }
    else if (urlPath === '/getPluginState') {
        handlePluginState(res);
    }
    else if (urlPath === '/get-model-config') {
        handleModelConfig(res);
    }
    else if (urlPath === '/get-models') {
        handleGetModels(res);
    }
    else if (urlPath === '/chat-input-completion') {
        // 聊天输入补全 - 返回空
        handleChatInputCompletion(req, res);
    }
    else if (urlPath === '/completion') {
        // 代码补全 - 返回空
        handleCodeCompletion(req, res);
    }
    else if (urlPath === '/chat-stream' || urlPath === '/chat' ||
        urlPath === '/instruction-stream' || urlPath === '/smart-paste-stream') {
        // 核心聊天请求 - 转发到 API
        handleChatStream(req, res);
    }
    else if (urlPath === '/report-error') {
        handleReportError(req, res);
    }
    else if (urlPath === '/agents/codebase-retrieval') {
        // Codebase retrieval - 使用本地搜索实现
        handleCodebaseRetrieval(req, res);
    }
    else if (urlPath === '/agents/edit-file') {
        // 服务端编辑 - 返回空结果，本地使用工具调用处理
        handleAgentEditFile(req, res);
    }
    else if (urlPath === '/agents/list-remote-tools') {
        // 远程工具列表 - 返回空（本地不支持 MCP 远程工具）
        handleListRemoteTools(req, res);
    }
    else if (urlPath === '/agents/run-remote-tool') {
        // 运行远程工具 - 返回未实现
        handleRunRemoteTool(req, res);
    }
    else if (urlPath === '/next-edit-stream') {
        // 下一步编辑预测 - 返回空结果
        handleNextEditStream(req, res);
    }
    else if (urlPath === '/find-missing') {
        // 查找缺失文件 - 返回空结果
        handleFindMissing(req, res);
    }
    else if (urlPath === '/client-metrics') {
        // 客户端指标 - 返回成功
        handleClientMetrics(req, res);
    }
    else if (urlPath === '/client-completion-timelines') {
        // 补全时间线 - 返回成功
        handleClientCompletionTimelines(req, res);
    }
    else if (urlPath === '/batch-upload') {
        // 批量上传文件块 - 返回成功（假装已接收）
        handleBatchUpload(req, res);
    }
    else if (urlPath === '/notifications/read') {
        // 已读通知 - 返回空
        handleNotificationsRead(req, res);
    }
    else if (urlPath === '/record-request-events') {
        // 记录请求事件 - 返回成功
        handleRecordRequestEvents(req, res);
    }
    else if (urlPath === '/report-feature-vector') {
        // 特征向量上报 - 返回成功
        handleReportFeatureVector(req, res);
    }
    else if (urlPath === '/remote-agents/list-stream') {
        // 远程代理列表 - 返回空
        handleRemoteAgentsListStream(req, res);
    }
    else if (urlPath.includes('/subscription') || urlPath.includes('/notifications') ||
        urlPath.includes('/user-secrets') || urlPath.includes('/save-chat') ||
        urlPath.includes('/record-session') || urlPath.includes('/remote-agents') ||
        urlPath.includes('/client-completion')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    }
    else {
        // 静默处理未知端点
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    }
}
function handleHealth(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ok',
        provider: currentConfig.provider,
        model: currentConfig.model,
        has_api_key: !!currentConfig.apiKey
    }));
}
function handlePluginState(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        authenticated: true,
        hasValidSubscription: true,
        subscriptionType: 'pro',
        planName: 'Pro (Proxy)',
        email: 'proxy@local',
        features: { chat: true, completion: true, instruction: true, agentMode: true }
    }));
}
function handleModelConfig(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        internalName: currentConfig.model,
        displayName: `${PROVIDER_NAMES[currentConfig.provider]} - ${currentConfig.model}`,
        provider: currentConfig.provider
    }));
}
function handleGetModels(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 🔑 关键修复：伪装成 Anthropic Claude 模型
    // Augment 可能根据模型名称/provider 决定是否启用 Agent 模式
    // 使用 Claude 模型名称来触发 Agent 工具加载
    const fakeClaudeModelId = "claude-opus-4.5";  // 伪装的 Claude Opus 4.5 模型 ID
    const modelInfo = {
        id: fakeClaudeModelId,                    // 伪装成 Claude
        name: fakeClaudeModelId,                  // 模型显示名称
        provider: "anthropic",                    // 伪装成 Anthropic provider
        // BackModelInfo 必需字段
        suggested_prefix_char_count: 10000,
        suggested_suffix_char_count: 1000,
        max_tokens: 8192,
        supports_fim: true,
        supports_chat: true,
        supports_instruction: true,
        // Agent 模式标志
        chat_mode: "REMOTE_AGENT"
    };
    outputChannel.appendLine(`[GET-MODELS] Returning fake Claude model: ${fakeClaudeModelId} (actual: ${currentConfig.model})`);
    res.end(JSON.stringify({
        models: [modelInfo],
        default_model: fakeClaudeModelId
    }));
}
// 聊天输入补全 - Augment 协议格式
function handleChatInputCompletion(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            outputChannel.appendLine(`[CHAT-INPUT-COMPLETION] prompt: ${(data.prompt || '').slice(0, 50)}...`);
        }
        catch { }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            completions: [],
            text: '',
            stop_reason: 1,
            unknown_blob_names: [],
            unknown_memory_names: [],
            checkpoint_not_found: false
        }));
    });
}
// 代码补全 - 暂不支持
function handleCodeCompletion(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            completions: [],
            unknown_blob_names: [],
            unknown_memory_names: []
        }));
    });
}
// 错误报告
function handleReportError(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            // 提取更详细的错误信息
            const errorMsg = data.error_message || data.message || data.error || 'unknown';
            const errorType = data.error_type || data.type || '';
            const errorContext = data.context || data.endpoint || '';
            // 过滤掉常见的无害错误（避免日志过多）
            const ignoredPatterns = ['get-models', 'client-metrics', 'client-completion'];
            const shouldLog = !ignoredPatterns.some(p => errorMsg.toLowerCase().includes(p) || errorContext.toLowerCase().includes(p));
            if (shouldLog) {
                outputChannel.appendLine(`[REPORT-ERROR] ${errorType ? errorType + ': ' : ''}${errorMsg}${errorContext ? ' (context: ' + errorContext + ')' : ''}`);
            }
        }
        catch { }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    });
}

// ===== Codebase Retrieval - 本地代码搜索实现 =====
interface CodebaseRetrievalRequest {
    information_request: string;
    blobs?: { checkpoint_id?: string; added_blobs?: string[]; deleted_blobs?: string[] };
    dialog?: any[];
    max_output_length?: number;
    disable_codebase_retrieval?: boolean;
    enable_commit_retrieval?: boolean;
}

interface CodeSnippet {
    path: string;
    content: string;
    lineStart: number;
    lineEnd: number;
    score: number;
}

// 获取工作区根目录（支持 iCloud 和网络路径）
function getWorkspaceRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return [];
    }
    return folders.map(f => {
        let fsPath = f.uri.fsPath;
        // 🔥 解析符号链接（iCloud 路径通常是符号链接）
        try {
            fsPath = fs.realpathSync(fsPath);
        } catch {
            // 如果无法解析，保持原始路径
        }
        return fsPath;
    });
}

// 递归搜索文件
function findFilesRecursive(dir: string, extensions: string[], maxDepth: number = 10, currentDepth: number = 0): string[] {
    if (currentDepth > maxDepth) return [];

    const results: string[] = [];
    try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            // 跳过常见的忽略目录
            if (['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv'].includes(item)) {
                continue;
            }

            const fullPath = path.join(dir, item);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    results.push(...findFilesRecursive(fullPath, extensions, maxDepth, currentDepth + 1));
                } else if (stat.isFile()) {
                    const ext = path.extname(item).toLowerCase();
                    if (extensions.length === 0 || extensions.includes(ext)) {
                        results.push(fullPath);
                    }
                }
            } catch { /* 忽略权限错误 */ }
        }
    } catch { /* 忽略权限错误 */ }
    return results;
}

// 简单的关键词匹配搜索
function searchInFile(filePath: string, keywords: string[], maxSnippets: number = 3): CodeSnippet[] {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const snippets: CodeSnippet[] = [];

        // 计算每行的匹配分数
        const lineScores: { lineNum: number; score: number }[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].toLowerCase();
            let score = 0;
            for (const keyword of keywords) {
                if (line.includes(keyword.toLowerCase())) {
                    score += 1;
                    // 额外分数：完整单词匹配
                    const wordRegex = new RegExp(`\\b${keyword}\\b`, 'i');
                    if (wordRegex.test(lines[i])) {
                        score += 2;
                    }
                }
            }
            if (score > 0) {
                lineScores.push({ lineNum: i, score });
            }
        }

        // 按分数排序，取前几个
        lineScores.sort((a, b) => b.score - a.score);
        const topMatches = lineScores.slice(0, maxSnippets);

        // 生成代码片段（包含上下文）
        for (const match of topMatches) {
            const contextLines = 5;
            const startLine = Math.max(0, match.lineNum - contextLines);
            const endLine = Math.min(lines.length - 1, match.lineNum + contextLines);

            const snippetLines = lines.slice(startLine, endLine + 1);
            snippets.push({
                path: filePath,
                content: snippetLines.join('\n'),
                lineStart: startLine + 1,
                lineEnd: endLine + 1,
                score: match.score
            });
        }

        return snippets;
    } catch {
        return [];
    }
}

// 从查询中提取关键词
function extractKeywords(query: string): string[] {
    // 移除常见的停用词
    const stopWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
        'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
        'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under',
        'and', 'but', 'if', 'or', 'because', 'until', 'while', 'although', 'though',
        'where', 'when', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
        'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
        'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their',
        'how', 'find', 'show', 'get', 'look', 'search', 'code', 'function', 'class', 'method'];

    const words = query.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.includes(w));

    // 去重
    return [...new Set(words)];
}

// 初始化 RAG 索引
async function initializeRAGIndex(): Promise<void> {
    const roots = getWorkspaceRoots();
    if (roots.length === 0) return;

    const workspaceRoot = roots[0];  // 使用第一个工作区

    try {
        ragIndex = new RAGContextIndex({ workspaceRoot });
        outputChannel.appendLine(`[RAG] Initializing LevelDB storage...`);

        // 🔥 初始化 LevelDB 存储层
        await ragIndex.initStorage();

        outputChannel.appendLine(`[RAG] Indexing files in ${workspaceRoot}...`);

        const startTime = Date.now();
        await ragIndex.initialize((current, total) => {
            if (current % 500 === 0) {
                outputChannel.appendLine(`[RAG] Indexing progress: ${current}/${total}`);
            }
        });

        const stats = ragIndex.getStats();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        outputChannel.appendLine(`[RAG] Index ready: ${stats.documentCount} documents, checkpoint ${stats.checkpointId}, took ${elapsed}s`);
    } catch (error) {
        outputChannel.appendLine(`[RAG] Failed to initialize: ${error}`);
        ragIndex = null;
    }
}

// 关闭 RAG 索引 - 释放 LevelDB 资源
async function closeRAGIndex(): Promise<void> {
    if (ragIndex) {
        try {
            await ragIndex.close();
            outputChannel.appendLine('[RAG] LevelDB storage closed');
        } catch (error) {
            outputChannel.appendLine(`[RAG] Error closing storage: ${error}`);
        }
        ragIndex = null;
    }
}

// 处理 codebase-retrieval 请求 - 使用 RAG 索引
function handleCodebaseRetrieval(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
        try {
            const data: CodebaseRetrievalRequest = JSON.parse(body);
            const query = data.information_request || '';

            outputChannel.appendLine(`[CODEBASE-RETRIEVAL] Query: ${query.slice(0, 100)}...`);

            // 如果禁用了 codebase retrieval，返回空结果
            if (data.disable_codebase_retrieval) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    formatted_retrieval: 'Codebase retrieval is disabled.',
                    unknown_blob_names: [],
                    checkpoint_not_found: false
                }));
                return;
            }

            // 获取工作区根目录
            const roots = getWorkspaceRoots();
            if (roots.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    formatted_retrieval: 'No workspace folder is open.',
                    unknown_blob_names: [],
                    checkpoint_not_found: false
                }));
                return;
            }

            // 确保 RAG 索引已初始化
            if (!ragIndex) {
                await initializeRAGIndex();
            }

            let formattedResult = '';
            let snippetCount = 0;

            // 优先使用 RAG 索引搜索
            if (ragIndex) {
                const startTime = Date.now();
                const results = ragIndex.search(query, 10);
                const searchTime = Date.now() - startTime;

                outputChannel.appendLine(`[RAG] Search completed in ${searchTime}ms, found ${results.length} results`);

                if (results.length > 0) {
                    formattedResult = `Found ${results.length} relevant code snippets (RAG search):\n\n`;
                    for (const result of results) {
                        formattedResult += `## ${result.path} (lines ${result.lineStart}-${result.lineEnd})\n`;
                        formattedResult += `*Matched: ${result.highlights.join(', ')}*\n`;
                        formattedResult += '```\n';
                        formattedResult += result.content;
                        formattedResult += '\n```\n\n';
                    }
                    snippetCount = results.length;
                }
            }

            // 如果 RAG 没有结果，回退到简单关键词搜索
            if (snippetCount === 0) {
                outputChannel.appendLine(`[CODEBASE-RETRIEVAL] RAG returned no results, falling back to keyword search`);

                const keywords = extractKeywords(query);
                if (keywords.length > 0) {
                    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.vue', '.svelte'];
                    const allSnippets: CodeSnippet[] = [];

                    for (const root of roots) {
                        const files = findFilesRecursive(root, extensions);
                        for (const file of files.slice(0, 300)) {
                            const snippets = searchInFile(file, keywords);
                            for (const snippet of snippets) {
                                snippet.path = path.relative(root, snippet.path);
                                allSnippets.push(snippet);
                            }
                        }
                    }

                    allSnippets.sort((a, b) => b.score - a.score);
                    const topSnippets = allSnippets.slice(0, 10);

                    if (topSnippets.length > 0) {
                        formattedResult = `Found ${topSnippets.length} relevant code snippets (keyword search):\n\n`;
                        for (const snippet of topSnippets) {
                            formattedResult += `## ${snippet.path} (lines ${snippet.lineStart}-${snippet.lineEnd})\n`;
                            formattedResult += '```\n';
                            formattedResult += snippet.content;
                            formattedResult += '\n```\n\n';
                        }
                        snippetCount = topSnippets.length;
                    }
                }
            }

            if (snippetCount === 0) {
                formattedResult = `No matching code found for: "${query}"`;
            }

            outputChannel.appendLine(`[CODEBASE-RETRIEVAL] Returning ${snippetCount} snippets`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                formatted_retrieval: formattedResult,
                unknown_blob_names: [],
                checkpoint_not_found: false
            }));

        } catch (error) {
            outputChannel.appendLine(`[CODEBASE-RETRIEVAL] Error: ${error}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                formatted_retrieval: `Error performing codebase search: ${error}`,
                unknown_blob_names: [],
                checkpoint_not_found: false
            }));
        }
    });
}

// 处理 agents/edit-file 请求 - 服务端编辑功能
// 由于我们使用本地 LLM 的工具调用，这个端点返回空结果
function handleAgentEditFile(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            outputChannel.appendLine(`[AGENT-EDIT-FILE] file_path: ${data.file_path || 'unknown'}`);
            // 返回表示不支持的响应，让客户端使用工具调用
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                modified_file_contents: null,
                is_error: true,
                error_message: 'Server-side edit not supported. Use str-replace-editor tool instead.'
            }));
        } catch (error) {
            outputChannel.appendLine(`[AGENT-EDIT-FILE] Error: ${error}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                modified_file_contents: null,
                is_error: true,
                error_message: 'Parse error'
            }));
        }
    });
}

// 处理 agents/list-remote-tools 请求 - 远程 MCP 工具列表
function handleListRemoteTools(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            outputChannel.appendLine(`[LIST-REMOTE-TOOLS] tool_ids: ${JSON.stringify(data.tool_id_list?.tool_ids || [])}`);
            // 返回空工具列表 - 本地代理不支持远程 MCP 工具
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                tools: []
            }));
        } catch (error) {
            outputChannel.appendLine(`[LIST-REMOTE-TOOLS] Error: ${error}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tools: [] }));
        }
    });
}

// 处理 agents/run-remote-tool 请求 - 执行远程工具
function handleRunRemoteTool(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            outputChannel.appendLine(`[RUN-REMOTE-TOOL] tool_name: ${data.tool_name || 'unknown'}`);
            // 返回未实现的响应
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                tool_output: 'Remote tools are not supported in local proxy mode.',
                tool_result_message: 'This feature requires Augment cloud connection.',
                status: 'NOT_IMPLEMENTED'
            }));
        } catch (error) {
            outputChannel.appendLine(`[RUN-REMOTE-TOOL] Error: ${error}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                tool_output: 'Error parsing request',
                status: 'ERROR'
            }));
        }
    });
}

// 处理 /next-edit-stream 请求 - 🔥 基于上下文推荐相关代码
function handleNextEditStream(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);

            // 请求格式：{ file_path: "当前文件", content: "当前内容", cursor_position: { line, character } }
            const filePath = data.file_path || data.path || '';
            const content = data.content || '';
            const cursorLine = data.cursor_position?.line || 0;

            // 如果没有RAG索引，返回空
            if (!ragIndex || !filePath) {
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
                res.end(JSON.stringify({ chunks: [], stop_reason: 1, has_more: false }) + '\n');
                return;
            }

            // 提取当前编辑位置的上下文作为查询
            const lines = content.split('\n');
            const contextStart = Math.max(0, cursorLine - 5);
            const contextEnd = Math.min(lines.length, cursorLine + 5);
            const contextLines = lines.slice(contextStart, contextEnd).join('\n');

            // 从当前上下文中提取关键词作为查询
            const fileBaseName = path.basename(filePath).replace(/\.[^.]+$/, '');
            const query = `${fileBaseName} ${contextLines}`;

            // 搜索相关代码
            const results = ragIndex.search(query, 3);

            // 过滤掉当前文件
            const relatedFiles = results.filter(r => !r.path.endsWith(path.basename(filePath)));

            if (relatedFiles.length > 0) {
                outputChannel.appendLine(`[NEXT-EDIT] Found ${relatedFiles.length} related files for ${filePath}`);

                // 构建推荐响应
                const suggestions = relatedFiles.map(r => ({
                    file_path: r.path,
                    relevance: r.score,
                    matched_terms: r.highlights
                }));

                res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
                res.write(JSON.stringify({
                    type: 'related_files',
                    related_files: suggestions
                }) + '\n');
                res.end(JSON.stringify({ chunks: [], stop_reason: 1, has_more: false }) + '\n');
            } else {
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
                res.end(JSON.stringify({ chunks: [], stop_reason: 1, has_more: false }) + '\n');
            }
        } catch (error) {
            outputChannel.appendLine(`[NEXT-EDIT] Error: ${error}`);
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            res.end(JSON.stringify({ chunks: [], stop_reason: 1, has_more: false }) + '\n');
        }
    });
}

// 处理 /find-missing 请求 - 查找缺失的 blob
function handleFindMissing(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            outputChannel.appendLine(`[FIND-MISSING] blob_names count: ${data.blob_names?.length || 0}`);
            // 返回空的缺失列表 - 表示所有 blob 都存在
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                missing_blob_names: [],
                checkpoint_id: data.checkpoint_id || ''
            }));
        } catch (error) {
            outputChannel.appendLine(`[FIND-MISSING] Error: ${error}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ missing_blob_names: [] }));
        }
    });
}

// 处理 /client-metrics 请求 - 客户端指标上报
function handleClientMetrics(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        // 静默接受指标，不记录日志（太频繁）
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    });
}

// 处理 /client-completion-timelines 请求 - 补全时间线
function handleClientCompletionTimelines(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        // 静默接受时间线数据
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    });
}

// 处理 /batch-upload 请求 - 🔥 真正索引上传的文件到本地RAG
function handleBatchUpload(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);

            // Augment 的 batch-upload 格式：
            // { blobs: [{ name: "sha256hash", content: "文件内容" }], paths: { "sha256hash": "file/path.ts" } }
            const blobs = data.blobs || [];
            const pathMap = data.paths || {};

            let indexedCount = 0;

            if (ragIndex && blobs.length > 0) {
                const filesToIndex: Array<{ path: string; content: string }> = [];

                for (const blob of blobs) {
                    const blobName = blob.name || blob.blob_name;
                    const content = blob.content || blob.data;
                    const filePath = pathMap[blobName];

                    if (filePath && content && typeof content === 'string') {
                        // 只索引代码文件
                        const ext = path.extname(filePath).toLowerCase();
                        const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.vue', '.svelte'];

                        if (codeExtensions.includes(ext)) {
                            filesToIndex.push({ path: filePath, content });
                        }
                    }
                }

                if (filesToIndex.length > 0) {
                    indexedCount = await ragIndex.addBatchToIndex(filesToIndex);
                    outputChannel.appendLine(`[BATCH-UPLOAD] Indexed ${indexedCount}/${filesToIndex.length} files to local RAG`);
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                uploaded_count: blobs.length,
                indexed_count: indexedCount  // 🔥 返回实际索引的数量
            }));
        } catch (error) {
            outputChannel.appendLine(`[BATCH-UPLOAD] Error: ${error}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                uploaded_count: 0
            }));
        }
    });
}

// 处理 /notifications/read 请求 - 已读通知
function handleNotificationsRead(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ notifications: [] }));
    });
}

// 处理 /record-request-events 请求 - 记录请求事件
function handleRecordRequestEvents(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    });
}

// 处理 /report-feature-vector 请求 - 特征向量上报
function handleReportFeatureVector(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    });
}

// 处理 /remote-agents/list-stream 请求 - 远程代理列表
function handleRemoteAgentsListStream(req, res) {
    // 返回空的流式响应
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end(JSON.stringify({ agents: [], has_more: false }) + '\n');
}

// 将 Augment 请求转换为 Anthropic messages 格式
function augmentToAnthropicMessages(req) {
    const messages = [];
    // 处理 chat_history（包含 tool_use 和 tool_result）
    // 关键：Anthropic API 要求每个 tool_use 后必须紧跟对应的 tool_result
    // Augment 的结构：
    //   exchange[i].response_nodes 包含当前轮的 tool_use
    //   exchange[i+1].request_nodes 包含上一轮 tool_use 的 tool_result
    // 正确顺序：user -> assistant(tool_use) -> user(tool_result) -> assistant(tool_use) -> user(tool_result)
    for (let i = 0; i < (req.chat_history || []).length; i++) {
        const exchange = req.chat_history[i];
        const nextExchange = req.chat_history[i + 1];
        // 调试：打印 exchange 的所有键
        if (i === 0) {
            outputChannel.appendLine(`[DEBUG] chat_history[0] keys: ${Object.keys(exchange).join(',')}`);
        }
        // 1. 添加用户消息（仅第一轮有实际用户消息）
        if (exchange.request_message && exchange.request_message.trim()) {
            messages.push({ role: 'user', content: exchange.request_message });
        }
        // 2. 处理 response_nodes（可能包含 tool_use 或 text）
        const responseNodes = exchange.response_nodes || [];
        const toolUses = [];
        let textContent = '';
        // ResponseNodeType: 0=TEXT, 5=TOOL_USE (基于 Augment 逆向分析)
        for (const node of responseNodes) {
            if (node.type === 5 && node.tool_use) { // TOOL_USE (type=5)
                const tu = node.tool_use;
                const input = tu.input_json ? JSON.parse(tu.input_json) : (tu.input || {});
                toolUses.push({
                    type: 'tool_use',
                    id: tu.tool_use_id || tu.id,
                    name: tu.tool_name || tu.name,
                    input: input
                });
                outputChannel.appendLine(`[DEBUG] Parsed tool_use from history: ${tu.tool_name || tu.name}, id=${tu.tool_use_id || tu.id}`);
            }
            else if (node.type === 0 && node.text_node) { // TEXT (type=0)
                textContent += node.text_node.content || '';
            }
        }
        // 如果有 tool_use，构建 content 数组
        if (toolUses.length > 0) {
            const content = [];
            // 思考模式: 解析 <think>...</think> 标签 (MiniMax / DeepSeek)
            // Augment 存储的 response_text 可能包含我们之前发送的 thinking 内容
            const shouldParseThinking = (currentConfig.provider === 'minimax' && currentConfig.enableInterleavedThinking) ||
                (currentConfig.provider === 'deepseek' && currentConfig.enableThinking);
            if (shouldParseThinking && textContent) {
                const thinkMatch = textContent.match(/<think>([\s\S]*?)<\/think>/);
                if (thinkMatch) {
                    // 添加 thinking 块
                    content.push({
                        type: 'thinking',
                        thinking: thinkMatch[1].trim()
                    });
                    outputChannel.appendLine(`[DEBUG] Parsed thinking from history, length: ${thinkMatch[1].length}`);
                    // 移除 thinking 标签后的剩余文本
                    textContent = textContent.replace(/<think>[\s\S]*?<\/think>\s*/, '').trim();
                }
            }
            if (textContent) {
                content.push({ type: 'text', text: textContent });
            }
            content.push(...toolUses);
            messages.push({ role: 'assistant', content: content });
            outputChannel.appendLine(`[DEBUG] Added assistant message with ${toolUses.length} tool_use(s)`);
            // 3. 紧跟着添加对应的 tool_result（从下一个 exchange 的 request_nodes 获取）
            // 或者从当前 exchange 的 request_nodes 获取（如果是同一轮的结果）
            const toolResultNodes = nextExchange?.request_nodes || [];
            for (const node of toolResultNodes) {
                if (node.type === 1 && node.tool_result_node) {
                    const toolResult = node.tool_result_node;
                    messages.push({
                        role: 'user',
                        content: [{
                                type: 'tool_result',
                                tool_use_id: toolResult.tool_use_id || toolResult.id,
                                content: toolResult.content || ''
                            }]
                    });
                    outputChannel.appendLine(`[DEBUG] Added tool_result for id: ${toolResult.tool_use_id || toolResult.id}`);
                }
            }
        }
        else {
            // 普通文本响应
            const response = exchange.response_text || exchange.response_message;
            if (response) {
                messages.push({ role: 'assistant', content: response });
            }
        }
    }
    // 处理 nodes（包含文件内容、工具结果、图片等）
    // ChatRequestNodeType (请求): 0=TEXT, 1=TOOL_RESULT, 2=IMAGE, 3=IMAGE_ID, 4=IDE_STATE, 5=EDIT_EVENTS
    // ChatResponseNodeType (响应): 0=TEXT, 5=TOOL_USE
    // ImageFormatType: 0=UNSPECIFIED, 1=PNG, 2=JPEG, 3=GIF, 4=WEBP
    const imageNodes = [];
    const currentMessage = req.message || '';
    // 收集当前请求中的 tool_result
    const toolResults = [];
    for (const node of req.nodes || []) {
        const nodeType = node.type;
        if (nodeType === 0) { // TEXT
            const textNode = node.text_node || {};
            const content = textNode.content || '';
            // 跳过与 message 重复的 TEXT node（避免重复添加）
            if (content && content !== currentMessage) {
                messages.push({ role: 'user', content: content });
            }
        }
        else if (nodeType === 1) { // TOOL_RESULT
            const toolResult = node.tool_result_node || {};
            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolResult.id || toolResult.tool_use_id,
                content: toolResult.content || ''
            });
            outputChannel.appendLine(`[DEBUG] Current request has tool_result for id: ${toolResult.id || toolResult.tool_use_id}`);
        }
        else if (nodeType === 2) { // IMAGE
            const imageNode = node.image_node || {};
            const imageData = imageNode.image_data || '';
            const format = imageNode.format || 1; // 默认 PNG
            outputChannel.appendLine(`[DEBUG] Image node: format=${format}, dataLen=${imageData.length}, keys=${Object.keys(imageNode).join(',')}`);
            if (imageData) {
                // 根据 format 枚举确定 media_type
                const formatMap = {
                    1: 'image/png',
                    2: 'image/jpeg',
                    3: 'image/gif',
                    4: 'image/webp'
                };
                imageNodes.push({
                    data: imageData,
                    mediaType: formatMap[format] || 'image/png'
                });
                outputChannel.appendLine(`[DEBUG] Image added: ${formatMap[format] || 'image/png'}, ${imageData.length} bytes`);
            }
            else {
                outputChannel.appendLine(`[DEBUG] Image node has no image_data! Node keys: ${JSON.stringify(Object.keys(imageNode))}`);
            }
        }
    }
    // 先添加收集到的 tool_results
    if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
        outputChannel.appendLine(`[DEBUG] Added ${toolResults.length} tool_result(s) to messages`);
    }
    // 添加当前消息及上下文（如果有消息或有图片）
    outputChannel.appendLine(`[DEBUG] Building final message: message="${currentMessage.slice(0, 50)}...", imageNodes=${imageNodes.length}`);
    if (currentMessage || imageNodes.length > 0) {
        const contextParts = [];
        // 文件路径和语言
        if (req.path) {
            contextParts.push(`File: ${req.path}`);
        }
        if (req.lang) {
            contextParts.push(`Language: ${req.lang}`);
        }
        // 选中的代码
        if (req.selected_code) {
            contextParts.push(`Selected code:\n\`\`\`\n${req.selected_code}\n\`\`\``);
        }
        // 处理 blobs（文件内容上下文）
        const blobs = req.blobs;
        if (blobs) {
            let blobCount = 0;
            if (Array.isArray(blobs)) {
                for (const blob of blobs.slice(0, 10)) {
                    if (typeof blob === 'object') {
                        const name = blob.path || blob.name || 'unknown';
                        const content = blob.content || '';
                        if (content) {
                            contextParts.push(`File: ${name}\n\`\`\`\n${String(content).slice(0, 1000)}\n\`\`\``);
                        }
                    }
                }
            }
            else if (typeof blobs === 'object') {
                for (const [blobName, blobData] of Object.entries(blobs)) {
                    if (blobCount >= 10)
                        break;
                    if (typeof blobData === 'object' && blobData !== null && (blobData as any).content) {
                        const content = String((blobData as any).content).slice(0, 1000);
                        contextParts.push(`File: ${blobName}\n\`\`\`\n${content}\n\`\`\``);
                        blobCount++;
                    }
                    else if (typeof blobData === 'string') {
                        contextParts.push(`File: ${blobName}\n\`\`\`\n${blobData.slice(0, 1000)}\n\`\`\``);
                        blobCount++;
                    }
                }
            }
        }
        // 处理 user_guided_blobs
        const userBlobs = req.user_guided_blobs;
        if (userBlobs) {
            if (Array.isArray(userBlobs)) {
                for (const blob of userBlobs.slice(0, 5)) {
                    if (typeof blob === 'object') {
                        const name = blob.path || blob.name || 'unknown';
                        const content = blob.content || '';
                        if (content) {
                            contextParts.push(`User file: ${name}\n\`\`\`\n${String(content).slice(0, 2000)}\n\`\`\``);
                        }
                    }
                }
            }
            else if (typeof userBlobs === 'object') {
                let count = 0;
                for (const [name, data] of Object.entries(userBlobs)) {
                    if (count >= 5)
                        break;
                    const content = typeof data === 'object' && data !== null ? (data as any).content : String(data);
                    if (content) {
                        contextParts.push(`User file: ${name}\n\`\`\`\n${String(content).slice(0, 2000)}\n\`\`\``);
                        count++;
                    }
                }
            }
        }
        // prefix/suffix（当前文件上下文）
        if (req.prefix || req.suffix) {
            const prefix = (req.prefix || '').slice(-2000);
            const suffix = (req.suffix || '').slice(0, 2000);
            if (prefix || suffix) {
                contextParts.push(`Current file context:\n\`\`\`\n${prefix}[CURSOR]${suffix}\n\`\`\``);
            }
        }
        // 组合上下文和消息
        let finalMessage = currentMessage;
        if (contextParts.length > 0) {
            finalMessage = contextParts.join('\n\n') + '\n\n' + currentMessage;
        }
        // 如果有图片，构建多模态消息
        if (imageNodes.length > 0) {
            const contentParts = [];
            // 先添加图片
            for (const img of imageNodes) {
                contentParts.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: img.mediaType,
                        data: img.data
                    }
                });
            }
            // 再添加文本
            contentParts.push({ type: 'text', text: finalMessage });
            messages.push({ role: 'user', content: contentParts });
        }
        else {
            messages.push({ role: 'user', content: finalMessage });
        }
    }
    // 确保至少有一条消息
    if (messages.length === 0) {
        messages.push({ role: 'user', content: 'Hello' });
    }
    return messages;
}
// 从请求中提取工作区信息
function extractWorkspaceInfo(req: any): { workspacePath?: string; repositoryRoot?: string; currentFile?: string; cwd?: string } {
    const result: { workspacePath?: string; repositoryRoot?: string; currentFile?: string; cwd?: string } = {};
    // 1. 从 path 字段提取当前文件路径
    if (req.path) {
        result.currentFile = req.path;
    }
    // 2. 从 nodes 中的 ide_state_node 提取详细信息
    // 结构：{ workspace_folders: [{ folder_root, repository_root }], current_terminal: { current_working_directory } }
    if (req.nodes) {
        for (const node of req.nodes) {
            if (node.type === 4 && node.ide_state_node) {
                const ideState = node.ide_state_node;
                // 从 workspace_folders 提取工作区路径
                if (ideState.workspace_folders && Array.isArray(ideState.workspace_folders) && ideState.workspace_folders.length > 0) {
                    const firstFolder = ideState.workspace_folders[0];
                    if (firstFolder.folder_root) {
                        result.workspacePath = firstFolder.folder_root;
                    }
                    if (firstFolder.repository_root) {
                        result.repositoryRoot = firstFolder.repository_root;
                    }
                }
                // 从 current_terminal 提取当前工作目录
                if (ideState.current_terminal?.current_working_directory) {
                    result.cwd = ideState.current_terminal.current_working_directory;
                }
            }
        }
    }
    return result;
}
// 构建系统提示
function buildSystemPrompt(req: any) {
    const parts: string[] = [];
    // 提取工作区信息并添加到系统提示
    const workspaceInfo = extractWorkspaceInfo(req);
    if (workspaceInfo.workspacePath || workspaceInfo.cwd || workspaceInfo.repositoryRoot) {
        const wsInfo: string[] = [];
        const workspacePath = workspaceInfo.workspacePath || workspaceInfo.cwd || '';
        const repoRoot = workspaceInfo.repositoryRoot || '';

        // 计算工作区相对于仓库根目录的路径
        let relativeWorkspace = '';
        if (repoRoot && workspacePath && workspacePath.startsWith(repoRoot)) {
            relativeWorkspace = workspacePath.substring(repoRoot.length).replace(/^\//, '');
        }

        wsInfo.push(`Workspace folder: ${workspacePath}`);
        if (repoRoot && repoRoot !== workspacePath) {
            wsInfo.push(`Repository root: ${repoRoot}`);
        }
        if (workspaceInfo.cwd && workspaceInfo.cwd !== workspacePath) {
            wsInfo.push(`Current working directory: ${workspaceInfo.cwd}`);
        }
        if (workspaceInfo.currentFile) {
            wsInfo.push(`Current file: ${workspaceInfo.currentFile}`);
        }

        // 构建更明确的路径指导
        let pathGuidance = '';
        if (relativeWorkspace) {
            pathGuidance = `
CRITICAL PATH INSTRUCTIONS:
- The repository root is: ${repoRoot}
- The user's workspace is: ${workspacePath}
- The workspace is located at "${relativeWorkspace}" relative to the repository root
- For file operations (save-file, view, remove-files), paths are relative to the REPOSITORY ROOT
- Therefore, to create a file in the workspace, you MUST prefix paths with "${relativeWorkspace}/"
- Example: To create "myfile.txt" in the workspace, use path="${relativeWorkspace}/myfile.txt"
- Example: To create "doc/readme.md" in the workspace, use path="${relativeWorkspace}/doc/readme.md"
- For launch-process, use absolute paths or set cwd to "${workspacePath}"`;
        } else {
            pathGuidance = `
IMPORTANT: All file paths for save-file, view, and other file tools should be relative to: ${workspacePath}`;
        }

        parts.push(`<workspace_context>
${wsInfo.join('\n')}
${pathGuidance}
</workspace_context>`);
    }
    if (req.user_guidelines) {
        parts.push(`# User Guidelines\n${req.user_guidelines}`);
    }
    if (req.workspace_guidelines) {
        parts.push(`# Workspace Guidelines\n${req.workspace_guidelines}`);
    }
    // 添加 Agent Memories 支持
    if (req.agent_memories) {
        parts.push(`# Memories\nHere are the memories from previous interactions between the AI assistant (you) and the user:\n\`\`\`\n${req.agent_memories}\n\`\`\``);
    }
    // 处理 rules 数组
    if (req.rules && Array.isArray(req.rules) && req.rules.length > 0) {
        const rulesContent: string[] = [];
        for (const rule of req.rules) {
            if (typeof rule === 'object' && rule.content) {
                const ruleName = rule.path || rule.name || 'unnamed';
                const ruleDesc = rule.description ? ` - ${rule.description}` : '';
                rulesContent.push(`## Rule: ${ruleName}${ruleDesc}\n${rule.content}`);
            }
            else if (typeof rule === 'string') {
                rulesContent.push(rule);
            }
        }
        if (rulesContent.length > 0) {
            parts.push(`# Additional Rules\n${rulesContent.join('\n\n')}`);
        }
    }
    return parts.join('\n\n');
}
// 核心：处理 chat-stream 请求（带会话级队列防止并发冲突）
function handleChatStream(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
        try {
            const augmentReq = JSON.parse(body);
            const conversationId = augmentReq.conversation_id || '';
            const historyCount = augmentReq.chat_history?.length || 0;
            outputChannel.appendLine(`[CHAT-STREAM] message: "${(augmentReq.message || '').slice(0, 50)}..." history: ${historyCount}`);

            // ===== 会话级请求队列 =====
            // 防止同一会话的并发请求导致工具在 checkingSafety 阶段被取消
            const pendingRequest = conversationQueues.get(conversationId);
            if (pendingRequest) {
                outputChannel.appendLine(`[QUEUE] Waiting for pending request on conversation ${conversationId.substring(0, 8)}...`);
                try {
                    await pendingRequest;
                } catch {
                    // 忽略前一个请求的错误，继续处理当前请求
                }
                outputChannel.appendLine(`[QUEUE] Previous request completed, proceeding...`);
            }

            // 创建当前请求的 Promise，加入队列
            let resolveCurrentRequest: () => void;
            const currentRequestPromise = new Promise<void>((resolve) => {
                resolveCurrentRequest = resolve;
            });
            conversationQueues.set(conversationId, currentRequestPromise);

            try {
                // 详细日志：记录请求结构用于逆向分析
                outputChannel.appendLine(`[DEBUG] Request keys: ${Object.keys(augmentReq).join(', ')}`);
                if (augmentReq.nodes?.length) {
                    outputChannel.appendLine(`[DEBUG] nodes count: ${augmentReq.nodes.length}`);
                    augmentReq.nodes.forEach((n, i) => {
                        outputChannel.appendLine(`[DEBUG] node[${i}]: type=${n.type}, keys=${Object.keys(n).join(',')}`);
                        // 如果是 TOOL_RESULT (type=1)，打印详细信息
                        if (n.type === 1 && n.tool_result_node) {
                            outputChannel.appendLine(`[DEBUG] node[${i}] TOOL_RESULT: tool_use_id=${n.tool_result_node.tool_use_id}, content_len=${(n.tool_result_node.content || '').length}`);
                        }
                        // 如果是 IDE_STATE (type=4)，打印详细信息 - 这里包含工作区路径
                        if (n.type === 4 && n.ide_state_node) {
                            outputChannel.appendLine(`[DEBUG] node[${i}] IDE_STATE: ${JSON.stringify(n.ide_state_node).substring(0, 500)}`);
                        }
                    });
                }
                // 打印提取的工作区信息
                const workspaceInfo = extractWorkspaceInfo(augmentReq);
                outputChannel.appendLine(`[WORKSPACE] extracted: workspace=${workspaceInfo.workspacePath || 'N/A'}, repositoryRoot=${workspaceInfo.repositoryRoot || 'N/A'}, cwd=${workspaceInfo.cwd || 'N/A'}, currentFile=${workspaceInfo.currentFile || 'N/A'}`);
                // 打印 chat_history 中的 response_nodes 详情
                if (augmentReq.chat_history?.length) {
                    augmentReq.chat_history.forEach((ex, i) => {
                        const respNodes = ex.response_nodes || [];
                        const reqNodes = ex.request_nodes || [];
                        outputChannel.appendLine(`[DEBUG] chat_history[${i}]: response_nodes=${respNodes.length}, request_nodes=${reqNodes.length}`);
                        respNodes.forEach((n, j) => {
                            if (n.type === 5) {
                                outputChannel.appendLine(`[DEBUG] chat_history[${i}].response_nodes[${j}]: TOOL_USE, tool_use=${JSON.stringify(n.tool_use || n.tool_use_node || {}).slice(0, 200)}`);
                            }
                        });
                        reqNodes.forEach((n, j) => {
                            if (n.type === 1) {
                                outputChannel.appendLine(`[DEBUG] chat_history[${i}].request_nodes[${j}]: TOOL_RESULT, tool_result=${JSON.stringify(n.tool_result_node || {}).slice(0, 200)}`);
                            }
                        });
                    });
                }
                if (augmentReq.blobs) {
                    const blobKeys = Array.isArray(augmentReq.blobs)
                        ? `array[${augmentReq.blobs.length}]`
                        : Object.keys(augmentReq.blobs).slice(0, 5).join(',');
                    outputChannel.appendLine(`[DEBUG] blobs: ${blobKeys}`);
                }
                if (augmentReq.user_guided_blobs) {
                    const ugbKeys = Array.isArray(augmentReq.user_guided_blobs)
                        ? `array[${augmentReq.user_guided_blobs.length}]`
                        : Object.keys(augmentReq.user_guided_blobs).slice(0, 5).join(',');
                    outputChannel.appendLine(`[DEBUG] user_guided_blobs: ${ugbKeys}`);
                }
                if (augmentReq.path)
                    outputChannel.appendLine(`[DEBUG] path: ${augmentReq.path}`);
                if (augmentReq.prefix)
                    outputChannel.appendLine(`[DEBUG] prefix length: ${augmentReq.prefix.length}`);
                if (augmentReq.suffix)
                    outputChannel.appendLine(`[DEBUG] suffix length: ${augmentReq.suffix.length}`);
                // 调试 tool_definitions
                if (augmentReq.tool_definitions) {
                    outputChannel.appendLine(`[DEBUG] tool_definitions: ${JSON.stringify(augmentReq.tool_definitions).substring(0, 500)}`);
                } else {
                    outputChannel.appendLine(`[DEBUG] tool_definitions: undefined or null`);
                }
                if (!currentConfig.apiKey) {
                    sendAugmentError(res, `No API key for ${currentConfig.provider}`);
                    return;
                }
                // 转换为目标格式并转发
                if (isAnthropicFormat(currentConfig.provider)) {
                    await forwardToAnthropicStream(augmentReq, res);
                }
                else {
                    await forwardToOpenAIStream(augmentReq, res);
                }
            } finally {
                // 请求完成，从队列中移除并通知等待者
                resolveCurrentRequest!();
                // 仅当队列中仍是当前请求时才移除（避免竞态条件）
                if (conversationQueues.get(conversationId) === currentRequestPromise) {
                    conversationQueues.delete(conversationId);
                }
                outputChannel.appendLine(`[QUEUE] Request completed for conversation ${conversationId.substring(0, 8)}`);
            }
        }
        catch (error) {
            outputChannel.appendLine(`[ERROR] ${error.message}`);
            sendAugmentError(res, error.message);
        }
    });
}
// 发送 Augment 格式错误响应
function sendAugmentError(res, message) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end(JSON.stringify({
        text: `Error: ${message}`,
        nodes: [],
        stop_reason: 0
    }) + '\n');
}
// 转换 Augment tool_definitions 到 Anthropic tools 格式
function convertToolDefinitions(toolDefs) {
    if (!toolDefs || toolDefs.length === 0)
        return undefined;
    const tools = [];
    for (const def of toolDefs) {
        // Augment 格式：name, description, input_schema_json (字符串)
        if (def.name && def.input_schema_json) {
            try {
                const inputSchema = typeof def.input_schema_json === 'string'
                    ? JSON.parse(def.input_schema_json)
                    : def.input_schema_json;
                tools.push({
                    name: def.name,
                    description: def.description || '',
                    input_schema: inputSchema
                });
            }
            catch (e) {
                outputChannel.appendLine(`[DEBUG] Failed to parse input_schema_json for ${def.name}`);
            }
        }
        else if (def.name && def.input_schema) {
            // 已经是 Anthropic 格式
            tools.push({
                name: def.name,
                description: def.description || '',
                input_schema: def.input_schema
            });
        }
        else if (def.function) {
            // OpenAI 格式转换
            tools.push({
                name: def.function.name,
                description: def.function.description || '',
                input_schema: def.function.parameters || { type: 'object', properties: {} }
            });
        }
    }
    return tools.length > 0 ? tools : undefined;
}
// 转发到 Anthropic 格式 API (流式，发送增量)
async function forwardToAnthropicStream(augmentReq, res) {
    const messages = augmentToAnthropicMessages(augmentReq);
    const system = buildSystemPrompt(augmentReq);
    // 提取工作区信息，用于后续路径修正
    const workspaceInfo = extractWorkspaceInfo(augmentReq);
    // 调试 tool_definitions
    const rawTools = augmentReq.tool_definitions || [];
    outputChannel.appendLine(`[DEBUG] tool_definitions count: ${rawTools.length}`);
    if (rawTools.length > 0) {
        outputChannel.appendLine(`[DEBUG] tool_definitions[0] keys: ${Object.keys(rawTools[0]).join(',')}`);
    }
    const tools = convertToolDefinitions(rawTools);
    // MiniMax Prompt 缓存：在 system 和 tools 的最后一个元素添加 cache_control
    // 缓存顺序：tools → system → messages
    // 缓存生命周期 5 分钟，命中时自动刷新
    let systemContent = undefined;
    if (system) {
        if (currentConfig.provider === 'minimax' && currentConfig.enableCache) {
            // 将 system 转为 content block 格式，在最后添加 cache_control
            systemContent = [
                {
                    type: 'text',
                    text: system,
                    cache_control: { type: 'ephemeral' }
                }
            ];
            outputChannel.appendLine(`[DEBUG] MiniMax 缓存: 已在 system 添加 cache_control`);
        }
        else {
            systemContent = system;
        }
    }
    // 如果启用缓存且有 tools，在最后一个 tool 添加 cache_control
    let cachedTools = tools;
    if (currentConfig.provider === 'minimax' && currentConfig.enableCache && tools && tools.length > 0) {
        cachedTools = tools.map((tool, index) => {
            if (index === tools.length - 1) {
                return { ...tool, cache_control: { type: 'ephemeral' } };
            }
            return tool;
        });
        outputChannel.appendLine(`[DEBUG] MiniMax 缓存: 已在最后一个 tool 添加 cache_control`);
    }
    // max_tokens 设为 GLM-4.7/4.6 最大输出 128K 的 90% ≈ 115000
    const requestBody: any = {
        model: currentConfig.model,
        max_tokens: 115000,
        system: systemContent,
        messages: messages,
        stream: true
    };
    if (cachedTools && cachedTools.length > 0) {
        requestBody.tools = cachedTools;
        outputChannel.appendLine(`[DEBUG] Tools: ${cachedTools.length} definitions`);
    }
    const apiBody = JSON.stringify(requestBody);
    // 调试：检查消息格式
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (typeof msg.content === 'string') {
            outputChannel.appendLine(`[DEBUG] Message[${i}] role=${msg.role}, content=string(${msg.content.length})`);
        }
        else if (Array.isArray(msg.content)) {
            const types = msg.content.map(p => p.type).join(',');
            outputChannel.appendLine(`[DEBUG] Message[${i}] role=${msg.role}, content=array[${msg.content.length}] types=[${types}]`);
        }
    }
    outputChannel.appendLine(`[API] Sending to ${currentConfig.baseUrl} with ${messages.length} messages`);
    const url = new url_1.URL(currentConfig.baseUrl);
    const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': currentConfig.apiKey,
            'anthropic-version': '2023-06-01'
        }
    };
    const apiReq = https.request(options, (apiRes) => {
        if (apiRes.statusCode !== 200) {
            let errorBody = '';
            apiRes.on('data', c => errorBody += c);
            apiRes.on('end', () => {
                outputChannel.appendLine(`[API ERROR] Status ${apiRes.statusCode}: ${errorBody.slice(0, 200)}`);
                sendAugmentError(res, `API Error ${apiRes.statusCode}`);
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        let buffer = '';
        // 跟踪当前 tool_use block
        let currentToolUse = null;
        // 跟踪是否有 tool_use 被发送
        let hasToolUse = false;
        // 跟踪 API 返回的 stop_reason
        let apiStopReason = '';
        // MiniMax Interleaved Thinking: 跟踪当前 thinking block
        let currentThinking = null;
        let isInThinkingBlock = false;
        apiRes.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (!data || data === '[DONE]')
                        continue;
                    try {
                        const event = JSON.parse(data);
                        // 判断是否启用思考模式显示
                        const shouldShowThinking = (currentConfig.provider === 'minimax' && currentConfig.enableInterleavedThinking) ||
                            (currentConfig.provider === 'deepseek' && currentConfig.enableThinking);
                        // 思考模式: 处理 thinking 块开始 (MiniMax / DeepSeek)
                        if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
                            if (shouldShowThinking) {
                                isInThinkingBlock = true;
                                currentThinking = { thinking: '' };
                                outputChannel.appendLine(`[DEBUG] Thinking block start`);
                                // 发送 thinking 开始标记（用 <think> 标签包裹，Augment 会存储这个文本）
                                res.write(JSON.stringify({ text: '<think>\n', nodes: [], stop_reason: 0 }) + '\n');
                            }
                        }
                        // 思考模式: 处理 thinking 增量
                        if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && isInThinkingBlock && currentThinking) {
                            const thinkingDelta = event.delta.thinking || '';
                            currentThinking.thinking += thinkingDelta;
                            // 将 thinking 内容作为文本流式输出，用户可以看到思考过程
                            // Augment 会将其保存到 response_text 中
                            res.write(JSON.stringify({ text: thinkingDelta, nodes: [], stop_reason: 0 }) + '\n');
                        }
                        // 思考模式: 处理 thinking 块结束
                        if (event.type === 'content_block_stop' && isInThinkingBlock && currentThinking) {
                            outputChannel.appendLine(`[DEBUG] Thinking block end, length: ${currentThinking.thinking.length}`);
                            // 发送 thinking 结束标记
                            res.write(JSON.stringify({ text: '\n</think>\n\n', nodes: [], stop_reason: 0 }) + '\n');
                            isInThinkingBlock = false;
                            currentThinking = null;
                        }
                        // 处理文本增量
                        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                            const delta = event.delta.text;
                            res.write(JSON.stringify({ text: delta, nodes: [], stop_reason: 0 }) + '\n');
                        }
                        // 处理 tool_use 开始
                        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
                            currentToolUse = {
                                id: event.content_block.id,
                                name: event.content_block.name,
                                inputJson: ''
                            };
                            outputChannel.appendLine(`[DEBUG] Tool use start: ${event.content_block.name}`);
                        }
                        // 处理 tool_use 参数增量
                        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && currentToolUse) {
                            currentToolUse.inputJson += event.delta.partial_json;
                        }
                        // 处理 tool_use 结束
                        if (event.type === 'content_block_stop' && currentToolUse) {
                            try {
                                const input = JSON.parse(currentToolUse.inputJson || '{}');

                                // ========== 路径修正逻辑 ==========
                                // Augment 的文件工具使用 repository_root 作为基准路径
                                // 如果用户打开的是仓库的子目录，需要把相对路径转换为相对于仓库根目录的路径
                                const fileTools = ['save-file', 'view', 'remove-files', 'str-replace-editor'];
                                if (fileTools.includes(currentToolUse.name) && workspaceInfo) {
                                    const workspacePath = workspaceInfo.workspacePath || '';
                                    const repoRoot = workspaceInfo.repositoryRoot || '';

                                    // 计算工作区相对于仓库根目录的前缀
                                    let relativePrefix = '';
                                    if (repoRoot && workspacePath && workspacePath.startsWith(repoRoot) && workspacePath !== repoRoot) {
                                        relativePrefix = workspacePath.substring(repoRoot.length).replace(/^\//, '');
                                    }

                                    if (relativePrefix) {
                                        // 修正 path 参数
                                        if (input.path && typeof input.path === 'string' && !input.path.startsWith('/') && !input.path.startsWith(relativePrefix)) {
                                            const originalPath = input.path;
                                            input.path = relativePrefix + '/' + input.path;
                                            outputChannel.appendLine(`[PATH FIX] ${currentToolUse.name}: "${originalPath}" -> "${input.path}" (prefix: ${relativePrefix})`);
                                        }

                                        // 修正 file_paths 参数 (用于 remove-files)
                                        if (input.file_paths && Array.isArray(input.file_paths)) {
                                            input.file_paths = input.file_paths.map((p: string) => {
                                                if (typeof p === 'string' && !p.startsWith('/') && !p.startsWith(relativePrefix)) {
                                                    const newPath = relativePrefix + '/' + p;
                                                    outputChannel.appendLine(`[PATH FIX] ${currentToolUse.name} file_paths: "${p}" -> "${newPath}"`);
                                                    return newPath;
                                                }
                                                return p;
                                            });
                                        }
                                    }
                                }
                                // ========== 路径修正逻辑结束 ==========

                                // ========== Playwright 工具参数修正 ==========
                                if (currentToolUse.name.includes('Playwright')) {
                                    // 1. browser_wait_for_Playwright: time 参数需要是数字
                                    if (currentToolUse.name === 'browser_wait_for_Playwright') {
                                        if (input.time !== undefined && typeof input.time === 'string') {
                                            const numTime = parseInt(input.time, 10);
                                            if (!isNaN(numTime)) {
                                                outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_wait_for: time "${input.time}" -> ${numTime}`);
                                                input.time = numTime;
                                            }
                                        }
                                        if (input.wait_time !== undefined && input.time === undefined) {
                                            const numTime = typeof input.wait_time === 'string' ? parseInt(input.wait_time, 10) : input.wait_time;
                                            outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_wait_for: wait_time -> time = ${numTime}`);
                                            input.time = numTime;
                                            delete input.wait_time;
                                        }
                                    }
                                    // 2. browser_run_code_Playwright: code -> function
                                    if (currentToolUse.name === 'browser_run_code_Playwright') {
                                        if (input.code !== undefined && input.function === undefined) {
                                            outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_run_code: code -> function`);
                                            input.function = input.code;
                                            delete input.code;
                                        }
                                    }
                                    // 3. browser_evaluate_Playwright: expression/code -> function
                                    if (currentToolUse.name === 'browser_evaluate_Playwright') {
                                        if (input.expression !== undefined && input.function === undefined) {
                                            outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_evaluate: expression -> function`);
                                            input.function = input.expression;
                                            delete input.expression;
                                        }
                                        // GLM 有时用 'code' 而不是 'expression'
                                        if (input.code !== undefined && input.function === undefined) {
                                            outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_evaluate: code -> function`);
                                            input.function = input.code;
                                            delete input.code;
                                        }
                                    }
                                }
                                // ========== Playwright 工具参数修正结束 ==========

                                // ========== view 工具参数修正 ==========
                                // GLM 模型可能把 view_range 数组参数生成为字符串格式 "[1, 200]"
                                // 需要转换为真正的数组 [1, 200]
                                if (currentToolUse.name === 'view' && input.view_range !== undefined) {
                                    if (typeof input.view_range === 'string') {
                                        try {
                                            // 尝试解析字符串格式的数组 "[1, 200]"
                                            const parsed = JSON.parse(input.view_range);
                                            if (Array.isArray(parsed) && parsed.length === 2) {
                                                outputChannel.appendLine(`[VIEW FIX] view_range: "${input.view_range}" -> [${parsed[0]}, ${parsed[1]}]`);
                                                input.view_range = parsed.map((n: any) => typeof n === 'string' ? parseInt(n, 10) : n);
                                            }
                                        } catch (e) {
                                            outputChannel.appendLine(`[VIEW FIX] Failed to parse view_range: ${input.view_range}`);
                                        }
                                    }
                                }
                                // ========== view 工具参数修正结束 ==========

                                // ========== save-file 工具参数修正 ==========
                                // GLM 模型可能用 'content' 或 'file' 而不是 'file_content'
                                if (currentToolUse.name === 'save-file') {
                                    if (input.content !== undefined && input.file_content === undefined) {
                                        outputChannel.appendLine(`[SAVE-FILE FIX] mapping 'content' to 'file_content'`);
                                        input.file_content = input.content;
                                        delete input.content;
                                    }
                                    if (input.file !== undefined && input.file_content === undefined) {
                                        outputChannel.appendLine(`[SAVE-FILE FIX] mapping 'file' to 'file_content'`);
                                        input.file_content = input.file;
                                        delete input.file;
                                    }
                                }
                                // ========== save-file 工具参数修正结束 ==========

                                // Augment 格式的 tool node (ResponseNodeType: 5=TOOL_USE)
                                // 逆向分析确认：Augment 期望 tool_use 属性包含 tool_use_id, tool_name, input_json
                                const toolNode = {
                                    type: 5, // TOOL_USE (逆向分析确认)
                                    tool_use: {
                                        tool_use_id: currentToolUse.id,
                                        tool_name: currentToolUse.name,
                                        input_json: JSON.stringify(input)
                                    }
                                };
                                const responseData = { text: '', nodes: [toolNode], stop_reason: 0 };
                                const responseStr = JSON.stringify(responseData);
                                res.write(responseStr + '\n');
                                outputChannel.appendLine(`[DEBUG] Tool use complete: ${currentToolUse.name}, id: ${currentToolUse.id}`);
                                outputChannel.appendLine(`[DEBUG] Sending tool_use response: ${responseStr.slice(0, 500)}`);
                                hasToolUse = true;
                            }
                            catch (e) {
                                outputChannel.appendLine(`[DEBUG] Tool parse error: ${e}`);
                            }
                            currentToolUse = null;
                        }
                        // 跟踪 message_delta 中的 stop_reason
                        if (event.type === 'message_delta' && event.delta?.stop_reason) {
                            apiStopReason = event.delta.stop_reason;
                            outputChannel.appendLine(`[DEBUG] API stop_reason: ${apiStopReason}`);
                        }
                    }
                    catch { }
                }
            }
        });
        apiRes.on('end', () => {
            // 发送结束标记
            // Augment StopReason 枚举 (逆向分析确认):
            // 0 = UNSPECIFIED (继续)
            // 1 = END_TURN (完成)
            // 2 = MAX_TOKENS
            // 3 = TOOL_USE (需要等待工具结果)
            const stopReason = (hasToolUse || apiStopReason === 'tool_use') ? 3 : 1;
            res.write(JSON.stringify({ text: '', nodes: [], stop_reason: stopReason }) + '\n');
            res.end();
            outputChannel.appendLine(`[API] Stream complete, stop_reason=${stopReason} (hasToolUse=${hasToolUse}, apiStopReason=${apiStopReason})`);
        });
    });
    apiReq.on('error', (err) => {
        outputChannel.appendLine(`[API ERROR] ${err.message}`);
        sendAugmentError(res, err.message);
    });
    apiReq.write(apiBody);
    apiReq.end();
}
// 将 Augment tool_definitions 转换为 OpenAI tools 格式
function convertToolDefinitionsToOpenAI(toolDefs) {
    if (!toolDefs || toolDefs.length === 0)
        return undefined;
    const tools = [];

    // ===== 添加 codebase_search 工具（使用本地 RAG 索引） =====
    // 这个工具让 AI 可以主动搜索项目代码库和文档
    if (ragIndex) {
        tools.push({
            type: 'function',
            function: {
                name: 'codebase_search',
                description: '搜索项目代码库和文档，查找相关代码片段。在需要了解项目结构、查找特定功能实现、或查阅文档时使用此工具。优先使用此工具而不是盲目浏览文件。',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: '搜索查询，描述你要找的代码、功能或文档内容。例如："精灵图片区域参数"、"用户登录验证逻辑"、"ListView API 文档"'
                        }
                    },
                    required: ['query'],
                    additionalProperties: false
                }
            }
        });
        outputChannel.appendLine(`[RAG] Added codebase_search tool to available tools`);
    }

    for (const def of toolDefs) {
        // Augment 格式: { name, description, input_json_schema }
        // OpenAI 格式: { type: "function", function: { name, description, parameters } }
        if (def.name) {
            // 调试：打印 save-file 工具的 schema
            if (def.name === 'save-file') {
                outputChannel.appendLine(`[DEBUG] save-file tool schema: ${JSON.stringify(def.input_json_schema)}`);
            }
            // 解析 input_json_schema（可能是字符串）
            let parameters = def.input_json_schema;
            if (typeof parameters === 'string') {
                try {
                    parameters = JSON.parse(parameters);
                }
                catch (e) {
                    outputChannel.appendLine(`[WARN] Failed to parse input_json_schema for ${def.name}: ${e}`);
                    parameters = { type: 'object', properties: {} };
                }
            }
            tools.push({
                type: 'function',
                function: {
                    name: def.name,
                    description: def.description || '',
                    parameters: parameters || { type: 'object', properties: {} }
                }
            });
        }
    }
    return tools.length > 0 ? tools : undefined;
}
// 保存每个会话的原始用户消息（解决 Augment 不在 chat_history 中保存 request_message 的问题）
const conversationUserMessages = new Map<string, string>();

// 将 Augment 请求转换为 OpenAI 格式消息
function augmentToOpenAIMessages(req) {
    const messages = [];
    // 收集所有 tool_use 和对应的 tool_result
    // Augment 的 chat_history 结构:
    //   exchange[i].response_nodes 包含 tool_use
    //   exchange[i].request_nodes 或 exchange[i+1].request_nodes 包含对应的 tool_result
    // OpenAI 要求: assistant(tool_calls) 后必须紧跟所有对应的 tool 消息

    // 🔧 关键修复：Augment 的 chat_history 中 exchange.request_message 总是为空！
    // 用户的真正消息只在第一轮请求的 req.message 中
    // 后续工具调用请求的 req.message 是 "..." 占位符
    // 因此需要：
    // 1. 第一轮请求时保存用户消息
    // 2. 后续请求时从缓存中恢复

    const conversationId = req.conversation_id || '';
    const currentMessage = req.message || '';
    const historyLength = (req.chat_history || []).length;

    // 保存原始用户消息（仅当是新对话开始时，即 history=0 且 message 不是占位符）
    if (historyLength === 0 && currentMessage && currentMessage !== '...') {
        conversationUserMessages.set(conversationId, currentMessage);
        outputChannel.appendLine(`[DEBUG] OpenAI: Saved original user message for conversation ${conversationId}: "${currentMessage.substring(0, 50)}..."`);
    }

    // 获取缓存的用户消息
    const savedUserMessage = conversationUserMessages.get(conversationId) || '';

    // 构建 tool_use_id -> tool_result 的映射
    const toolResultMap = new Map();
    if (req.chat_history) {
        for (const exchange of req.chat_history) {
            for (const node of exchange.request_nodes || []) {
                if (node.type === 1 && node.tool_result_node) {
                    const tr = node.tool_result_node;
                    const id = tr.tool_use_id || tr.id;
                    toolResultMap.set(id, tr);
                }
            }
        }
    }
    // 当前请求的 tool_result 也加入映射
    for (const node of req.nodes || []) {
        if (node.type === 1 && node.tool_result_node) {
            const tr = node.tool_result_node;
            const id = tr.tool_use_id || tr.id;
            toolResultMap.set(id, tr);
        }
    }
    outputChannel.appendLine(`[DEBUG] OpenAI: Built tool result map with ${toolResultMap.size} entries`);

    // 处理聊天历史，确保 assistant(tool_calls) 后紧跟对应的 tool 消息
    if (req.chat_history) {
        for (let i = 0; i < req.chat_history.length; i++) {
            const exchange = req.chat_history[i];
            // 用户请求消息
            // 🔧 修复：exchange.request_message 在 Augment 中总是为空
            // 对于第一轮（i=0），使用缓存的用户消息
            let userContent = exchange.request_message || '';

            // 检查响应中是否有内容 (需要提前检查以决定是否插入占位 user 消息)
            const responseNodes = exchange.response_nodes || [];
            const hasResponse = responseNodes.length > 0 || exchange.response_text || exchange.response_message;

            // GLM API 要求: 消息序列必须是 user -> assistant 交替
            // 如果有 assistant 响应但没有 user 消息，需要插入用户消息
            if (!userContent && hasResponse && messages.length === 0) {
                // 第一轮对话，但 exchange 中没有用户消息
                // 🔧 关键修复：使用缓存的原始用户消息，而不是 "..."
                if (savedUserMessage) {
                    userContent = savedUserMessage;
                    outputChannel.appendLine(`[DEBUG] OpenAI: Using cached user message for first exchange: "${savedUserMessage.substring(0, 50)}..."`);
                } else {
                    // 最后的 fallback，只有在没有任何信息时才用占位符
                    userContent = '...';
                    outputChannel.appendLine(`[DEBUG] OpenAI: No cached message found, inserted placeholder for first exchange`);
                }
            }

            if (userContent) {
                messages.push({ role: 'user', content: userContent });
            }
            // 检查响应中是否有 tool_use（responseNodes 已在上面定义）
            const toolCalls = [];
            let textContent = '';
            for (const node of responseNodes) {
                if (node.type === 5 && node.tool_use) { // TOOL_USE
                    const tu = node.tool_use;
                    toolCalls.push({
                        id: tu.tool_use_id || tu.id,
                        type: 'function',
                        function: {
                            name: tu.tool_name || tu.name,
                            arguments: tu.input_json || '{}'
                        }
                    });
                }
                else if (node.type === 0 && node.text_node) {
                    textContent += node.text_node.content || '';
                }
            }
            // 添加 assistant 消息
            if (toolCalls.length > 0) {
                // 有工具调用
                const assistantMsg: any = { role: 'assistant', tool_calls: toolCalls };
                if (textContent)
                    assistantMsg.content = textContent;
                messages.push(assistantMsg);
                outputChannel.appendLine(`[DEBUG] OpenAI: Added assistant with ${toolCalls.length} tool_calls`);

                // 关键修复：紧跟添加对应的 tool 结果
                for (const tc of toolCalls) {
                    const tr = toolResultMap.get(tc.id);
                    if (tr) {
                        messages.push({
                            role: 'tool',
                            tool_call_id: tc.id,
                            content: tr.content || ''
                        });
                        outputChannel.appendLine(`[DEBUG] OpenAI: Added tool result for ${tc.id}`);
                        toolResultMap.delete(tc.id); // 标记已使用
                    }
                }
            }
            else {
                // 普通文本响应
                const response = exchange.response_text || exchange.response_message || '';
                if (response) {
                    messages.push({ role: 'assistant', content: response });
                }
            }
        }
    }
    // 剩余未匹配的 tool_result（当前请求的）
    for (const [id, tr] of toolResultMap) {
        messages.push({
            role: 'tool',
            tool_call_id: id,
            content: tr.content || ''
        });
        outputChannel.appendLine(`[DEBUG] OpenAI: Added remaining tool result for ${id}`);
    }
    // 添加当前用户消息
    // 注意：currentMessage 已在函数开头定义，直接使用即可
    if (currentMessage && currentMessage !== '...') { // "..." 是工具结果继续的占位符
        messages.push({ role: 'user', content: currentMessage });
    }
    return messages;
}
// ========== OpenAI API 请求结果接口 ==========
interface OpenAIRequestResult {
    text: string;                    // 累积的文本内容（包含 thinking 标签）
    toolCalls: Array<{               // 工具调用列表
        id: string;
        name: string;
        arguments: string;           // JSON 字符串
    }>;
    finishReason: string | null;     // 结束原因: 'stop', 'tool_calls', 'length' 等
    thinkingContent: string;         // 思考内容（用于调试）
}

// ========== 执行单次 OpenAI API 请求 ==========
// 返回结构化结果，不直接写入响应流
async function executeOpenAIRequest(
    messages: any[],
    tools: any[],
    apiEndpoint: string,
    apiKey: string,
    model: string
): Promise<OpenAIRequestResult> {
    return new Promise((resolve, reject) => {
        const requestBody: any = {
            model: model,
            max_tokens: 115000,
            messages: messages,
            stream: true
        };

        if (tools && tools.length > 0) {
            requestBody.tools = tools;
            requestBody.tool_choice = 'auto';
        }

        const apiBody = JSON.stringify(requestBody);
        const url = new url_1.URL(apiEndpoint);

        const options = {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            }
        };

        outputChannel.appendLine(`[API-EXEC] Sending request to ${apiEndpoint}, messages=${messages.length}`);

        const result: OpenAIRequestResult = {
            text: '',
            toolCalls: [],
            finishReason: null,
            thinkingContent: ''
        };

        let buffer = '';
        let inThinking = false;
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

        const apiReq = https.request(options, (apiRes: any) => {
            if (apiRes.statusCode !== 200) {
                let errorBody = '';
                apiRes.on('data', (c: any) => errorBody += c);
                apiRes.on('end', () => {
                    outputChannel.appendLine(`[API-EXEC ERROR] Status ${apiRes.statusCode}: ${errorBody.slice(0, 300)}`);
                    reject(new Error(`API Error ${apiRes.statusCode}: ${errorBody.slice(0, 100)}`));
                });
                return;
            }

            apiRes.on('data', (chunk: any) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (!data || data === '[DONE]') continue;

                        try {
                            const event = JSON.parse(data);
                            const choice = event.choices?.[0];
                            const delta = choice?.delta?.content || '';
                            const reasoningDelta = choice?.delta?.reasoning_content || '';
                            const toolCallsDelta = choice?.delta?.tool_calls;

                            if (choice?.finish_reason) {
                                result.finishReason = choice.finish_reason;
                            }

                            // 处理思考内容
                            if (reasoningDelta) {
                                if (!inThinking) {
                                    inThinking = true;
                                    result.text += '<think>\n';
                                }
                                result.text += reasoningDelta;
                                result.thinkingContent += reasoningDelta;
                            }

                            // 处理正常内容
                            if (delta) {
                                if (inThinking) {
                                    inThinking = false;
                                    result.text += '\n</think>\n\n';
                                }
                                result.text += delta;
                            }

                            // 处理工具调用
                            if (toolCallsDelta && Array.isArray(toolCallsDelta)) {
                                for (const tc of toolCallsDelta) {
                                    const idx = tc.index ?? 0;

                                    if (!toolCallsMap.has(idx)) {
                                        toolCallsMap.set(idx, {
                                            id: tc.id || `tool_${idx}_${Date.now()}`,
                                            name: tc.function?.name || '',
                                            arguments: ''
                                        });
                                    }

                                    const state = toolCallsMap.get(idx)!;
                                    if (tc.id) state.id = tc.id;
                                    if (tc.function?.name) state.name = tc.function.name;

                                    const argsValue = tc.function?.arguments || tc.function?.parameters || tc.arguments || tc.parameters;
                                    if (argsValue !== undefined && argsValue !== null) {
                                        state.arguments += typeof argsValue === 'object' ? JSON.stringify(argsValue) : argsValue;
                                    }
                                }
                            }
                        } catch (e) {
                            // 解析错误，继续处理
                        }
                    }
                }
            });

            apiRes.on('end', () => {
                // 关闭思考模式
                if (inThinking) {
                    result.text += '\n</think>\n\n';
                }

                // 转换工具调用
                for (const [_, tc] of toolCallsMap) {
                    result.toolCalls.push(tc);
                }

                outputChannel.appendLine(`[API-EXEC] Request complete: text_len=${result.text.length}, tool_calls=${result.toolCalls.length}, finish=${result.finishReason}`);
                resolve(result);
            });

            apiRes.on('error', (err: any) => {
                reject(err);
            });
        });

        apiReq.on('error', (err: any) => {
            outputChannel.appendLine(`[API-EXEC ERROR] Request failed: ${err.message}`);
            reject(err);
        });

        apiReq.on('timeout', () => {
            apiReq.destroy();
            reject(new Error('Request timeout'));
        });

        apiReq.write(apiBody);
        apiReq.end();
    });
}

// ========== 执行本地 RAG 搜索并格式化结果 ==========
// 使用 <details> 标签实现可折叠的结构化输出
function executeRAGSearch(query: string): string {
    if (!ragIndex) {
        return '⚠️ RAG 索引未初始化';
    }

    const startTime = Date.now();
    const results = ragIndex.search(query, 8);
    const searchTime = Date.now() - startTime;

    outputChannel.appendLine(`[RAG] Search "${query.substring(0, 50)}..." completed in ${searchTime}ms, found ${results.length} results`);

    if (results.length === 0) {
        return `未找到与 "${query}" 相关的代码。请尝试其他关键词。`;
    }

    // 格式化搜索结果 - 使用 details 标签实现折叠
    let output = `## 🔍 代码库搜索\n\n`;
    output += `> 查询: \`${query}\` | 找到 ${results.length} 个结果 | 耗时 ${searchTime}ms\n\n`;

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const score = (r.score * 100).toFixed(1);
        const fileName = r.path.split('/').pop() || r.path;

        // 使用 details 标签创建可折叠区域
        output += `<details${i === 0 ? ' open' : ''}>\n`;
        output += `<summary><strong>📄 ${fileName}</strong> <code>${score}%</code> - ${r.path}</summary>\n\n`;

        // 显示匹配的关键词
        if (r.matchedTerms && r.matchedTerms.length > 0) {
            output += `**匹配词:** ${r.matchedTerms.slice(0, 5).map(t => `\`${t}\``).join(' ')}\n\n`;
        }

        // 显示代码片段
        const lines = r.content.split('\n');
        const previewLines = lines.slice(0, 20);
        const preview = previewLines.join('\n');

        // 根据文件扩展名确定语言
        const ext = r.path.split('.').pop() || '';
        const langMap: Record<string, string> = {
            'ts': 'typescript', 'js': 'javascript', 'py': 'python',
            'md': 'markdown', 'json': 'json', 'html': 'html', 'css': 'css',
            'rs': 'rust', 'go': 'go', 'java': 'java', 'c': 'c', 'cpp': 'cpp'
        };
        const lang = langMap[ext] || '';

        output += `\`\`\`${lang}\n${preview}`;
        if (lines.length > 20) {
            output += `\n// ... 还有 ${lines.length - 20} 行`;
        }
        output += `\n\`\`\`\n\n</details>\n\n`;
    }

    return output;
}

// ========== 判断是否为代码搜索工具 ==========
// 统一处理多种工具名称变体：codebase_search, codebase-search, codebase-retrieval
function isCodebaseSearchTool(name: string): boolean {
    return name === 'codebase_search' || name === 'codebase-search' || name === 'codebase-retrieval';
}

// ========== 检查是否只有 codebase_search 工具调用 ==========
function hasOnlyCodebaseSearchCalls(toolCalls: Array<{ name: string }>): boolean {
    if (toolCalls.length === 0) return false;
    return toolCalls.every(tc => isCodebaseSearchTool(tc.name));
}

// ========== 过滤出 codebase_search 工具调用 ==========
function filterCodebaseSearchCalls(toolCalls: Array<{ id: string; name: string; arguments: string }>): Array<{ id: string; query: string }> {
    return toolCalls
        .filter(tc => isCodebaseSearchTool(tc.name))
        .map(tc => {
            try {
                const args = JSON.parse(tc.arguments || '{}');
                // 兼容不同的参数名：query, information_request
                return { id: tc.id, query: args.query || args.information_request || '' };
            } catch {
                return { id: tc.id, query: '' };
            }
        });
}

// 转发到 OpenAI 格式 API (流式，发送增量)
// 注意：OpenAI 格式不完全支持多模态，图片会转为描述文本
// 🔥 v1.5.0: 支持 codebase_search 工具循环调用
async function forwardToOpenAIStream(augmentReq: any, res: any) {
    const system = buildSystemPrompt(augmentReq);
    // 提取工作区信息，用于后续路径修正
    const workspaceInfo = extractWorkspaceInfo(augmentReq);
    // 转换工具定义
    const rawTools = augmentReq.tool_definitions || [];
    outputChannel.appendLine(`[DEBUG] tool_definitions count: ${rawTools.length}`);

    const tools = convertToolDefinitionsToOpenAI(rawTools);
    outputChannel.appendLine(`[DEBUG] OpenAI tools: ${tools ? tools.length : 0} definitions`);

    // 构建 OpenAI 格式消息
    const openaiMessages: any[] = [];
    if (system) {
        openaiMessages.push({ role: 'system', content: system });
    }

    // 使用专门的 OpenAI 消息转换函数
    const convertedMessages = augmentToOpenAIMessages(augmentReq);
    openaiMessages.push(...convertedMessages);
    outputChannel.appendLine(`[DEBUG] OpenAI messages: ${openaiMessages.length} total`);

    const apiEndpoint = currentConfig.baseUrl;
    const apiKey = currentConfig.apiKey;
    const model = currentConfig.model;

    // ========== 🔥 codebase_search 循环调用逻辑 ==========
    // 最多循环 5 次防止无限循环
    const MAX_ITERATIONS = 5;
    let iteration = 0;
    let currentMessages = [...openaiMessages];
    let accumulatedText = '';  // 累积所有文本输出

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

    try {
        while (iteration < MAX_ITERATIONS) {
            iteration++;
            outputChannel.appendLine(`[LOOP] Iteration ${iteration}/${MAX_ITERATIONS}`);

            // 执行 API 请求
            const result = await executeOpenAIRequest(currentMessages, tools, apiEndpoint, apiKey, model);

            // 发送文本内容到 Augment
            if (result.text) {
                res.write(JSON.stringify({ text: result.text, nodes: [], stop_reason: 0 }) + '\n');
                accumulatedText += result.text;
            }

            // 检查是否有工具调用
            if (result.toolCalls.length === 0 || result.finishReason === 'stop') {
                // 没有工具调用，正常结束
                outputChannel.appendLine(`[LOOP] No tool calls or stop, ending loop`);
                res.write(JSON.stringify({ text: '', nodes: [], stop_reason: 1 }) + '\n');
                res.end();
                return;
            }

            // 分离 codebase_search 调用和其他工具调用
            // 使用 isCodebaseSearchTool() 统一判断多种变体名称
            const codebaseSearchCalls = filterCodebaseSearchCalls(result.toolCalls);
            const otherToolCalls = result.toolCalls.filter(tc => !isCodebaseSearchTool(tc.name));

            outputChannel.appendLine(`[LOOP] Tool calls: codebase_search=${codebaseSearchCalls.length}, other=${otherToolCalls.length}`);

            // 如果有其他工具调用，需要转发给 Augment 处理
            if (otherToolCalls.length > 0) {
                outputChannel.appendLine(`[LOOP] Has other tool calls, forwarding to Augment`);

                // 如果同时有 codebase_search 调用，先执行它们并添加到消息中
                if (codebaseSearchCalls.length > 0) {
                    // 构造 assistant 消息（只包含 codebase_search 调用）
                    const csToolCalls = codebaseSearchCalls.map((cs, idx) => ({
                        id: cs.id,
                        type: 'function',
                        function: {
                            name: 'codebase_search',
                            arguments: JSON.stringify({ query: cs.query })
                        }
                    }));

                    currentMessages.push({
                        role: 'assistant',
                        content: result.text || null,
                        tool_calls: csToolCalls
                    });

                    // 执行 RAG 搜索并添加结果
                    for (const cs of codebaseSearchCalls) {
                        const searchResult = executeRAGSearch(cs.query);
                        currentMessages.push({
                            role: 'tool',
                            tool_call_id: cs.id,
                            content: searchResult
                        });

                        // 发送搜索结果摘要给用户（可选）
                        res.write(JSON.stringify({
                            text: `\n\n📚 **已搜索代码库** (查询: "${cs.query.substring(0, 30)}...")\n\n`,
                            nodes: [],
                            stop_reason: 0
                        }) + '\n');
                    }

                    // 继续下一轮循环（可能还会产生 codebase_search 调用）
                    continue;
                }

                // 没有 codebase_search，直接转发其他工具调用给 Augment
                for (const tc of otherToolCalls) {
                    const toolNode = await processToolCallForAugment(tc, workspaceInfo, result.finishReason);
                    if (toolNode) {
                        res.write(JSON.stringify({ text: '', nodes: [toolNode], stop_reason: 0 }) + '\n');
                    }
                }

                // 结束流，让 Augment 处理工具调用
                res.write(JSON.stringify({ text: '', nodes: [], stop_reason: 3 }) + '\n');
                res.end();
                return;
            }

            // 只有 codebase_search 调用，执行本地 RAG 搜索并继续循环
            if (codebaseSearchCalls.length > 0) {
                outputChannel.appendLine(`[LOOP] Processing ${codebaseSearchCalls.length} codebase_search calls`);

                // 构造 assistant 消息（包含 tool_calls）
                const toolCallsForMsg = codebaseSearchCalls.map((cs, idx) => ({
                    id: cs.id,
                    type: 'function',
                    function: {
                        name: 'codebase_search',
                        arguments: JSON.stringify({ query: cs.query })
                    }
                }));

                currentMessages.push({
                    role: 'assistant',
                    content: result.text || null,
                    tool_calls: toolCallsForMsg
                });

                // 执行每个 RAG 搜索并添加结果
                for (const cs of codebaseSearchCalls) {
                    const searchResult = executeRAGSearch(cs.query);

                    // 添加 tool result 到消息
                    currentMessages.push({
                        role: 'tool',
                        tool_call_id: cs.id,
                        content: searchResult
                    });

                    // 发送搜索进度提示给用户
                    res.write(JSON.stringify({
                        text: `\n\n🔍 **代码库搜索** (查询: "${cs.query}")\n${searchResult.split('\n').slice(0, 5).join('\n')}...\n\n`,
                        nodes: [],
                        stop_reason: 0
                    }) + '\n');
                }

                outputChannel.appendLine(`[LOOP] Added tool results, continuing to next iteration`);
                // 继续下一轮循环
                continue;
            }
        }

        // 达到最大迭代次数
        outputChannel.appendLine(`[LOOP] Max iterations reached`);
        res.write(JSON.stringify({
            text: '\n\n⚠️ 已达到最大工具调用次数限制。\n',
            nodes: [],
            stop_reason: 1
        }) + '\n');
        res.end();

    } catch (error: any) {
        outputChannel.appendLine(`[LOOP ERROR] ${error.message}`);
        sendAugmentError(res, error.message);
    }
}

// ========== 处理工具调用并转换为 Augment 格式 ==========
async function processToolCallForAugment(
    tc: { id: string; name: string; arguments: string },
    workspaceInfo: any,
    finishReason: string | null
): Promise<any> {
    outputChannel.appendLine(`[TOOL] Processing: ${tc.name}, id=${tc.id}`);

    // 警告：如果参数为空，可能是模型返回格式不兼容
    if (!tc.arguments || tc.arguments === '' || tc.arguments === '{}') {
        outputChannel.appendLine(`[WARN] Tool ${tc.name} has empty arguments!`);
    }

    let inputJson = tc.arguments || '{}';

    try {
        const parsed = JSON.parse(tc.arguments);

        // ========== 路径修正逻辑 ==========
        const fileTools = ['save-file', 'view', 'remove-files', 'str-replace-editor'];
        if (fileTools.includes(tc.name) && workspaceInfo) {
            const workspacePath = workspaceInfo.workspacePath || '';
            const repoRoot = workspaceInfo.repositoryRoot || '';

            let relativePrefix = '';
            if (repoRoot && workspacePath && workspacePath.startsWith(repoRoot) && workspacePath !== repoRoot) {
                relativePrefix = workspacePath.substring(repoRoot.length).replace(/^\//, '');
            }

            if (relativePrefix) {
                if (parsed.path && typeof parsed.path === 'string' && !parsed.path.startsWith('/') && !parsed.path.startsWith(relativePrefix)) {
                    parsed.path = relativePrefix + '/' + parsed.path;
                    outputChannel.appendLine(`[PATH FIX] ${tc.name}: path fixed with prefix ${relativePrefix}`);
                }

                if (parsed.file_paths && Array.isArray(parsed.file_paths)) {
                    parsed.file_paths = parsed.file_paths.map((p: string) => {
                        if (typeof p === 'string' && !p.startsWith('/') && !p.startsWith(relativePrefix)) {
                            return relativePrefix + '/' + p;
                        }
                        return p;
                    });
                }
            }
        }

        // ========== view 工具参数修正 ==========
        if (tc.name === 'view' && parsed.view_range !== undefined) {
            if (typeof parsed.view_range === 'string') {
                try {
                    const viewRangeParsed = JSON.parse(parsed.view_range);
                    if (Array.isArray(viewRangeParsed) && viewRangeParsed.length === 2) {
                        parsed.view_range = viewRangeParsed.map((n: any) => typeof n === 'string' ? parseInt(n, 10) : n);
                    }
                } catch (e) { /* ignore */ }
            }
        }

        // ========== str-replace-editor 工具参数修正 ==========
        if (tc.name === 'str-replace-editor') {
            if (!parsed.command) {
                if (parsed.old_str_1 !== undefined || parsed.old_str !== undefined) {
                    parsed.command = 'str_replace';
                } else if (parsed.insert_line_1 !== undefined || parsed.insert_line !== undefined) {
                    parsed.command = 'insert';
                }
            }

            const expectedReminder = 'ALWAYS BREAK DOWN EDITS INTO SMALLER CHUNKS OF AT MOST 150 LINES EACH.';
            if (!parsed.instruction_reminder) {
                parsed.instruction_reminder = expectedReminder;
            }

            // 参数名称映射
            if (parsed.old_str !== undefined && parsed.old_str_1 === undefined) {
                parsed.old_str_1 = parsed.old_str;
                delete parsed.old_str;
            }
            if (parsed.new_str !== undefined && parsed.new_str_1 === undefined) {
                parsed.new_str_1 = parsed.new_str;
                delete parsed.new_str;
            }
        }

        // ========== save-file 工具参数修正 ==========
        if (tc.name === 'save-file') {
            if (parsed.content !== undefined && parsed.file_content === undefined) {
                parsed.file_content = parsed.content;
                delete parsed.content;
            }
        }

        inputJson = JSON.stringify(parsed);

    } catch (e) {
        outputChannel.appendLine(`[TOOL] Arguments parse error: ${e}`);
        if (finishReason === 'length') {
            outputChannel.appendLine(`[TOOL] Skipping truncated tool call`);
            return null;
        }
    }

    return {
        type: 5, // TOOL_USE
        tool_use: {
            tool_use_id: tc.id,
            tool_name: tc.name,
            input_json: inputJson
        }
    };
}


async function startProxy() {
    if (proxyServer) {
        vscode.window.showWarningMessage('代理服务器已在运行');
        return;
    }
    const config = vscode.workspace.getConfiguration('augmentProxy');
    currentConfig.provider = config.get('provider', 'anthropic');
    currentConfig.port = config.get('port', 8765);
    currentConfig.baseUrl = config.get(`${currentConfig.provider}.baseUrl`, DEFAULT_BASE_URLS[currentConfig.provider]);
    currentConfig.model = config.get(`${currentConfig.provider}.model`, DEFAULT_MODELS[currentConfig.provider]);
    // MiniMax 特有配置
    if (currentConfig.provider === 'minimax') {
        currentConfig.enableCache = config.get('minimax.enableCache', true);
        currentConfig.enableInterleavedThinking = config.get('minimax.enableInterleavedThinking', true);
    }
    // DeepSeek 特有配置
    if (currentConfig.provider === 'deepseek') {
        currentConfig.enableThinking = config.get('deepseek.enableThinking', true);
    }
    // 从 secrets 获取 API Key
    const storedKey = await extensionContext.secrets.get(`apiKey.${currentConfig.provider}`);
    if (storedKey) {
        currentConfig.apiKey = storedKey;
    }
    else {
        const apiKey = await vscode.window.showInputBox({
            prompt: `请输入 ${PROVIDER_NAMES[currentConfig.provider]} API Key`,
            password: true,
            placeHolder: 'sk-...'
        });
        if (!apiKey) {
            vscode.window.showErrorMessage('未提供 API Key');
            return;
        }
        currentConfig.apiKey = apiKey;
        await extensionContext.secrets.store(`apiKey.${currentConfig.provider}`, apiKey);
    }
    try {
        proxyServer = http.createServer(handleProxyRequest);
        proxyServer.listen(currentConfig.port, () => {
            outputChannel.appendLine(`=== 代理服务器启动 ===`);
            outputChannel.appendLine(`Provider: ${PROVIDER_NAMES[currentConfig.provider]}`);
            outputChannel.appendLine(`端口: ${currentConfig.port}`);
            outputChannel.appendLine(`Base URL: ${currentConfig.baseUrl}`);
            outputChannel.appendLine(`Model: ${currentConfig.model}`);
            if (currentConfig.provider === 'minimax') {
                outputChannel.appendLine(`Prompt 缓存: ${currentConfig.enableCache ? '启用' : '禁用'}`);
                outputChannel.appendLine(`Interleaved Thinking: ${currentConfig.enableInterleavedThinking ? '启用' : '禁用'}`);
            }
            if (currentConfig.provider === 'deepseek') {
                outputChannel.appendLine(`思考模式: ${currentConfig.enableThinking ? '启用' : '禁用'}`);
                outputChannel.appendLine(`上下文缓存: 自动启用 (前缀匹配)`);
            }
        });
        proxyServer.on('error', (err) => {
            outputChannel.appendLine(`[ERROR] ${err.message}`);
            vscode.window.showErrorMessage(`代理服务器错误: ${err.message}`);
        });
        updateStatusBar(true);
        vscode.window.showInformationMessage(`代理服务器已启动 - ${PROVIDER_NAMES[currentConfig.provider]} (端口: ${currentConfig.port})`);
        outputChannel.show();
    }
    catch (error) {
        vscode.window.showErrorMessage(`启动代理失败: ${error.message}`);
    }
}
async function stopProxy() {
    if (!proxyServer) {
        vscode.window.showWarningMessage('代理服务器未运行');
        return;
    }
    proxyServer.close();
    proxyServer = null;
    updateStatusBar(false);
    outputChannel.appendLine('代理服务器已停止');
    vscode.window.showInformationMessage('代理服务器已停止');
}
async function configureProvider() {
    const config = vscode.workspace.getConfiguration('augmentProxy');
    const currentProvider = config.get('provider', 'anthropic');
    const selected = await vscode.window.showQuickPick(PROVIDERS.map(p => ({ label: PROVIDER_NAMES[p], value: p, picked: p === currentProvider })), { placeHolder: '选择 API 供应商' });
    if (selected) {
        await config.update('provider', selected.value, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`已切换到 ${selected.label}`);
    }
}
async function showStatus() {
    const config = vscode.workspace.getConfiguration('augmentProxy');
    const provider = config.get('provider', 'anthropic');
    const port = config.get('port', 8765);
    const baseUrl = config.get(`${provider}.baseUrl`, '');
    const model = config.get(`${provider}.model`, '');
    const injected = checkInjectionStatus();
    const status = `
Augment Proxy 状态
==================
运行状态: ${proxyServer ? '运行中' : '已停止'}
注入状态: ${injected ? '已注入' : '未注入'}
Provider: ${PROVIDER_NAMES[provider]}
端口: ${port}
Base URL: ${baseUrl}
Model: ${model}
    `.trim();
    outputChannel.appendLine(status);
    outputChannel.show();
}
// 检查注入状态
function checkInjectionStatus() {
    try {
        const extPath = getAugmentExtensionPath();
        if (!extPath) {
            return false;
        }
        const jsPath = path.join(extPath, 'out', 'extension.js');
        if (fs.existsSync(jsPath)) {
            const content = fs.readFileSync(jsPath, 'utf-8');
            return content.includes('AUGMENT CUSTOM MODEL INJECTION');
        }
    }
    catch (e) {
        // ignore
    }
    return false;
}
// 生成注入代码 - v8.0 恢复 v4.0 的显式端点匹配逻辑
function generateInjectionCode(proxyUrl) {
    const timestamp = new Date().toISOString();
    return `
// ===== AUGMENT CUSTOM MODEL INJECTION v9.0 =====
// Injected at: ${timestamp}
// v9.0: 代理不启动时保持原版 Augment 功能（不注入 mockPluginState）
// v8.0: 恢复 v4.0 的显式端点匹配，修复 Agent 模式问题
(function() {
    "use strict";

    // ===== 配置 =====
    const CONFIG = {
        enabled: true,
        proxyUrl: '${proxyUrl}',
        debug: true,
        routeAllRequests: true,
        proxyAvailable: false,
        checkInterval: null
    };

    const log = (...args) => { if (CONFIG.debug) console.log('[Augment-Proxy]', ...args); };

    // 检查代理是否可用
    const checkProxyHealth = async () => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1000);
            const resp = await fetch(CONFIG.proxyUrl + '/health', {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(timeout);
            CONFIG.proxyAvailable = resp.ok;
            if (CONFIG.proxyAvailable) {
                log('Proxy is available');
            }
        } catch (e) {
            CONFIG.proxyAvailable = false;
        }
        return CONFIG.proxyAvailable;
    };

    // 启动时检查，然后每 5 秒检查一次
    checkProxyHealth();
    CONFIG.checkInterval = setInterval(checkProxyHealth, 5000);

    // 暴露到全局，方便调试
    globalThis.__AUGMENT_PROXY__ = {
        CONFIG,
        enable: () => { CONFIG.enabled = true; console.log('[Augment-Proxy] Enabled'); },
        disable: () => { CONFIG.enabled = false; console.log('[Augment-Proxy] Disabled'); },
        setProxyUrl: (url) => { CONFIG.proxyUrl = url; console.log('[Augment-Proxy] Proxy URL:', url); checkProxyHealth(); },
        status: () => console.log('[Augment-Proxy] Status:', CONFIG),
        checkProxy: checkProxyHealth
    };

    log('Injection loaded');
    log('Proxy URL:', CONFIG.proxyUrl);

    // ===== 模拟 PluginState =====
    const mockPluginState = {
        authenticated: true,
        hasValidSubscription: true,
        isLoggedIn: true,
        subscriptionType: 'pro',
        userId: 'proxy-user',
        email: 'proxy@augmentcode.com',
        planName: 'Pro',
        features: { chat: true, completion: true, instruction: true, agentMode: true },
        modelConfig: { internalName: 'proxy-model', displayName: 'Proxy Model' },
        getValue: (k, d) => d,
        setValue: () => true,
        getUser: () => ({ id: 'proxy-user', email: 'proxy@augmentcode.com' }),
        getSubscription: () => ({ plan: 'Pro', valid: true }),
        isAuthenticated: () => true,
        hasFeature: () => true,
        onDidChange: () => ({ dispose: () => {} })
    };
    globalThis.__AUGMENT_MOCK_STATE__ = mockPluginState;

    // 🔥 v9.0: 只有代理可用时才注入 mockPluginState，否则保持原版行为
    // 这样代理不启动时，Augment 完全正常工作

    // 延迟注入 PluginState mock - 但需要先检查代理是否可用
    const tryInjectMockState = () => {
        // 🔥 关键修复：只有代理可用时才注入 mock
        if (!CONFIG.proxyAvailable) {
            log('Proxy not available, skipping PluginState mock injection (keeping original Augment behavior)');
            return;
        }

        log('Proxy is available, attempting to patch PluginState singleton...');
        try {
            for (const key in globalThis) {
                try {
                    const obj = globalThis[key];
                    if (obj && typeof obj === 'object' && typeof obj.getStateForSidecar === 'function') {
                        log('Found PluginState singleton:', key);
                        if (obj._instance === void 0 || !obj._instance.__isProxyMock) {
                            obj._instance = mockPluginState;
                            obj._instance.__isProxyMock = true;  // 标记为 mock
                            log('PluginState mock injected successfully!');
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {
            log('Error patching PluginState:', e.message);
        }
    };

    // 初始延迟注入（等待 Augment 加载完成 + 代理健康检查）
    setTimeout(tryInjectMockState, 1000);

    // 🔥 当代理状态变化时重新检查（每次健康检查后）
    const originalCheckProxyHealth = checkProxyHealth;
    const enhancedCheckProxyHealth = async () => {
        const wasAvailable = CONFIG.proxyAvailable;
        const result = await originalCheckProxyHealth();
        // 如果代理从不可用变为可用，尝试注入 mock
        if (!wasAvailable && CONFIG.proxyAvailable) {
            log('Proxy became available, injecting mock state...');
            tryInjectMockState();
        }
        return result;
    };
    // 替换健康检查函数
    CONFIG.checkInterval && clearInterval(CONFIG.checkInterval);
    enhancedCheckProxyHealth();
    CONFIG.checkInterval = setInterval(enhancedCheckProxyHealth, 5000);

    // ===== 核心：拦截 fetch 请求（恢复 v4.0 显式端点匹配）=====
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function(url, options = {}) {
        if (!CONFIG.enabled) return originalFetch.call(this, url, options);

        const urlStr = typeof url === 'string' ? url : url.toString();

        // 检测 Augment API 请求
        const isAugmentApi = urlStr.includes('augmentcode.com');
        if (!isAugmentApi) return originalFetch.call(this, url, options);

        // 如果代理不可用，直接 fallback 到原始请求
        if (!CONFIG.proxyAvailable) {
            log('Proxy not available, passing through:', urlStr.substring(0, 80));
            return originalFetch.call(this, url, options);
        }

        // 提取端点路径 - 完整列表（与代理服务器完全一致）
        let endpoint = null;
        // 核心 AI 端点
        if (urlStr.includes('/chat-stream')) endpoint = '/chat-stream';
        else if (urlStr.includes('/chat-input-completion')) endpoint = '/chat-input-completion';
        else if (urlStr.includes('/chat')) endpoint = '/chat';
        else if (urlStr.includes('/instruction-stream')) endpoint = '/instruction-stream';
        else if (urlStr.includes('/smart-paste-stream')) endpoint = '/smart-paste-stream';
        else if (urlStr.includes('/completion')) endpoint = '/completion';
        // 插件状态和配置
        else if (urlStr.includes('/getPluginState')) endpoint = '/getPluginState';
        else if (urlStr.includes('/get-model-config')) endpoint = '/get-model-config';
        else if (urlStr.includes('/get-models')) endpoint = '/get-models';
        // Agent 端点
        else if (urlStr.includes('/agents/codebase-retrieval')) endpoint = '/agents/codebase-retrieval';
        else if (urlStr.includes('/agents/edit-file')) endpoint = '/agents/edit-file';
        else if (urlStr.includes('/agents/list-remote-tools')) endpoint = '/agents/list-remote-tools';
        else if (urlStr.includes('/agents/run-remote-tool')) endpoint = '/agents/run-remote-tool';
        // 远程代理
        else if (urlStr.includes('/remote-agents/list-stream')) endpoint = '/remote-agents/list-stream';
        // 订阅和用户
        else if (urlStr.includes('/subscription-banner')) endpoint = '/subscription-banner';
        else if (urlStr.includes('/save-chat')) endpoint = '/save-chat';
        // 用户密钥
        else if (urlStr.includes('/user-secrets/list')) endpoint = '/user-secrets/list';
        else if (urlStr.includes('/user-secrets/upsert')) endpoint = '/user-secrets/upsert';
        else if (urlStr.includes('/user-secrets/delete')) endpoint = '/user-secrets/delete';
        // 通知
        else if (urlStr.includes('/notifications/mark-read')) endpoint = '/notifications/mark-read';
        else if (urlStr.includes('/notifications')) endpoint = '/notifications';
        // 遥测和事件
        else if (urlStr.includes('/client-completion-timelines')) endpoint = '/client-completion-timelines';
        else if (urlStr.includes('/record-session-events')) endpoint = '/record-session-events';
        else if (urlStr.includes('/record-request-events')) endpoint = '/record-request-events';
        // 其他
        else if (urlStr.includes('/next-edit-stream')) endpoint = '/next-edit-stream';
        else if (urlStr.includes('/find-missing')) endpoint = '/find-missing';
        else if (urlStr.includes('/client-metrics')) endpoint = '/client-metrics';
        else if (urlStr.includes('/batch-upload')) endpoint = '/batch-upload';
        else if (urlStr.includes('/report-feature-vector')) endpoint = '/report-feature-vector';
        // 错误报告
        else if (urlStr.includes('/report-error')) endpoint = '/report-error';

        if (!endpoint) {
            log('Passing through (no matching endpoint):', urlStr);
            return originalFetch.call(this, url, options);
        }

        const proxyTargetUrl = CONFIG.proxyUrl + endpoint;
        log('=== Intercepted Augment API request ===');
        log('Original URL:', urlStr);
        log('Routing to:', proxyTargetUrl);

        try {
            // 复制 headers，移除 Augment 特定的认证
            const newHeaders = {};
            if (options.headers) {
                const entries = options.headers.entries ? [...options.headers.entries()] : Object.entries(options.headers);
                for (const [key, value] of entries) {
                    if (key.toLowerCase() === 'content-type') newHeaders[key] = value;
                }
            }
            newHeaders['Content-Type'] = 'application/json';

            if (options.body && CONFIG.debug) {
                try {
                    const bodyPreview = typeof options.body === 'string' ? options.body.substring(0, 200) : '[non-string body]';
                    log('Request body preview:', bodyPreview);
                } catch (e) {}
            }

            const proxyResponse = await originalFetch.call(this, proxyTargetUrl, {
                method: options.method || 'POST',
                headers: newHeaders,
                body: options.body
            });
            log('Proxy response status:', proxyResponse.status);
            return proxyResponse;
        } catch (error) {
            log('Proxy error:', error.message);
            log('Falling back to original Augment API');
            return originalFetch.call(this, url, options);
        }
    };

    // ===== 拦截 HTTP 模块（Node.js 环境）=====
    try {
        const https = require('https');
        const http = require('http');
        const originalHttpsRequest = https.request;
        const originalHttpRequest = http.request;

        const getEndpoint = (url) => {
            if (url.includes('/chat-stream')) return '/chat-stream';
            if (url.includes('/chat-input-completion')) return '/chat-input-completion';
            if (url.includes('/chat')) return '/chat';
            if (url.includes('/instruction-stream')) return '/instruction-stream';
            if (url.includes('/smart-paste-stream')) return '/smart-paste-stream';
            if (url.includes('/completion')) return '/completion';
            if (url.includes('/getPluginState')) return '/getPluginState';
            if (url.includes('/get-model-config')) return '/get-model-config';
            if (url.includes('/get-models')) return '/get-models';
            if (url.includes('/agents/codebase-retrieval')) return '/agents/codebase-retrieval';
            if (url.includes('/agents/edit-file')) return '/agents/edit-file';
            if (url.includes('/agents/list-remote-tools')) return '/agents/list-remote-tools';
            if (url.includes('/agents/run-remote-tool')) return '/agents/run-remote-tool';
            if (url.includes('/remote-agents/list-stream')) return '/remote-agents/list-stream';
            if (url.includes('/subscription-banner')) return '/subscription-banner';
            if (url.includes('/save-chat')) return '/save-chat';
            if (url.includes('/user-secrets/list')) return '/user-secrets/list';
            if (url.includes('/user-secrets/upsert')) return '/user-secrets/upsert';
            if (url.includes('/user-secrets/delete')) return '/user-secrets/delete';
            if (url.includes('/notifications/mark-read')) return '/notifications/mark-read';
            if (url.includes('/notifications')) return '/notifications';
            if (url.includes('/client-completion-timelines')) return '/client-completion-timelines';
            if (url.includes('/record-session-events')) return '/record-session-events';
            if (url.includes('/record-request-events')) return '/record-request-events';
            if (url.includes('/next-edit-stream')) return '/next-edit-stream';
            if (url.includes('/find-missing')) return '/find-missing';
            if (url.includes('/client-metrics')) return '/client-metrics';
            if (url.includes('/batch-upload')) return '/batch-upload';
            if (url.includes('/report-feature-vector')) return '/report-feature-vector';
            if (url.includes('/report-error')) return '/report-error';
            return null;
        };

        const wrapRequest = (originalRequest, protocol) => {
            return function(urlOrOptions, options, callback) {
                let targetUrl = '';
                if (typeof urlOrOptions === 'string') {
                    targetUrl = urlOrOptions;
                } else if (urlOrOptions && urlOrOptions.hostname) {
                    targetUrl = protocol + '://' + urlOrOptions.hostname + (urlOrOptions.path || '');
                }

                const isAugmentApi = targetUrl.includes('augmentcode.com');
                if (!CONFIG.enabled || !isAugmentApi || !CONFIG.proxyAvailable) {
                    return originalRequest.apply(this, arguments);
                }

                const endpoint = getEndpoint(targetUrl);
                if (!endpoint) {
                    log('HTTP: Passing through (no matching endpoint):', targetUrl.substring(0, 80));
                    return originalRequest.apply(this, arguments);
                }

                log('HTTP: Intercepting ' + endpoint);
                const proxyOptions = {
                    hostname: 'localhost',
                    port: 8765,
                    path: endpoint,
                    method: (typeof urlOrOptions === 'object' ? urlOrOptions.method : 'GET') || 'GET',
                    headers: typeof urlOrOptions === 'object' ? urlOrOptions.headers : {}
                };
                proxyOptions.headers['Content-Type'] = 'application/json';
                return originalHttpRequest.call(http, proxyOptions, typeof options === 'function' ? options : callback);
            };
        };

        https.request = wrapRequest(originalHttpsRequest, 'https');
        http.request = wrapRequest(originalHttpRequest, 'http');
        log('Node.js https/http.request intercepted');
    } catch (e) {
        log('Failed to intercept http modules:', e.message);
    }

    log('==================================================');
    log('🎉 Augment Proxy Injection v8.0 loaded!');
    log('   📌 Restored v4.0 explicit endpoint matching');
    log('   Proxy URL:', CONFIG.proxyUrl);
    log('   ⚠️  请确保代理服务器已启动');
    log('==================================================');
})();
// ===== END AUGMENT PROXY INJECTION =====

`;
}
// 注入插件 (纯 TypeScript)
async function injectPlugin() {
    const extPath = getAugmentExtensionPath();
    if (!extPath) {
        vscode.window.showErrorMessage('未找到 Augment 插件');
        return;
    }
    if (checkInjectionStatus()) {
        const confirm = await vscode.window.showWarningMessage('插件已注入，是否重新注入？', '是', '否');
        if (confirm !== '是') {
            return;
        }
        await restorePluginInternal(extPath);
    }
    const config = vscode.workspace.getConfiguration('augmentProxy');
    const port = config.get('port', 8765);
    const proxyUrl = `http://localhost:${port}`;
    try {
        const jsPath = path.join(extPath, 'out', 'extension.js');
        const backupPath = jsPath + '.backup';
        // 备份
        if (!fs.existsSync(backupPath)) {
            fs.copyFileSync(jsPath, backupPath);
            outputChannel.appendLine('Created backup: extension.js.backup');
        }
        // 读取并注入
        let code = fs.readFileSync(jsPath, 'utf-8');
        const injection = generateInjectionCode(proxyUrl);
        code = injection + code;
        fs.writeFileSync(jsPath, code, 'utf-8');
        outputChannel.appendLine(`注入成功! 代理: ${proxyUrl}`);
        updateStatusBar(!!proxyServer, true);
        const action = await vscode.window.showInformationMessage('插件注入成功！请重载 VSCode 窗口。', '重载窗口');
        if (action === '重载窗口') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    }
    catch (error) {
        outputChannel.appendLine(`注入失败: ${error.message}`);
        vscode.window.showErrorMessage(`注入失败: ${error.message}`);
    }
    outputChannel.show();
}
// 恢复插件内部函数
async function restorePluginInternal(extPath) {
    const jsPath = path.join(extPath, 'out', 'extension.js');
    const backupPath = jsPath + '.backup';
    if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, jsPath);
        outputChannel.appendLine('Restored from backup');
        return true;
    }
    return false;
}
// 恢复插件
async function restorePlugin() {
    const extPath = getAugmentExtensionPath();
    if (!extPath) {
        vscode.window.showErrorMessage('未找到 Augment 插件');
        return;
    }
    if (!checkInjectionStatus()) {
        vscode.window.showWarningMessage('插件未注入，无需恢复');
        return;
    }
    const confirm = await vscode.window.showWarningMessage('确定要恢复原始插件吗？', '是', '否');
    if (confirm !== '是') {
        return;
    }
    try {
        if (await restorePluginInternal(extPath)) {
            updateStatusBar(!!proxyServer, false);
            const action = await vscode.window.showInformationMessage('插件已恢复！请重载 VSCode 窗口。', '重载窗口');
            if (action === '重载窗口') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }
        else {
            vscode.window.showErrorMessage('未找到备份文件');
        }
    }
    catch (error) {
        outputChannel.appendLine(`恢复失败: ${error.message}`);
        vscode.window.showErrorMessage(`恢复失败: ${error.message}`);
    }
    outputChannel.show();
}
// ===== 侧边栏 Provider =====
class AugmentProxySidebarProvider {
    _extensionUri;
    _view;
    _proxyRunning = false;
    _injected = false;
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    updateStatus(proxyRunning, injected) {
        this._proxyRunning = proxyRunning;
        this._injected = injected;
        if (this._view) {
            this._view.webview.postMessage({ type: 'status', proxyRunning, injected });
        }
    }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'startProxy':
                    await startProxy();
                    break;
                case 'stopProxy':
                    await stopProxy();
                    break;
                case 'inject':
                    await injectPlugin();
                    break;
                case 'restore':
                    await restorePlugin();
                    break;
                case 'refresh':
                    this.sendFullStatus();
                    break;
                case 'saveConfig':
                    await this.saveConfig(msg.config);
                    break;
                case 'setApiKey':
                    await extensionContext.secrets.store(`apiKey.${msg.provider}`, msg.apiKey);
                    vscode.window.showInformationMessage(`${PROVIDER_NAMES[msg.provider]} API Key 已保存`);
                    break;
                case 'getConfig':
                    this.sendFullStatus();
                    break;
            }
        });
        // 初始状态
        this.sendFullStatus();
    }
    async saveConfig(config) {
        const vscodeConfig = vscode.workspace.getConfiguration('augmentProxy');
        if (config.provider) {
            await vscodeConfig.update('provider', config.provider, vscode.ConfigurationTarget.Global);
        }
        if (config.port) {
            await vscodeConfig.update('port', parseInt(config.port), vscode.ConfigurationTarget.Global);
        }
        if (config.provider && config.baseUrl !== undefined) {
            await vscodeConfig.update(`${config.provider}.baseUrl`, config.baseUrl, vscode.ConfigurationTarget.Global);
        }
        if (config.provider && config.model !== undefined) {
            await vscodeConfig.update(`${config.provider}.model`, config.model, vscode.ConfigurationTarget.Global);
        }
        if (config.provider === 'custom' && config.format) {
            await vscodeConfig.update('custom.format', config.format, vscode.ConfigurationTarget.Global);
        }
        vscode.window.showInformationMessage('配置已保存');
        this.sendFullStatus();
    }
    async sendFullStatus() {
        if (!this._view)
            return;
        const config = vscode.workspace.getConfiguration('augmentProxy');
        const provider = config.get('provider', 'anthropic');
        const configData = {
            provider,
            port: config.get('port', 8765),
            providers: {}
        };
        for (const p of PROVIDERS) {
            configData.providers[p] = {
                name: PROVIDER_NAMES[p],
                baseUrl: config.get(`${p}.baseUrl`, DEFAULT_BASE_URLS[p]),
                model: config.get(`${p}.model`, DEFAULT_MODELS[p]),
                hasApiKey: !!(await extensionContext.secrets.get(`apiKey.${p}`))
            };
        }
        configData.providers['custom'].format = config.get('custom.format', 'anthropic');
        this._view.webview.postMessage({
            type: 'fullStatus',
            proxyRunning: !!proxyServer,
            injected: checkInjectionStatus(),
            config: configData
        });
    }
    _getHtml() {
        return `<!DOCTYPE html>
<html>
<head>
<style>
body { padding: 10px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; }
.section { margin-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; }
.section:last-child { border-bottom: none; }
.title { font-weight: bold; margin-bottom: 8px; font-size: 12px; text-transform: uppercase; opacity: 0.8; }
.status { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.on { background: #4caf50; box-shadow: 0 0 4px #4caf50; }
.dot.off { background: #f44336; }
.row { margin: 8px 0; }
label { display: block; margin-bottom: 4px; font-size: 11px; opacity: 0.8; }
select, input {
    width: 100%; padding: 6px 8px; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 4px;
}
select:focus, input:focus { outline: 1px solid var(--vscode-focusBorder); }
button {
    width: 100%; padding: 8px; margin: 4px 0; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; font-size: 13px;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.small { padding: 4px 8px; font-size: 11px; }
.btn-row { display: flex; gap: 8px; }
.btn-row button { flex: 1; }
.api-key-row { display: flex; gap: 4px; }
.api-key-row input { flex: 1; }
.api-key-row button { width: auto; padding: 6px 12px; }
.key-status { font-size: 11px; margin-top: 2px; }
.key-status.saved { color: #4caf50; }
.key-status.missing { color: #ff9800; }
.info { font-size: 11px; opacity: 0.7; margin-top: 4px; }
</style>
</head>
<body>
    <div class="section">
        <div class="title">状态</div>
        <div class="status"><span class="dot" id="proxyDot"></span><span id="proxyStatus">代理: 检查中...</span></div>
        <div class="status"><span class="dot" id="injectDot"></span><span id="injectStatus">注入: 检查中...</span></div>
    </div>

    <div class="section">
        <div class="title">Provider 配置</div>
        <div class="row">
            <label>选择 Provider</label>
            <select id="provider">
                <option value="minimax">MiniMax</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="deepseek">DeepSeek</option>
                <option value="glm">GLM (智谱)</option>
                <option value="openai">OpenAI</option>
                <option value="custom">自定义</option>
            </select>
        </div>
        <div class="row">
            <label>API Key</label>
            <div class="api-key-row">
                <input type="password" id="apiKey" placeholder="sk-...">
                <button class="small" id="saveKeyBtn">保存</button>
            </div>
            <div class="key-status" id="keyStatus"></div>
        </div>
        <div class="row">
            <label>Base URL</label>
            <input type="text" id="baseUrl" placeholder="https://api.example.com/v1/...">
        </div>
        <div class="row">
            <label>Model</label>
            <input type="text" id="model" placeholder="model-name">
        </div>
        <div class="row" id="formatRow" style="display:none">
            <label>API 格式 (自定义)</label>
            <select id="format">
                <option value="anthropic">Anthropic 格式</option>
                <option value="openai">OpenAI 格式</option>
            </select>
        </div>
        <div class="row">
            <label>代理端口</label>
            <input type="number" id="port" value="8765" min="1024" max="65535">
        </div>
        <button id="saveConfigBtn">保存配置</button>
    </div>

    <div class="section">
        <div class="title">代理控制</div>
        <div class="btn-row">
            <button id="startBtn">▶ 启动</button>
            <button id="stopBtn" class="secondary">■ 停止</button>
        </div>
    </div>

    <div class="section">
        <div class="title">插件注入</div>
        <div class="btn-row">
            <button id="injectBtn">注入插件</button>
            <button id="restoreBtn" class="secondary">恢复原始</button>
        </div>
        <div class="info">注入后需重载 VSCode 窗口</div>
    </div>

    <button id="refreshBtn" class="secondary">🔄 刷新状态</button>

<script>
const vscode = acquireVsCodeApi();
let currentConfig = {};

// 元素
const $provider = document.getElementById('provider');
const $apiKey = document.getElementById('apiKey');
const $baseUrl = document.getElementById('baseUrl');
const $model = document.getElementById('model');
const $format = document.getElementById('format');
const $formatRow = document.getElementById('formatRow');
const $port = document.getElementById('port');
const $keyStatus = document.getElementById('keyStatus');

// Provider 切换
$provider.onchange = () => {
    const p = $provider.value;
    const pConfig = currentConfig.providers?.[p] || {};
    $baseUrl.value = pConfig.baseUrl || '';
    $model.value = pConfig.model || '';
    $formatRow.style.display = p === 'custom' ? 'block' : 'none';
    if (p === 'custom') $format.value = pConfig.format || 'anthropic';
    updateKeyStatus(pConfig.hasApiKey);
    $apiKey.value = '';
};

function updateKeyStatus(hasKey) {
    if (hasKey) {
        $keyStatus.textContent = '✓ 已保存';
        $keyStatus.className = 'key-status saved';
    } else {
        $keyStatus.textContent = '⚠ 未设置';
        $keyStatus.className = 'key-status missing';
    }
}

// 按钮事件
document.getElementById('startBtn').onclick = () => vscode.postMessage({command:'startProxy'});
document.getElementById('stopBtn').onclick = () => vscode.postMessage({command:'stopProxy'});
document.getElementById('injectBtn').onclick = () => vscode.postMessage({command:'inject'});
document.getElementById('restoreBtn').onclick = () => vscode.postMessage({command:'restore'});
document.getElementById('refreshBtn').onclick = () => vscode.postMessage({command:'refresh'});

document.getElementById('saveKeyBtn').onclick = () => {
    const apiKey = $apiKey.value.trim();
    if (!apiKey) return;
    vscode.postMessage({command:'setApiKey', provider: $provider.value, apiKey});
    $apiKey.value = '';
    updateKeyStatus(true);
};

document.getElementById('saveConfigBtn').onclick = () => {
    vscode.postMessage({
        command: 'saveConfig',
        config: {
            provider: $provider.value,
            baseUrl: $baseUrl.value,
            model: $model.value,
            port: $port.value,
            format: $format.value
        }
    });
};

// 接收消息
window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'status') {
        document.getElementById('proxyDot').className = 'dot ' + (msg.proxyRunning ? 'on' : 'off');
        document.getElementById('proxyStatus').textContent = '代理: ' + (msg.proxyRunning ? '运行中' : '已停止');
        document.getElementById('injectDot').className = 'dot ' + (msg.injected ? 'on' : 'off');
        document.getElementById('injectStatus').textContent = '注入: ' + (msg.injected ? '已注入' : '未注入');
    } else if (msg.type === 'fullStatus') {
        document.getElementById('proxyDot').className = 'dot ' + (msg.proxyRunning ? 'on' : 'off');
        document.getElementById('proxyStatus').textContent = '代理: ' + (msg.proxyRunning ? '运行中' : '已停止');
        document.getElementById('injectDot').className = 'dot ' + (msg.injected ? 'on' : 'off');
        document.getElementById('injectStatus').textContent = '注入: ' + (msg.injected ? '已注入' : '未注入');

        currentConfig = msg.config;
        $provider.value = msg.config.provider;
        $port.value = msg.config.port;
        const pConfig = msg.config.providers?.[msg.config.provider] || {};
        $baseUrl.value = pConfig.baseUrl || '';
        $model.value = pConfig.model || '';
        $formatRow.style.display = msg.config.provider === 'custom' ? 'block' : 'none';
        if (msg.config.provider === 'custom') $format.value = pConfig.format || 'anthropic';
        updateKeyStatus(pConfig.hasApiKey);
    }
});

// 初始化
vscode.postMessage({command:'getConfig'});
</script>
</body>
</html>`;
    }
}
async function deactivate() {
    // 关闭 RAG 索引 (释放 LevelDB)
    await closeRAGIndex();

    if (proxyServer) {
        proxyServer.close();
    }
}
//# sourceMappingURL=extension.js.map
