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
    res.end(JSON.stringify({
        models: [{ id: currentConfig.model, name: currentConfig.model, provider: currentConfig.provider }]
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

// 获取工作区根目录
function getWorkspaceRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return [];
    }
    return folders.map(f => f.uri.fsPath);
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
        outputChannel.appendLine(`[RAG] Initializing index for ${workspaceRoot}...`);

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
                    indexedCount = ragIndex.addBatchToIndex(filesToIndex);
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
// 核心：处理 chat-stream 请求
function handleChatStream(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
        try {
            const augmentReq = JSON.parse(body);
            const historyCount = augmentReq.chat_history?.length || 0;
            outputChannel.appendLine(`[CHAT-STREAM] message: "${(augmentReq.message || '').slice(0, 50)}..." history: ${historyCount}`);
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
// 将 Augment 请求转换为 OpenAI 格式消息
function augmentToOpenAIMessages(req) {
    const messages = [];
    // 收集所有 tool_use 和对应的 tool_result
    // Augment 的 chat_history 结构:
    //   exchange[i].response_nodes 包含 tool_use
    //   exchange[i].request_nodes 或 exchange[i+1].request_nodes 包含对应的 tool_result
    // OpenAI 要求: assistant(tool_calls) 后必须紧跟所有对应的 tool 消息

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
        for (const exchange of req.chat_history) {
            // 用户请求消息
            let userContent = exchange.request_message || '';

            // 检查响应中是否有内容 (需要提前检查以决定是否插入占位 user 消息)
            const responseNodes = exchange.response_nodes || [];
            const hasResponse = responseNodes.length > 0 || exchange.response_text || exchange.response_message;

            // GLM API 要求: 消息序列必须是 user -> assistant 交替
            // 如果有 assistant 响应但没有 user 消息，需要插入占位消息
            if (!userContent && hasResponse && messages.length === 0) {
                // 第一轮对话，但没有用户消息，插入占位
                userContent = '...';
                outputChannel.appendLine(`[DEBUG] OpenAI: Inserted placeholder user message for first exchange`);
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
    const currentMessage = req.message || '';
    if (currentMessage && currentMessage !== '...') { // "..." 是工具结果继续的占位符
        messages.push({ role: 'user', content: currentMessage });
    }
    return messages;
}
// 转发到 OpenAI 格式 API (流式，发送增量)
// 注意：OpenAI 格式不完全支持多模态，图片会转为描述文本
async function forwardToOpenAIStream(augmentReq, res) {
    const system = buildSystemPrompt(augmentReq);
    // 提取工作区信息，用于后续路径修正
    const workspaceInfo = extractWorkspaceInfo(augmentReq);
    // 转换工具定义
    const rawTools = augmentReq.tool_definitions || [];
    const tools = convertToolDefinitionsToOpenAI(rawTools);
    outputChannel.appendLine(`[DEBUG] OpenAI tools: ${tools ? tools.length : 0} definitions`);
    // 构建 OpenAI 格式消息
    const openaiMessages = [];
    if (system) {
        openaiMessages.push({ role: 'system', content: system });
    }
    // 使用专门的 OpenAI 消息转换函数
    const convertedMessages = augmentToOpenAIMessages(augmentReq);
    openaiMessages.push(...convertedMessages);
    outputChannel.appendLine(`[DEBUG] OpenAI messages: ${openaiMessages.length} total`);
    for (let i = 0; i < openaiMessages.length; i++) {
        const msg = openaiMessages[i];
        if (msg.tool_calls) {
            outputChannel.appendLine(`[DEBUG] msg[${i}]: role=${msg.role}, tool_calls=${msg.tool_calls.length}`);
        }
        else if (msg.tool_call_id) {
            outputChannel.appendLine(`[DEBUG] msg[${i}]: role=${msg.role}, tool_call_id=${msg.tool_call_id}`);
        }
        else {
            outputChannel.appendLine(`[DEBUG] msg[${i}]: role=${msg.role}, content_len=${(msg.content || '').length}`);
        }
    }
    // 构建请求体
    // max_tokens 设为 GLM-4.7/4.6 最大输出 128K 的 90% ≈ 115000
    const requestBody: any = {
        model: currentConfig.model,
        max_tokens: 115000,
        messages: openaiMessages,
        stream: true
    };
    // 添加工具定义
    if (tools && tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = 'auto';
    }
    const apiBody = JSON.stringify(requestBody);
    // Append /chat/completions to baseUrl if not already present (for OpenAI-compatible APIs)
    let apiEndpoint = currentConfig.baseUrl;
    if (!apiEndpoint.endsWith('/chat/completions')) {
        apiEndpoint = apiEndpoint.replace(/\/$/, '') + '/chat/completions';
    }
    outputChannel.appendLine(`[API] Sending to ${apiEndpoint} with ${openaiMessages.length} messages`);
    const url = new url_1.URL(apiEndpoint);
    const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentConfig.apiKey}`
        }
    };
    const apiReq = https.request(options, (apiRes: any) => {
        if (apiRes.statusCode !== 200) {
            let errorBody = '';
            apiRes.on('data', (c: any) => errorBody += c);
            apiRes.on('end', () => {
                outputChannel.appendLine(`[API ERROR] Status ${apiRes.statusCode}: ${errorBody.slice(0, 200)}`);
                sendAugmentError(res, `API Error ${apiRes.statusCode}`);
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        let buffer = '';
        let chunkCount = 0;
        outputChannel.appendLine(`[API] OpenAI response started, status=${apiRes.statusCode}`);
        let inThinking = false; // 跟踪是否在思考模式中
        const toolCalls = new Map();
        let hasToolUse = false;
        let finishReason = null;
        apiRes.on('data', (chunk: any) => {
            chunkCount++;
            const chunkStr = chunk.toString();
            if (chunkCount === 1) {
                outputChannel.appendLine(`[API] First chunk (${chunkStr.length} bytes): ${chunkStr.substring(0, 200)}...`);
            }
            buffer += chunkStr;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (!data || data === '[DONE]')
                        continue;
                    try {
                        const event = JSON.parse(data);
                        const choice = event.choices?.[0];
                        const delta = choice?.delta?.content || '';
                        const reasoningDelta = choice?.delta?.reasoning_content || '';
                        const toolCallsDelta = choice?.delta?.tool_calls;
                        // 记录 finish_reason
                        if (choice?.finish_reason) {
                            finishReason = choice.finish_reason;
                            outputChannel.appendLine(`[API] finish_reason: ${finishReason}`);
                        }
                        // 处理思考内容
                        if (reasoningDelta) {
                            if (!inThinking) {
                                inThinking = true;
                                res.write(JSON.stringify({ text: '<think>\n', nodes: [], stop_reason: 0 }) + '\n');
                            }
                            res.write(JSON.stringify({ text: reasoningDelta, nodes: [], stop_reason: 0 }) + '\n');
                        }
                        // 处理正常内容
                        if (delta) {
                            if (inThinking) {
                                inThinking = false;
                                res.write(JSON.stringify({ text: '\n</think>\n\n', nodes: [], stop_reason: 0 }) + '\n');
                            }
                            res.write(JSON.stringify({ text: delta, nodes: [], stop_reason: 0 }) + '\n');
                        }
                        // 处理工具调用 (OpenAI 格式，兼容 GLM 等模型)
                        if (toolCallsDelta && Array.isArray(toolCallsDelta)) {
                            for (const tc of toolCallsDelta) {
                                const idx = tc.index ?? 0;

                                // 调试：记录原始 tool_call 结构
                                outputChannel.appendLine(`[API] Raw tool_call delta: ${JSON.stringify(tc)}`);

                                if (!toolCalls.has(idx)) {
                                    // 新工具调用
                                    toolCalls.set(idx, {
                                        id: tc.id || `tool_${idx}_${Date.now()}`,
                                        name: tc.function?.name || '',
                                        arguments: ''
                                    });
                                    outputChannel.appendLine(`[API] Tool call start: idx=${idx}, id=${tc.id}, name=${tc.function?.name}`);
                                }
                                const state = toolCalls.get(idx);
                                // 累积 id 和 name (可能在后续 chunk 中)
                                if (tc.id)
                                    state.id = tc.id;
                                if (tc.function?.name)
                                    state.name = tc.function.name;

                                // 累积 arguments (兼容多种格式)
                                // 1. OpenAI 标准格式: tc.function.arguments (字符串)
                                // 2. GLM 可能的格式: tc.function.parameters 或 tc.arguments
                                // 3. 某些模型可能返回对象而不是字符串
                                let argsValue = tc.function?.arguments
                                    || tc.function?.parameters
                                    || tc.arguments
                                    || tc.parameters;

                                if (argsValue !== undefined && argsValue !== null) {
                                    // 如果是对象，转为 JSON 字符串
                                    if (typeof argsValue === 'object') {
                                        argsValue = JSON.stringify(argsValue);
                                        outputChannel.appendLine(`[API] Converted object arguments to string: ${argsValue}`);
                                    }
                                    state.arguments += argsValue;
                                    outputChannel.appendLine(`[API] Accumulated arguments: ${state.arguments}`);
                                }
                            }
                        }
                    }
                    catch (e) {
                        outputChannel.appendLine(`[API] Parse error: ${e}`);
                    }
                }
            }
        });
        apiRes.on('end', () => {
            // 关闭思考模式
            if (inThinking) {
                res.write(JSON.stringify({ text: '\n</think>\n\n', nodes: [], stop_reason: 0 }) + '\n');
            }
            // 发送所有累积的工具调用
            if (toolCalls.size > 0) {
                for (const [idx, tc] of toolCalls) {
                    outputChannel.appendLine(`[API] Sending tool_use: idx=${idx}, id=${tc.id}, name=${tc.name}`);
                    outputChannel.appendLine(`[API] Tool arguments (full): ${tc.arguments}`);

                    // 警告：如果参数为空，可能是模型返回格式不兼容
                    if (!tc.arguments || tc.arguments === '' || tc.arguments === '{}') {
                        outputChannel.appendLine(`[WARN] Tool ${tc.name} has empty arguments! This may indicate incompatible model response format.`);
                        outputChannel.appendLine(`[WARN] Check if the model uses a different field name for function arguments.`);
                    }

                    // 验证并规范化 JSON
                    let inputJson = tc.arguments || '{}';
                    try {
                        const parsed = JSON.parse(tc.arguments);
                        outputChannel.appendLine(`[API] Tool input parsed keys: ${Object.keys(parsed).join(',')}`);

                        // ========== 路径修正逻辑 ==========
                        // Augment 的文件工具使用 repository_root 作为基准路径
                        // 如果用户打开的是仓库的子目录，需要把相对路径转换为相对于仓库根目录的路径
                        const fileTools = ['save-file', 'view', 'remove-files', 'str-replace-editor'];
                        if (fileTools.includes(tc.name) && workspaceInfo) {
                            const workspacePath = workspaceInfo.workspacePath || '';
                            const repoRoot = workspaceInfo.repositoryRoot || '';

                            // 计算工作区相对于仓库根目录的前缀
                            let relativePrefix = '';
                            if (repoRoot && workspacePath && workspacePath.startsWith(repoRoot) && workspacePath !== repoRoot) {
                                relativePrefix = workspacePath.substring(repoRoot.length).replace(/^\//, '');
                            }

                            if (relativePrefix) {
                                // 修正 path 参数
                                if (parsed.path && typeof parsed.path === 'string' && !parsed.path.startsWith('/') && !parsed.path.startsWith(relativePrefix)) {
                                    const originalPath = parsed.path;
                                    parsed.path = relativePrefix + '/' + parsed.path;
                                    outputChannel.appendLine(`[PATH FIX] ${tc.name}: "${originalPath}" -> "${parsed.path}" (prefix: ${relativePrefix})`);
                                }

                                // 修正 file_paths 参数 (用于 remove-files)
                                if (parsed.file_paths && Array.isArray(parsed.file_paths)) {
                                    parsed.file_paths = parsed.file_paths.map((p: string) => {
                                        if (typeof p === 'string' && !p.startsWith('/') && !p.startsWith(relativePrefix)) {
                                            const newPath = relativePrefix + '/' + p;
                                            outputChannel.appendLine(`[PATH FIX] ${tc.name} file_paths: "${p}" -> "${newPath}"`);
                                            return newPath;
                                        }
                                        return p;
                                    });
                                }
                            }
                        }
                        // ========== 路径修正逻辑结束 ==========

                        // ========== Playwright 工具参数修正 ==========
                        // GLM 生成的参数可能与 Playwright MCP 期望的不匹配
                        if (tc.name.includes('Playwright')) {
                            // 1. browser_wait_for_Playwright: time 参数需要是数字
                            if (tc.name === 'browser_wait_for_Playwright') {
                                if (parsed.time !== undefined && typeof parsed.time === 'string') {
                                    const numTime = parseInt(parsed.time, 10);
                                    if (!isNaN(numTime)) {
                                        outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_wait_for: time "${parsed.time}" -> ${numTime}`);
                                        parsed.time = numTime;
                                    }
                                }
                                // wait_time -> time 映射
                                if (parsed.wait_time !== undefined && parsed.time === undefined) {
                                    const numTime = typeof parsed.wait_time === 'string' ? parseInt(parsed.wait_time, 10) : parsed.wait_time;
                                    outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_wait_for: wait_time -> time = ${numTime}`);
                                    parsed.time = numTime;
                                    delete parsed.wait_time;
                                }
                            }
                            // 2. browser_run_code_Playwright: 不需要修正，MCP 期望 'code' 参数
                            // GLM 生成的 'code' 参数名是正确的

                            // 3. browser_click_Playwright: selector -> element + ref
                            if (tc.name === 'browser_click_Playwright') {
                                // GLM 可能用 'selector' 而不是 'element' + 'ref'
                                if (parsed.selector !== undefined && parsed.element === undefined) {
                                    outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_click: selector -> element + ref`);
                                    // 尝试解析 selector，格式可能是 "generic ref=e63" 或 "canvas"
                                    const selectorStr = String(parsed.selector);
                                    const refMatch = selectorStr.match(/ref=(\w+)/);
                                    if (refMatch) {
                                        // 有 ref 信息，提取它
                                        parsed.ref = refMatch[1];
                                        // element 描述去掉 ref 部分
                                        parsed.element = selectorStr.replace(/\s*ref=\w+/, '').trim() || 'element';
                                    } else {
                                        // 没有 ref，用 selector 作为 element 描述
                                        parsed.element = selectorStr;
                                        // ref 需要从页面快照获取，这里无法自动填充
                                        // 但至少提供 element 描述
                                    }
                                    delete parsed.selector;
                                    outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_click result: element="${parsed.element}", ref="${parsed.ref || 'undefined'}"`);
                                }
                            }

                            // 4. browser_evaluate_Playwright: expression/code -> function
                            if (tc.name === 'browser_evaluate_Playwright') {
                                if (parsed.expression !== undefined && parsed.function === undefined) {
                                    outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_evaluate: expression -> function`);
                                    parsed.function = parsed.expression;
                                    delete parsed.expression;
                                }
                                // GLM 有时用 'code' 而不是 'expression'
                                if (parsed.code !== undefined && parsed.function === undefined) {
                                    outputChannel.appendLine(`[PLAYWRIGHT FIX] browser_evaluate: code -> function`);
                                    parsed.function = parsed.code;
                                    delete parsed.code;
                                }
                            }
                        }
                        // ========== Playwright 工具参数修正结束 ==========

                        // ========== view 工具参数修正 ==========
                        // GLM 模型可能把 view_range 数组参数生成为字符串格式 "[1, 200]"
                        // 需要转换为真正的数组 [1, 200]
                        if (tc.name === 'view' && parsed.view_range !== undefined) {
                            if (typeof parsed.view_range === 'string') {
                                try {
                                    // 尝试解析字符串格式的数组 "[1, 200]"
                                    const viewRangeParsed = JSON.parse(parsed.view_range);
                                    if (Array.isArray(viewRangeParsed) && viewRangeParsed.length === 2) {
                                        outputChannel.appendLine(`[VIEW FIX] view_range: "${parsed.view_range}" -> [${viewRangeParsed[0]}, ${viewRangeParsed[1]}]`);
                                        parsed.view_range = viewRangeParsed.map((n: any) => typeof n === 'string' ? parseInt(n, 10) : n);
                                    }
                                } catch (e) {
                                    outputChannel.appendLine(`[VIEW FIX] Failed to parse view_range: ${parsed.view_range}`);
                                }
                            }
                        }
                        // ========== view 工具参数修正结束 ==========

                        // 特别检查 save-file 的参数
                        if (tc.name === 'save-file') {
                            outputChannel.appendLine(`[API] save-file raw arguments: ${tc.arguments}`);
                            // 检查 GLM 是否用了错误的参数名
                            // GLM 可能用 'content' 或 'file' 而不是 'file_content'
                            if (parsed.content !== undefined && parsed.file_content === undefined) {
                                outputChannel.appendLine(`[API] save-file: mapping 'content' to 'file_content'`);
                                parsed.file_content = parsed.content;
                                delete parsed.content;
                            }
                            if (parsed.file !== undefined && parsed.file_content === undefined) {
                                outputChannel.appendLine(`[API] save-file: mapping 'file' to 'file_content'`);
                                parsed.file_content = parsed.file;
                                delete parsed.file;
                            }
                            outputChannel.appendLine(`[API] save-file file_content length: ${(parsed.file_content || '').length}`);
                            outputChannel.appendLine(`[API] save-file path: ${parsed.path}`);
                        }
                        inputJson = JSON.stringify(parsed);
                    }
                    catch (e) {
                        outputChannel.appendLine(`[API] Tool arguments parse error: ${e}`);
                        // 如果是因为输出被截断导致的 JSON 解析错误，跳过这个工具调用
                        if (finishReason === 'length') {
                            outputChannel.appendLine(`[API] Skipping truncated tool call: ${tc.name} (finish_reason=length)`);
                            // 发送错误提示给用户
                            res.write(JSON.stringify({
                                text: `\n\n⚠️ 工具调用被截断: ${tc.name} - 文件内容过长，请尝试分段处理或减少内容长度。\n\n`,
                                nodes: [],
                                stop_reason: 0
                            }) + '\n');
                            continue; // 跳过这个工具调用
                        }
                    }
                    const toolNode = {
                        type: 5, // TOOL_USE
                        tool_use: {
                            tool_use_id: tc.id,
                            tool_name: tc.name,
                            input_json: inputJson
                        }
                    };
                    const responseData = { text: '', nodes: [toolNode], stop_reason: 0 };
                    outputChannel.appendLine(`[API] Sending to Augment: ${JSON.stringify(responseData).substring(0, 500)}...`);
                    res.write(JSON.stringify(responseData) + '\n');
                    hasToolUse = true;
                }
            }
            // stop_reason: 1=正常结束, 3=工具调用
            const stopReason = hasToolUse ? 3 : 1;
            res.write(JSON.stringify({ text: '', nodes: [], stop_reason: stopReason }) + '\n');
            res.end();
            outputChannel.appendLine(`[API] Stream complete, chunks=${chunkCount}, toolCalls=${toolCalls.size}, stopReason=${stopReason}`);
        });
    });
    apiReq.on('error', (err) => {
        outputChannel.appendLine(`[API ERROR] Request failed: ${err.message}`);
        sendAugmentError(res, err.message);
    });
    apiReq.on('timeout', () => {
        outputChannel.appendLine(`[API ERROR] Request timeout`);
        apiReq.destroy();
        sendAugmentError(res, 'Request timeout');
    });
    apiReq.write(apiBody);
    apiReq.end();
    outputChannel.appendLine(`[API] Request sent, waiting for response...`);
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
// 生成注入代码 - 完整版，与 Python 一致
function generateInjectionCode(proxyUrl) {
    const timestamp = new Date().toISOString();
    return `
// ===== AUGMENT CUSTOM MODEL INJECTION v4.0 =====
// Injected at: ${timestamp}
// 方案：将 Augment API 请求路由到本地代理服务器
(function() {
    "use strict";

    // ===== 配置 =====
    const CONFIG = {
        enabled: true,
        proxyUrl: '${proxyUrl}',
        debug: true,
        routeAllRequests: true,
        proxyAvailable: false,  // 代理是否可用，启动时检测
        checkInterval: null
    };

    const log = (...args) => { if (CONFIG.debug) console.log('[Augment-Proxy]', ...args); };

    // 检查代理是否可用
    const checkProxyHealth = async () => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1000);  // 1秒超时
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

    // Hook Object.defineProperty 来拦截单例模式的 _instance 设置
    const originalDefineProperty = Object.defineProperty;
    Object.defineProperty = function(obj, prop, descriptor) {
        if (prop === '_instance' && descriptor && descriptor.value === void 0) {
            log('Intercepted _instance definition');
        }
        return originalDefineProperty.call(this, obj, prop, descriptor);
    };

    // 延迟注入 PluginState mock
    setTimeout(() => {
        log('Attempting to patch PluginState singleton...');
        try {
            for (const key in globalThis) {
                try {
                    const obj = globalThis[key];
                    if (obj && typeof obj === 'object' && typeof obj.getStateForSidecar === 'function') {
                        log('Found PluginState singleton:', key);
                        if (obj._instance === void 0) {
                            obj._instance = mockPluginState;
                            log('PluginState mock injected successfully!');
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {
            log('Error patching PluginState:', e.message);
        }
    }, 500);

    // ===== 核心：拦截 fetch 请求 =====
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

        // 提取端点路径 - 完整列表（与 Python 代理服务器完全一致）
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
        const http = require('http');
        const https = require('https');

        const getEndpoint = (url) => {
            // 核心 AI 端点
            if (url.includes('/chat-stream')) return '/chat-stream';
            if (url.includes('/chat-input-completion')) return '/chat-input-completion';
            if (url.includes('/chat')) return '/chat';
            if (url.includes('/instruction-stream')) return '/instruction-stream';
            if (url.includes('/smart-paste-stream')) return '/smart-paste-stream';
            if (url.includes('/completion')) return '/completion';
            // 插件状态和配置
            if (url.includes('/getPluginState')) return '/getPluginState';
            if (url.includes('/get-model-config')) return '/get-model-config';
            if (url.includes('/get-models')) return '/get-models';
            // 远程代理
            if (url.includes('/remote-agents/list-stream')) return '/remote-agents/list-stream';
            // 订阅和用户
            if (url.includes('/subscription-banner')) return '/subscription-banner';
            if (url.includes('/save-chat')) return '/save-chat';
            // 用户密钥
            if (url.includes('/user-secrets/list')) return '/user-secrets/list';
            if (url.includes('/user-secrets/upsert')) return '/user-secrets/upsert';
            if (url.includes('/user-secrets/delete')) return '/user-secrets/delete';
            // 通知
            if (url.includes('/notifications/mark-read')) return '/notifications/mark-read';
            if (url.includes('/notifications')) return '/notifications';
            // 遥测和事件
            if (url.includes('/client-completion-timelines')) return '/client-completion-timelines';
            if (url.includes('/record-session-events')) return '/record-session-events';
            // 错误报告
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
                const endpoint = isAugmentApi ? getEndpoint(targetUrl) : null;

                // 只有在代理可用时才拦截
                if (CONFIG.enabled && CONFIG.proxyAvailable && endpoint) {
                    log('[HTTP] Intercepted:', targetUrl);
                    const proxyHost = new URL(CONFIG.proxyUrl);
                    if (typeof urlOrOptions === 'object') {
                        urlOrOptions.hostname = proxyHost.hostname;
                        urlOrOptions.host = proxyHost.host;
                        urlOrOptions.port = proxyHost.port || 8765;
                        urlOrOptions.path = endpoint;
                        urlOrOptions.protocol = 'http:';
                        log('[HTTP] Routing to:', proxyHost.hostname + ':' + urlOrOptions.port + endpoint);
                    }
                } else if (isAugmentApi && !CONFIG.proxyAvailable) {
                    log('[HTTP] Proxy not available, passing through:', targetUrl.substring(0, 80));
                } else if (isAugmentApi) {
                    log('[HTTP] Passing through:', targetUrl);
                }

                return originalRequest.call(this, urlOrOptions, options, callback);
            };
        };

        http.request = wrapRequest(http.request, 'http');
        https.request = wrapRequest(https.request, 'https');
        log('HTTP/HTTPS request interception enabled');
    } catch (e) {
        log('HTTP interception not available (expected in browser context)');
    }

    // ===== 启动日志 =====
    log('='.repeat(50));
    log('Augment Proxy Injection v4.0 loaded!');
    log('Proxy URL:', CONFIG.proxyUrl);
    log('Enabled:', CONFIG.enabled);
    log('');
    log('Control in DevTools console:');
    log('  __AUGMENT_PROXY__.status()');
    log('  __AUGMENT_PROXY__.enable()');
    log('  __AUGMENT_PROXY__.disable()');
    log('  __AUGMENT_PROXY__.setProxyUrl("http://localhost:8765")');
    log('='.repeat(50));
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
function deactivate() {
    if (proxyServer) {
        proxyServer.close();
    }
}
//# sourceMappingURL=extension.js.map
