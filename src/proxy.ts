// ===== HTTP 代理服务器和路由处理 =====
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { state, log } from './globals';
import type { CanvasState, ConversationState, RecordedEvent } from './globals';
import { CodebaseRetrievalRequest, CodeSnippet } from './types';
import { PROVIDERS, PROVIDER_NAMES, DEFAULT_BASE_URLS, DEFAULT_MODELS, isAnthropicFormat, isGoogleFormat } from './config';
import { sendAugmentError } from './messages';
import { forwardToAnthropicStream } from './providers/anthropic';
import { forwardToOpenAIStream } from './providers/openai';
import { forwardToGoogleStream } from './providers/google';
const { RAGContextIndex } = require('./rag');
const { SemanticEmbeddings, LOCAL_MODELS } = require('./rag/embeddings');
import { VikingContextStore } from './rag/viking-context';
import { SessionMemory } from './rag/session-memory';

const MAX_EVENTS_PER_KEY = 200;

function sendJson(res: any, payload: any, statusCode = 200) {
    if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify(payload));
}

function readRequestBody(req: any): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: any) => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', (error: any) => reject(error));
    });
}

async function readJsonBody(req: any): Promise<any> {
    const body = await readRequestBody(req);
    if (!body.trim()) return {};
    return JSON.parse(body);
}

function pickString(data: any, ...keys: string[]): string | undefined {
    if (!data || typeof data !== 'object') return undefined;
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

function pickArray(data: any, ...keys: string[]): any[] {
    if (!data || typeof data !== 'object') return [];
    for (const key of keys) {
        const value = data[key];
        if (Array.isArray(value)) return value;
    }
    return [];
}

function nowIso(): string {
    return new Date().toISOString();
}

function isContinuationSignal(message: unknown): boolean {
    return typeof message === 'string' && message.trim() === '...';
}

function deriveConversationTitle(conversationId?: string, fallbackMessage?: string): string {
    const conversation = conversationId ? state.conversationStates.get(conversationId) : undefined;
    const title = conversation?.title?.trim();
    if (title) return title;
    const source = fallbackMessage || conversation?.lastMessage || '';
    const compact = source.replace(/\s+/g, ' ').trim();
    if (!compact) return 'Chat';
    return compact.slice(0, 60);
}

function extractEvents(data: any): any[] {
    if (Array.isArray(data)) return data;
    const candidates = ['events', 'session_events', 'user_events', 'request_events', 'items'];
    for (const key of candidates) {
        if (Array.isArray(data?.[key])) return data[key];
    }
    return data && typeof data === 'object' ? [data] : [];
}

function appendStoredEvents(store: Map<string, RecordedEvent[]>, key: string, events: RecordedEvent[]) {
    const existing = store.get(key) || [];
    const merged = existing.concat(events);
    store.set(key, merged.slice(Math.max(0, merged.length - MAX_EVENTS_PER_KEY)));
}

function upsertCanvasState(canvasId: string, updates: Partial<CanvasState> = {}): CanvasState {
    const existing = state.canvasStates.get(canvasId);
    const timestamp = nowIso();
    const next: CanvasState = {
        canvasId,
        conversationId: updates.conversationId ?? existing?.conversationId,
        title: updates.title ?? existing?.title ?? 'Chat',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        metadata: { ...(existing?.metadata || {}), ...(updates.metadata || {}) }
    };
    state.canvasStates.set(canvasId, next);
    return next;
}

function upsertConversationState(payload: any): ConversationState | undefined {
    const conversationId = pickString(payload, 'conversation_id', 'conversationId');
    if (!conversationId) return undefined;
    const existing = state.conversationStates.get(conversationId);
    const canvasId = pickString(payload, 'canvas_id', 'canvasId') ?? existing?.canvasId;
    const title = pickString(payload, 'title', 'conversation_title', 'conversationTitle') ?? existing?.title;
    const timestamp = nowIso();
    const next: ConversationState = {
        conversationId,
        canvasId,
        title,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastMessage: pickString(payload, 'message', 'request_message', 'requestMessage') ?? existing?.lastMessage,
        lastRequestId: pickString(payload, 'request_id', 'requestId') ?? existing?.lastRequestId,
        chatHistory: pickArray(payload, 'chat_history', 'history').length > 0 ? pickArray(payload, 'chat_history', 'history') : (existing?.chatHistory || []),
        compressedChatHistory: pickArray(payload, 'compressed_chat_history').length > 0 ? pickArray(payload, 'compressed_chat_history') : existing?.compressedChatHistory,
        nodes: pickArray(payload, 'nodes').length > 0 ? pickArray(payload, 'nodes') : (existing?.nodes || []),
        metadata: { ...(existing?.metadata || {}), ...(payload?.metadata || {}) }
    };
    state.conversationStates.set(conversationId, next);
    if (canvasId) {
        upsertCanvasState(canvasId, { conversationId, title });
    }
    return next;
}

function normalizeRecordedEvent(source: 'session' | 'user' | 'request', event: any, fallback: any): RecordedEvent {
    const recordedAt = pickString(event, 'recorded_at', 'created_at', 'timestamp') || nowIso();
    return {
        id: pickString(event, 'id', 'event_id', 'uuid') || `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        source,
        type: pickString(event, 'type', 'event_type', 'name', 'eventName') || 'unknown',
        recordedAt,
        conversationId: pickString(event, 'conversation_id', 'conversationId') || pickString(fallback, 'conversation_id', 'conversationId'),
        sessionId: pickString(event, 'session_id', 'sessionId') || pickString(fallback, 'session_id', 'sessionId'),
        requestId: pickString(event, 'request_id', 'requestId') || pickString(fallback, 'request_id', 'requestId'),
        canvasId: pickString(event, 'canvas_id', 'canvasId') || pickString(fallback, 'canvas_id', 'canvasId'),
        userId: pickString(event, 'user_id', 'userId') || pickString(fallback, 'user_id', 'userId'),
        payload: event
    };
}

function listCanvasStates(conversationId?: string): CanvasState[] {
    let canvases = Array.from(state.canvasStates.values());
    if (conversationId) {
        canvases = canvases.filter(canvas => canvas.conversationId === conversationId);
    }
    return canvases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ========== Viking/RAG 工作区扫描 ==========
async function scanAndIndexWorkspace(rootPath: string) {
    const docs: Array<{ path: string; content: string; hash: string }> = [];
    const crypto = require('crypto');

    async function scanDir(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(rootPath, fullPath);

            // 跳过常见的忽略目录
            if (entry.isDirectory()) {
                if (['node_modules', '.git', 'dist', 'build', 'out', '.vscode'].includes(entry.name)) continue;
                await scanDir(fullPath);
            } else if (entry.isFile()) {
                // 只索引代码文件
                const ext = path.extname(entry.name).toLowerCase();
                if (['.ts', '.js', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.md', '.json', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss', '.less', '.vue', '.svelte'].includes(ext)) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
                        docs.push({ path: relativePath, content, hash });
                    } catch (e) {
                        // 跳过无法读取的文件
                    }
                }
            }
        }
    }

    await scanDir(rootPath);
    log(`[VIKING] 📁 发现 ${docs.length} 个代码文件`);

    if (docs.length > 0 && state.vikingStore) {
        const generated = await state.vikingStore.batchGenerate(docs, (current, total) => {
            if (current % 50 === 0 || current === total) {
                log(`[VIKING] 📊 进度: ${current}/${total}`);
            }
        });
        log(`[VIKING] ✅ 生成了 ${generated} 个新的分层上下文`);

        const stats = state.vikingStore.getStats();
        log(`[VIKING] 📊 统计: ${stats.totalResources} 个资源, L0=${stats.l0TotalTokens} tokens, L1=${stats.l1TotalTokens} tokens`);
    }

    // 同时索引到 RAG（使用 addBatchToIndex）
    if (docs.length > 0 && state.ragIndex) {
        try {
            const indexed = await state.ragIndex.addBatchToIndex(docs);
            log(`[RAG] ✅ 已索引 ${indexed} 个文档到 RAG 引擎`);
        } catch (e: any) {
            log(`[RAG] ⚠️ 批量索引失败: ${e.message}`);
        }
    }
}

// ========== 路由处理 ==========
export function handleProxyRequest(req: any, res: any) {
    const urlPath = req.url || '/';
    log(`[${new Date().toISOString()}] ${req.method} ${urlPath}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    if (urlPath === '/health' || urlPath === '/') handleHealth(res);
    else if (urlPath === '/getPluginState') handlePluginState(res);
    else if (urlPath === '/get-model-config') handleModelConfig(res);
    else if (urlPath === '/get-models') handleGetModels(res);
    else if (urlPath === '/chat-input-completion') handleChatInputCompletion(req, res);
    else if (urlPath === '/completion') handleCodeCompletion(req, res);
    else if (urlPath === '/chat-stream' || urlPath === '/chat' || urlPath === '/instruction-stream' || urlPath === '/smart-paste-stream') handleChatStream(req, res);
    else if (urlPath === '/report-error') handleReportError(req, res);
    else if (urlPath === '/agents/codebase-retrieval') handleCodebaseRetrieval(req, res);
    else if (urlPath === '/agents/edit-file') handleAgentEditFile(req, res);
    else if (urlPath === '/agents/list-remote-tools') handleListRemoteTools(req, res);
    else if (urlPath === '/agents/run-remote-tool') handleRunRemoteTool(req, res);
    else if (urlPath === '/next-edit-stream') handleNextEditStream(req, res);
    else if (urlPath === '/find-missing') handleFindMissing(req, res);
    else if (urlPath === '/client-metrics') handleClientMetrics(req, res);
    else if (urlPath === '/client-completion-timelines') handleClientCompletionTimelines(req, res);
    else if (urlPath === '/batch-upload') handleBatchUpload(req, res);
    else if (urlPath === '/notifications/read' || urlPath === '/notifications/mark-read') handleNotificationsRead(req, res);
    else if (urlPath === '/record-request-events') handleRecordRequestEvents(req, res);
    else if (urlPath === '/report-feature-vector') handleReportFeatureVector(req, res);
    else if (urlPath === '/remote-agents/list-stream') handleRemoteAgentsListStream(req, res);
    else if (urlPath === '/agents/check-tool-safety') handleCheckToolSafety(req, res);
    else if (urlPath === '/settings/get-tenant-tool-permissions') handleTenantToolPermissions(req, res);
    else if (urlPath === '/search-external-sources') handleSearchExternalSources(req, res);
    else if (urlPath === '/get-implicit-external-sources') handleGetImplicitExternalSources(req, res);
    else if (urlPath === '/get-credit-info') handleGetCreditInfo(req, res);
    else if (urlPath === '/subscription-banner') handleSubscriptionBanner(req, res);
    else if (urlPath === '/generate-conversation-title') handleGenerateConversationTitle(req, res);
    else if (urlPath === '/save-chat') handleSaveChat(req, res);
    else if (urlPath === '/record-session-events') handleRecordSessionEvents(req, res);
    else if (urlPath === '/record-user-events') handleRecordUserEvents(req, res);
    else if (urlPath === '/context-canvas/list') handleContextCanvasList(req, res);
    else if (urlPath === '/resolve-completions' || urlPath === '/resolve-edit'
        || urlPath === '/resolve-instruction' || urlPath === '/resolve-smart-paste'
        || urlPath === '/resolve-next-edit' || urlPath === '/completion-feedback'
        || urlPath === '/chat-feedback' || urlPath === '/next-edit-feedback'
        || urlPath === '/record-preference-sample' || urlPath === '/notifications/mark-as-read'
        || urlPath === '/resolve-chat-input-completion'
        || urlPath === '/agents/revoke-tool-access' || urlPath === '/checkpoint-blobs'
        || urlPath === '/prompt-enhancer' || urlPath === '/token'
        || urlPath === '/github/is-user-configured' || urlPath === '/github/get-repo'
        || urlPath === '/github/list-repos' || urlPath === '/github/list-branches') {
        // 日志/反馈/解析 端点 — 返回通用成功响应
        let body = ''; req.on('data', (c: any) => body += c);
        req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); });
    }
    else { log(`[UNHANDLED] ${req.method} ${urlPath}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); }
}

// ========== 简单端点 ==========
function handleHealth(res: any) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', provider: state.currentConfig.provider, model: state.currentConfig.model, has_api_key: !!state.currentConfig.apiKey }));
}
function handlePluginState(res: any) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: true, hasValidSubscription: true, subscriptionType: 'pro', planName: 'Pro (Proxy)', email: 'proxy@local', features: { chat: true, completion: true, instruction: true, agentMode: true } }));
}
function handleModelConfig(res: any) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ internalName: state.currentConfig.model, displayName: `${PROVIDER_NAMES[state.currentConfig.provider]} - ${state.currentConfig.model}`, provider: state.currentConfig.provider }));
}
function handleGetModels(res: any) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 模型定义 — 所有请求最终都通过代理转发到用户配置的实际 provider
    // 这里的 ID 只是展示用，不影响实际路由
    const defaultModelId = "claude-opus-4-6";
    const models = [
        { id: "claude-opus-4-6",    name: "Claude Opus 4.6",  desc: "Best for complex tasks",    shortName: "opus",    priority: 1 },
        { id: "claude-sonnet-4-5",  name: "Sonnet 4.5",       desc: "Great for everyday tasks",  shortName: "sonnet",  priority: 2 },
        { id: "gpt-5-1",           name: "GPT-5.1",          desc: "",                          shortName: "gpt51",   priority: 3 },
        { id: "gpt-5-2",           name: "GPT-5.2",          desc: "",                          shortName: "gpt52",   priority: 4 },
        { id: "claude-haiku-4-5",   name: "Haiku 4.5",        desc: "",                          shortName: "haiku",   priority: 5 },
    ];
    log(`[GET-MODELS] Returning ${models.length} models, default: ${defaultModelId} (actual: ${state.currentConfig.provider}/${state.currentConfig.model})`);

    // additionalChatModels: JSON string — 聊天模型选择器下拉项 {displayName: modelId}
    const additionalChatModels: Record<string, string> = {};
    for (const m of models) { additionalChatModels[m.name] = m.id; }

    // modelInfoRegistry: JSON string — 模型元数据 {modelId: {displayName, shortName, description, priority}}
    const modelInfoRegistry: Record<string, any> = {};
    for (const m of models) {
        modelInfoRegistry[m.id] = { displayName: m.name, shortName: m.shortName, description: m.desc, priority: m.priority };
    }

    // modelRegistry: JSON string — 简单 ID→显示名映射 (fallback)
    const modelRegistry: Record<string, string> = {};
    for (const m of models) { modelRegistry[m.id] = m.name; }

    // 完整的 get-models 响应 — 匹配 Augment 扩展 toGetModelsResult 解析器所需的所有字段
    // 版本门控: hs(minVersion) 当 minVersion="" 返回 false(禁用)，minVersion="0.0.0" 时 VSCode 版本 >= 0.0.0 始终为 true(启用)
    res.end(JSON.stringify({
        default_model: defaultModelId,
        models: models.map(m => ({
            name: m.id,
            internal_name: m.id,
            suggested_prefix_char_count: 10000,
            suggested_suffix_char_count: 3000,
            completion_timeout_ms: 30000
        })),
        feature_flags: {
            // === 基础功能 (bool) ===
            enableChat: true,
            enableInstructions: true,
            enableSmartPaste: true,
            enableHindsight: false,
            enableSentry: false,
            enableCompletionFileEditEvents: false,
            enableCommitIndexing: false,
            fraudSignEndpoints: false,
            // === 数值 (int64) ===
            maxUploadSizeBytes: 1048576,
            notificationPollingIntervalMs: 0,
            // === 版本门控 (string) — "0.0.0" 让 hs() 始终通过 ===
            vscodeAgentModeMinVersion: "0.0.0",
            vscodeAgentModeMinStableVersion: "0.0.0",
            vscodeChatWithToolsMinVersion: "0.0.0",
            vscodeChatMultimodalMinVersion: "0.0.0",
            vscodeBackgroundAgentsMinVersion: "0.0.0",
            vscodeSupportToolUseStartMinVersion: "0.0.0",
            vscodeChatStablePrefixTruncationMinVersion: "0.0.0",
            historySummaryMinVersion: "0.0.0",
            vscodePersonalitiesMinVersion: "0.0.0",
            vscodeTaskListMinVersion: "0.0.0",
            useCheckpointManagerContextMinVersion: "0.0.0",
            vscodeNextEditMinVersion: "99.99.99",
            vscodeDesignSystemRichTextEditorMinVersion: "0.0.0",
            vscodeShowThinkingSummaryMinVersion: "0.0.0",
            // === Agent 工具配置 ===
            agentChatModel: defaultModelId,                             // string — getModelName() 用这个解析显示名
            vscodeAgentEditTool: "backend_edit_tool",                   // string
            agentEditToolSchemaType: "StrReplaceEditorToolDefinitionNested", // string
            agentEditToolEnableFuzzyMatching: false,                    // bool
            agentEditToolShowResultSnippet: true,                       // bool
            agentEditToolMaxLines: 200,                                 // int64
            agentEditToolInstructionsReminder: false,                   // bool
            agentSaveFileToolInstructionsReminder: false,               // bool
            // === Agent Auto Mode (bool, protobuf field 130) ===
            enableAgentAutoMode: true,
            // === 工具开关 (bool) ===
            enableGroupedTools: true,
            grepSearchToolEnable: true,
            enableApplyPatchTool: true,
            // === 工具参数 (int64) ===
            grepSearchToolTimelimitSec: 10,
            grepSearchToolOutputCharsLimit: 5000,
            // === Rules / Guidelines / Custom Commands / Canvas (bool) ===
            enableSharedGuidelines: true,
            enableCustomCommands: true,
            enableContextCanvas: false,
            enableRules: true,
            enableGuidelines: true,
            enableHierarchicalRules: true,
            // === MCP / 权限 (bool) ===
            allowClientFeatureFlagOverrides: true,
            enableTenantLevelToolPermissions: true,
            // === 模型注册表 — protobuf 字段 110/182/9 类型是 string！===
            // cQn 转换器 Jfe = JSON.parse 会在 protobuf 解析后将这些 string → object
            modelRegistry: JSON.stringify(modelRegistry),
            modelInfoRegistry: JSON.stringify(modelInfoRegistry),
            additionalChatModels: JSON.stringify(additionalChatModels)
        },
        user_tier: "enterprise",
        user: {
            id: "proxy-user",
            email: "proxy@augmentcode.com",
            tenant_id: "proxy",
            tenant_name: "Proxy"
        },
        bootstrap_settings: {}
    }));
}
function handleGetCreditInfo(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ usage_units_remaining: 999999, is_credit_balance_low: false, display_info: { usage_unit_display_name: "credits", usage_limit: 999999, usage_used: 0 } }));
    });
}
function handleSubscriptionBanner(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
    });
}
function handleGenerateConversationTitle(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        try {
            const data = body.trim() ? JSON.parse(body) : {};
            const conversationId = pickString(data, 'conversation_id', 'conversationId');
            const fallbackMessage = pickString(data, 'message', 'request_message', 'requestMessage');
            const title = deriveConversationTitle(conversationId, fallbackMessage);
            if (conversationId) {
                upsertConversationState({ conversation_id: conversationId, title, message: fallbackMessage });
            }
            sendJson(res, { title });
        } catch (error: any) {
            log(`[GENERATE-CONVERSATION-TITLE] Error: ${error}`);
            sendJson(res, { title: 'Chat', error: error.message || String(error) });
        }
    });
}
function handleChatInputCompletion(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        try { log(`[CHAT-INPUT-COMPLETION] prompt: ${(JSON.parse(body).prompt || '').slice(0, 50)}...`); } catch { }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ completions: [], text: '', stop_reason: 1, unknown_blob_names: [], unknown_memory_names: [], checkpoint_not_found: false }));
    });
}
function handleCodeCompletion(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ completions: [], unknown_blob_names: [], unknown_memory_names: [] }));
    });
}
function handleReportError(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        try {
            const d = JSON.parse(body); const msg = d.error_message || d.message || d.error || 'unknown';
            const typ = d.error_type || d.type || ''; const ctx = d.context || d.endpoint || '';
            const skip = ['get-models','client-metrics','client-completion'].some(p => msg.toLowerCase().includes(p) || ctx.toLowerCase().includes(p));
            if (!skip) log(`[REPORT-ERROR] ${typ ? typ+': ':''}${msg}${ctx ? ' (context: '+ctx+')':''}`);
        } catch { }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
    });
}

// ========== Codebase Retrieval Helpers ==========
function getWorkspaceRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];
    return folders.map(f => { try { return fs.realpathSync(f.uri.fsPath); } catch { return f.uri.fsPath; } });
}
function findFilesRecursive(dir: string, extensions: string[], maxDepth = 10, depth = 0): string[] {
    if (depth > maxDepth) return [];
    const results: string[] = [];
    try {
        for (const item of fs.readdirSync(dir)) {
            if (['node_modules','.git','dist','build','.next','__pycache__','.venv','venv'].includes(item)) continue;
            const fp = path.join(dir, item);
            try { const s = fs.statSync(fp); if (s.isDirectory()) results.push(...findFilesRecursive(fp, extensions, maxDepth, depth+1)); else if (s.isFile() && (extensions.length === 0 || extensions.includes(path.extname(item).toLowerCase()))) results.push(fp); } catch {}
        }
    } catch {}
    return results;
}
function searchInFile(filePath: string, keywords: string[], maxSnippets = 3): CodeSnippet[] {
    try {
        const content = fs.readFileSync(filePath, 'utf-8'); const lines = content.split('\n');
        const scores: { ln: number; s: number }[] = [];
        for (let i = 0; i < lines.length; i++) { const lo = lines[i].toLowerCase(); let s = 0; for (const kw of keywords) { if (lo.includes(kw.toLowerCase())) { s++; if (new RegExp(`\\b${kw}\\b`,'i').test(lines[i])) s += 2; } } if (s > 0) scores.push({ ln: i, s }); }
        scores.sort((a, b) => b.s - a.s);
        return scores.slice(0, maxSnippets).map(m => { const st = Math.max(0, m.ln - 5); const en = Math.min(lines.length - 1, m.ln + 5); return { path: filePath, content: lines.slice(st, en + 1).join('\n'), lineStart: st + 1, lineEnd: en + 1, score: m.s }; });
    } catch { return []; }
}
function extractKeywords(query: string): string[] {
    const stop = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','must','shall','can','need','to','of','in','for','on','with','at','by','from','as','into','through','during','before','after','above','below','between','under','and','but','if','or','because','until','while','although','though','where','when','what','which','who','whom','this','that','these','those','i','me','my','we','our','you','your','he','him','his','she','her','it','its','they','them','their','how','find','show','get','look','search','code','function','class','method']);
    return [...new Set(query.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(w => w.length > 2 && !stop.has(w)))];
}

// ========== RAG 初始化 (v2.0.0: Viking 增强) ==========
export async function initializeRAGIndex(): Promise<void> {
    const roots = getWorkspaceRoots(); if (roots.length === 0) return;
    const workspaceRoot = roots[0];
    const cacheDir = path.join(workspaceRoot, '.augment-rag');
    try {
        state.ragIndex = new RAGContextIndex({ workspaceRoot });
        log('[RAG] Initializing LevelDB storage...');
        await state.ragIndex.initStorage();
        log(`[RAG] Indexing files in ${workspaceRoot}...`);
        const t0 = Date.now();
        await state.ragIndex.initialize((c: number, t: number) => { if (c % 500 === 0) log(`[RAG] Indexing progress: ${c}/${t}`); });
        const stats = state.ragIndex.getStats();
        log(`[RAG] Index ready: ${stats.documentCount} docs, checkpoint ${stats.checkpointId}, took ${((Date.now()-t0)/1000).toFixed(2)}s`);

        const cfg = vscode.workspace.getConfiguration('augmentProxy');

        // v2.0.0: 初始化 Viking 分层上下文
        try {
            state.vikingStore = new VikingContextStore(cacheDir);
            await state.vikingStore.init();
            state.ragIndex.setVikingStore(state.vikingStore);
            log('[Viking] 📂 Context store initialized');
        } catch (e: any) { log(`[Viking] ⚠️ Context store failed: ${e.message}`); }

        // v2.0.0: 初始化 Session Memory
        try {
            state.sessionMemory = new SessionMemory(cacheDir);
            await state.sessionMemory.init();
            const memStats = state.sessionMemory.getStats();
            log(`[Viking] 🧠 Session memory loaded: ${memStats.preferences} prefs, ${memStats.experiences} experiences`);
        } catch (e: any) { log(`[Viking] ⚠️ Session memory failed: ${e.message}`); }

        // Embedding 引擎 — 后台异步初始化，不阻塞 RAG 启动
        // 模型下载可能很慢（335MB），同步 await 会导致 extension host 超时崩溃
        state.semanticEngine = new SemanticEmbeddings(
            cacheDir,
            (m: string) => log(m),
            (s: any) => { if (state.sidebarProvider) state.sidebarProvider.updateEmbeddingStatus(s); }
        );

        // v3.0.0: OOM 崩溃防护 — 大模型加载可能导致 extension host OOM 崩溃循环
        // 用 globalState 标记"正在加载"，如果上次加载时崩了（标记还在），自动回退到默认小模型
        let localModel = cfg.get('embedding.localModel', 'Xenova/all-MiniLM-L6-v2') as string;
        const lastLoadingModel = state.extensionContext?.globalState.get<string>('embeddingModelLoading');
        if (lastLoadingModel && lastLoadingModel === localModel) {
            const modelInfo = LOCAL_MODELS.find(m => m.id === localModel);
            if (modelInfo && modelInfo.sizeMB > 100) {
                log(`[RAG] ⚠️ 上次加载 ${localModel} 时崩溃，自动回退到默认小模型`);
                localModel = 'Xenova/all-MiniLM-L6-v2';
                // 同时更新配置，避免下次还加载大模型
                Promise.resolve(cfg.update('embedding.localModel', localModel, vscode.ConfigurationTarget.Global)).catch(() => {});
            }
        }
        state.semanticEngine.setLocalModel(localModel);

        const mirror = cfg.get('embedding.mirror', '') as string;
        if (mirror) {
            state.semanticEngine.setMirror(mirror);
            log(`[RAG] 🪞 HuggingFace mirror: ${mirror}`);
        }

        const embEnabled = cfg.get('embedding.enabled', false) as boolean;
        if (embEnabled) {
            const embProvider = cfg.get('embedding.provider', '') as string;
            const embApiKey = cfg.get('embedding.apiKey', '') as string;
            if (embProvider && embApiKey) {
                state.semanticEngine.configureRemote({
                    enabled: true,
                    provider: embProvider as 'glm' | 'openai' | 'custom',
                    apiKey: embApiKey,
                    baseUrl: cfg.get('embedding.baseUrl', '') as string,
                    model: cfg.get('embedding.model', '') as string
                });
                log(`[RAG] 🌐 Remote embedding configured: ${embProvider}`);
            }
        }

        // 🔥 后台异步：不 await，模型下载完成后自动挂载
        const ragIndexRef = state.ragIndex;
        const vikingStoreRef = state.vikingStore;
        // v3.0.0: 设置 "正在加载" 标记 — 如果加载过程中 OOM 崩溃，下次启动能检测到
        state.extensionContext?.globalState.update('embeddingModelLoading', localModel);
        state.semanticEngine.initialize().then(async () => {
            // 加载成功，清除崩溃标记
            state.extensionContext?.globalState.update('embeddingModelLoading', '');
            if (ragIndexRef) {
                ragIndexRef.setSemanticEngine(state.semanticEngine!);
                log('[RAG] 🧠 Semantic search enabled (background)');
                // 后台预加载嵌入
                try {
                    log('[RAG] 🔄 Pre-generating embeddings...');
                    await ragIndexRef.preloadEmbeddings((c: number, t: number) => {
                        if (c % 50 === 0 || c === t) log(`[RAG] Embedding progress: ${c}/${t}`);
                    });
                } catch (e: any) { log(`[RAG] ⚠️ Embedding preload failed: ${e.message}`); }
                // Viking L0/L1
                if (vikingStoreRef) {
                    const ragStats = ragIndexRef.getStats();
                    if (ragStats.documentCount > 0) {
                        log(`[Viking] 📊 L0/L1 will be generated on-demand for ${ragStats.documentCount} docs`);
                    }
                    const vkStats = vikingStoreRef.getStats();
                    log(`[Viking] 📊 Context store: ${vkStats.totalResources} resources, ~${vkStats.l0TotalTokens} L0 tokens`);
                }
            }
        }).catch((e: any) => {
            // 正常失败（非 OOM），清除崩溃标记
            state.extensionContext?.globalState.update('embeddingModelLoading', '');
            log(`[RAG] ⚠️ Semantic engine failed: ${e.message}`);
            log('[RAG] BM25 mode until model is ready');
        });
        log('[RAG] 🧠 Semantic engine initializing in background...');
    } catch (err) { log(`[RAG] Failed to initialize: ${err}`); state.ragIndex = null; }
}

export async function closeRAGIndex(): Promise<void> {
    if (state.ragIndex) {
        try { await state.ragIndex.close(); log('[RAG] LevelDB storage closed'); }
        catch (e) { log(`[RAG] Error closing: ${e}`); }
        state.ragIndex = null;
    }
    if (state.vikingStore) {
        try { await state.vikingStore.close(); } catch { /* ignore */ }
        state.vikingStore = null;
    }
    if (state.sessionMemory) {
        try { await state.sessionMemory.close(); } catch { /* ignore */ }
        state.sessionMemory = null;
    }
}

// ========== handleCodebaseRetrieval ==========
function handleCodebaseRetrieval(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c);
    req.on('end', async () => {
        try {
            const data: CodebaseRetrievalRequest = JSON.parse(body); const query = data.information_request || '';
            log(`[CODEBASE-RETRIEVAL] Query: ${query.slice(0, 100)}...`);
            if (data.disable_codebase_retrieval) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ formatted_retrieval: 'Codebase retrieval is disabled.', unknown_blob_names: [], checkpoint_not_found: false })); return; }
            const roots = getWorkspaceRoots();
            if (roots.length === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ formatted_retrieval: 'No workspace folder is open.', unknown_blob_names: [], checkpoint_not_found: false })); return; }
            if (!state.ragIndex) await initializeRAGIndex();
            let formatted = ''; let count = 0;
            if (state.ragIndex) {
                const t0 = Date.now(); const results = await state.ragIndex.searchAsync(query, 10); const ms = Date.now() - t0;
                log(`[RAG] Search completed in ${ms}ms, found ${results.length} results`);
                if (results.length > 0) { formatted = `Found ${results.length} relevant code snippets (RAG search):\n\n`; for (const r of results) { formatted += `## ${r.path} (lines ${r.lineStart}-${r.lineEnd})\n*Matched: ${r.highlights.join(', ')}*\n\`\`\`\n${r.content}\n\`\`\`\n\n`; } count = results.length; }
            }
            if (count === 0) {
                log('[CODEBASE-RETRIEVAL] RAG returned no results, falling back to keyword search');
                const kw = extractKeywords(query);
                if (kw.length > 0) { const exts = ['.ts','.tsx','.js','.jsx','.py','.go','.rs','.java','.cpp','.c','.h','.hpp','.cs','.rb','.php','.swift','.kt','.scala','.vue','.svelte']; const all: CodeSnippet[] = []; for (const root of roots) { for (const f of findFilesRecursive(root, exts).slice(0, 300)) { for (const s of searchInFile(f, kw)) { s.path = path.relative(root, s.path); all.push(s); } } } all.sort((a, b) => b.score - a.score); const top = all.slice(0, 10); if (top.length > 0) { formatted = `Found ${top.length} relevant code snippets (keyword search):\n\n`; for (const s of top) formatted += `## ${s.path} (lines ${s.lineStart}-${s.lineEnd})\n\`\`\`\n${s.content}\n\`\`\`\n\n`; count = top.length; } }
            }
            if (count === 0) formatted = `No matching code found for: "${query}"`;
            log(`[CODEBASE-RETRIEVAL] Returning ${count} snippets`);
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ formatted_retrieval: formatted, unknown_blob_names: [], checkpoint_not_found: false }));
        } catch (error) { log(`[CODEBASE-RETRIEVAL] Error: ${error}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ formatted_retrieval: `Error: ${error}`, unknown_blob_names: [], checkpoint_not_found: false })); }
    });
}

// ========== Agent Handlers ==========
function handleAgentEditFile(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        try { const d = JSON.parse(body); log(`[AGENT-EDIT-FILE] file_path: ${d.file_path || 'unknown'}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ modified_file_contents: null, is_error: true, error_message: 'Server-side edit not supported. Use str-replace-editor tool instead.' })); }
        catch (e) { log(`[AGENT-EDIT-FILE] Error: ${e}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ modified_file_contents: null, is_error: true, error_message: 'Parse error' })); }
    });
}
function handleListRemoteTools(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        try { const d = JSON.parse(body); log(`[LIST-REMOTE-TOOLS] tool_ids: ${JSON.stringify(d.tool_id_list?.tool_ids || [])}`); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tools: [] }));
    });
}
function handleRunRemoteTool(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        try { const d = JSON.parse(body); log(`[RUN-REMOTE-TOOL] tool_name: ${d.tool_name || 'unknown'}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tool_output: 'Remote tools are not supported in local proxy mode.', tool_result_message: 'This feature requires Augment cloud connection.', status: 'NOT_IMPLEMENTED' })); }
        catch (e) { log(`[RUN-REMOTE-TOOL] Error: ${e}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tool_output: 'Error parsing request', status: 'ERROR' })); }
    });
}
function handleNextEditStream(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', async () => {
        try {
            const d = JSON.parse(body); const filePath = d.file_path || d.path || ''; const content = d.content || ''; const cursorLine = d.cursor_position?.line || 0;
            if (!state.ragIndex || !filePath) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end(JSON.stringify({ chunks: [], stop_reason: 1, has_more: false }) + '\n'); return; }
            const lines = content.split('\n'); const ctx = lines.slice(Math.max(0, cursorLine - 5), Math.min(lines.length, cursorLine + 5)).join('\n');
            const query = `${path.basename(filePath).replace(/\.[^.]+$/, '')} ${ctx}`;
            const results = await state.ragIndex.searchAsync(query, 3);
            const related = results.filter((r: any) => !r.path.endsWith(path.basename(filePath)));
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            if (related.length > 0) { log(`[NEXT-EDIT] Found ${related.length} related files for ${filePath}`); res.write(JSON.stringify({ type: 'related_files', related_files: related.map((r: any) => ({ file_path: r.path, relevance: r.score, matched_terms: r.highlights })) }) + '\n'); }
            res.end(JSON.stringify({ chunks: [], stop_reason: 1, has_more: false }) + '\n');
        } catch (e) { log(`[NEXT-EDIT] Error: ${e}`); res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end(JSON.stringify({ chunks: [], stop_reason: 1, has_more: false }) + '\n'); }
    });
}
function handleFindMissing(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        try {
            const d = JSON.parse(body);
            log(`[FIND-MISSING] mem_object_names count: ${d.mem_object_names?.length || 0}`);
            // 扩展的 toFindMissingResult 期望 unknown_memory_names 和 nonindexed_blob_names
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ unknown_memory_names: [], nonindexed_blob_names: [] }));
        } catch (e) {
            log(`[FIND-MISSING] Error: ${e}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ unknown_memory_names: [], nonindexed_blob_names: [] }));
        }
    });
}
function handleClientMetrics(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); });
}
function handleClientCompletionTimelines(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); });
}
function handleBatchUpload(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', async () => {
        try {
            const d = JSON.parse(body); const blobs = d.blobs || []; const pathMap = d.paths || {}; let indexed = 0;
            const blobNames: string[] = [];
            if (state.ragIndex && blobs.length > 0) {
                const codeExts = ['.ts','.tsx','.js','.jsx','.py','.go','.rs','.java','.cpp','.c','.h','.cs','.rb','.php','.swift','.kt','.scala','.vue','.svelte'];
                const files: Array<{ path: string; content: string }> = [];
                for (const b of blobs) { const name = b.name || b.blob_name; blobNames.push(name); const content = b.content || b.data; const fp = b.path || pathMap[name]; if (fp && content && typeof content === 'string' && codeExts.includes(path.extname(fp).toLowerCase())) files.push({ path: fp, content }); }
                if (files.length > 0) { indexed = await state.ragIndex.addBatchToIndex(files); log(`[BATCH-UPLOAD] Indexed ${indexed}/${files.length} files to local RAG`); }
            } else {
                for (const b of blobs) blobNames.push(b.name || b.blob_name || '');
            }
            // 扩展的 toBatchUploadResult 期望 blob_names 数组
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ blob_names: blobNames }));
        } catch (e) { log(`[BATCH-UPLOAD] Error: ${e}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ blob_names: [] })); }
    });
}
function handleNotificationsRead(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ notifications: [] })); });
}
async function handleSaveChat(req: any, res: any) {
    try {
        const body = await readJsonBody(req);
        const conversation = upsertConversationState(body);
        const conversationId = conversation?.conversationId;
        const canvasId = conversation?.canvasId ?? pickString(body, 'canvas_id', 'canvasId');
        if (canvasId) {
            upsertCanvasState(canvasId, {
                conversationId,
                title: conversation?.title ?? pickString(body, 'title', 'conversation_title', 'conversationTitle')
            });
        }
        sendJson(res, {
            success: true,
            conversation_id: conversationId,
            canvas_id: canvasId,
            title: conversation?.title ?? 'Chat'
        });
    } catch (error: any) {
        log(`[SAVE-CHAT] Error: ${error}`);
        sendJson(res, { success: false, error: error.message || String(error) });
    }
}
async function handleRecordSessionEvents(req: any, res: any) {
    try {
        const body = await readJsonBody(req);
        const events = extractEvents(body).map(event => normalizeRecordedEvent('session', event, body));
        const sessionId = pickString(body, 'session_id', 'sessionId') || events[0]?.sessionId || 'default';
        appendStoredEvents(state.sessionEventStore, sessionId, events);
        if (pickString(body, 'conversation_id', 'conversationId') || pickString(body, 'canvas_id', 'canvasId')) {
            upsertConversationState(body);
        }
        sendJson(res, {
            success: true,
            recorded: events.length,
            session_id: sessionId,
            conversation_id: pickString(body, 'conversation_id', 'conversationId'),
            canvas_id: pickString(body, 'canvas_id', 'canvasId')
        });
    } catch (error: any) {
        log(`[RECORD-SESSION-EVENTS] Error: ${error}`);
        sendJson(res, { success: false, error: error.message || String(error) });
    }
}
async function handleRecordUserEvents(req: any, res: any) {
    try {
        const body = await readJsonBody(req);
        const events = extractEvents(body).map(event => normalizeRecordedEvent('user', event, body));
        const userId = pickString(body, 'user_id', 'userId') || events[0]?.userId || pickString(body, 'conversation_id', 'conversationId') || 'default';
        appendStoredEvents(state.userEventStore, userId, events);
        if (pickString(body, 'conversation_id', 'conversationId') || pickString(body, 'canvas_id', 'canvasId')) {
            upsertConversationState(body);
        }
        sendJson(res, {
            success: true,
            recorded: events.length,
            user_id: userId,
            conversation_id: pickString(body, 'conversation_id', 'conversationId'),
            canvas_id: pickString(body, 'canvas_id', 'canvasId')
        });
    } catch (error: any) {
        log(`[RECORD-USER-EVENTS] Error: ${error}`);
        sendJson(res, { success: false, error: error.message || String(error) });
    }
}
async function handleRecordRequestEvents(req: any, res: any) {
    try {
        const body = await readJsonBody(req);
        const events = extractEvents(body).map(event => normalizeRecordedEvent('request', event, body));
        const requestId = pickString(body, 'request_id', 'requestId') || events[0]?.requestId || 'default';
        appendStoredEvents(state.requestEventStore, requestId, events);
        const conversation = upsertConversationState(body);
        if (conversation && requestId && requestId !== 'default') {
            state.conversationStates.set(conversation.conversationId, { ...conversation, lastRequestId: requestId, updatedAt: nowIso() });
        }
        sendJson(res, {
            success: true,
            recorded: events.length,
            request_id: requestId,
            conversation_id: pickString(body, 'conversation_id', 'conversationId'),
            canvas_id: pickString(body, 'canvas_id', 'canvasId')
        });
    } catch (error: any) {
        log(`[RECORD-REQUEST-EVENTS] Error: ${error}`);
        sendJson(res, { success: false, error: error.message || String(error) });
    }
}
async function handleContextCanvasList(req: any, res: any) {
    try {
        const body = await readJsonBody(req);
        const conversationId = pickString(body, 'conversation_id', 'conversationId');
        const canvases = listCanvasStates(conversationId).map(canvas => ({
            canvas_id: canvas.canvasId,
            conversation_id: canvas.conversationId,
            title: canvas.title,
            created_at: canvas.createdAt,
            updated_at: canvas.updatedAt
        }));
        sendJson(res, { canvases, items: canvases, success: true });
    } catch (error: any) {
        log(`[CONTEXT-CANVAS-LIST] Error: ${error}`);
        sendJson(res, { canvases: [], items: [], success: false, error: error.message || String(error) });
    }
}
function handleReportFeatureVector(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); });
}
function handleRemoteAgentsListStream(_req: any, res: any) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end(JSON.stringify({ agents: [], has_more: false }) + '\n');
}
function handleCheckToolSafety(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        try { const d = JSON.parse(body); log(`[CHECK-TOOL-SAFETY] tool_id: ${d.tool_id}`); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ is_safe: true }));
    });
}
function handleTenantToolPermissions(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({}));
    });
}
function handleSearchExternalSources(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ results: [] }));
    });
}
function handleGetImplicitExternalSources(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ sources: [] }));
    });
}

// ========== 核心 Chat Stream ==========
function handleChatStream(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c);
    req.on('end', async () => {
        try {
            const augmentReq = JSON.parse(body);
            const conversationId = augmentReq.conversation_id || '';
            const historyCount = augmentReq.chat_history?.length || 0;
            log(`[CHAT-STREAM] message: "${(augmentReq.message || '').slice(0, 50)}..." history: ${historyCount}`);
            upsertConversationState(augmentReq);

            // 会话级请求队列 — 防止同一会话并发请求导致工具在 checkingSafety 阶段被取消
            const pending = state.conversationQueues.get(conversationId);
            if (pending) { log(`[QUEUE] Waiting for pending request on conversation ${conversationId.substring(0, 8)}...`); try { await pending; } catch {} log(`[QUEUE] Previous request completed, proceeding...`); }
            let resolveReq: () => void;
            const curPromise = new Promise<void>(r => { resolveReq = r; });
            state.conversationQueues.set(conversationId, curPromise);

            try {
                // ========== Viking/RAG 上下文注入 ==========
                const userMsg = augmentReq.message || augmentReq.request_message || '';
                let vikingContext = '';
                let ragResults: string[] = [];

                const isToolContinuation = isContinuationSignal(userMsg) && augmentReq.chat_history && augmentReq.chat_history.length > 0;
                if (isToolContinuation) {
                    log('[CHAT-STREAM] 检测到 continuation signal，保留原始消息，不做 prompt hack');
                }

                // 1. RAG 检索相关代码（跳过"..."消息的检索）
                if (userMsg && !isToolContinuation && state.ragIndex) {
                    try {
                        const results = await state.ragIndex.search(userMsg, 5);
                        if (results && results.length > 0) {
                     ragResults = results.map((r: any) => `[${r.path}]\n${r.content.slice(0, 1000)}`);
                            log(`[RAG] 🔍 检索到 ${results.length} 个相关代码片段`);
                        }
                    } catch (e: any) {
                        log(`[RAG] ⚠️ 检索失败: ${e.message}`);
                    }
                }

                // 2. Viking L0 批量注入（所有文件的摘要）
                if (state.vikingStore) {
                    try {
                        const allPaths = state.vikingStore.getAllPaths();
                        if (allPaths.length > 0) {
                            // 只注入前 200 个文件的 L0 摘要（约 5k tokens）
                            const topPaths = allPaths.slice(0, 200);
                            vikingContext = state.vikingStore.getL0Batch(topPaths);
                            log(`[VIKING] 📋 注入 ${topPaths.length} 个文件的 L0 摘要`);
                        }
                    } catch (e: any) {
                        log(`[VIKING] ⚠️ L0 注入失败: ${e.message}`);
                    }
                }

                // 3. 将 Viking L0 注入到 system prompt
                if (vikingContext) {
                    const vikingPrompt = `\n\n# Codebase Structure (Viking L0)\n${vikingContext}`;
                    if (augmentReq.system_prompt) {
                        augmentReq.system_prompt += vikingPrompt;
                    } else {
                        augmentReq.system_prompt = vikingPrompt;
                    }
                }

                // 4. 将 RAG 结果注入到用户消息
                if (ragResults.length > 0) {
                    const ragPrompt = `\n\n<relevant_code>\n${ragResults.join('\n---\n')}\n</relevant_code>`;
                    augmentReq.message = (augmentReq.message || '') + ragPrompt;
                }

                // v2.0.0: Session Memory — 从用户消息中提取偏好
                if (userMsg && !isToolContinuation && state.sessionMemory) {
                    state.sessionMemory.extractFromUserMessage(userMsg, conversationId).catch(() => {});
                }

                if (!state.currentConfig.apiKey) { sendAugmentError(res, `No API key for ${state.currentConfig.provider}`); return; }

                // 转发到目标 provider
                if (isAnthropicFormat(state.currentConfig.provider)) await forwardToAnthropicStream(augmentReq, res);
                else if (isGoogleFormat(state.currentConfig.provider)) await forwardToGoogleStream(augmentReq, res);
                else await forwardToOpenAIStream(augmentReq, res);
            } finally {
                resolveReq!();
                if (state.conversationQueues.get(conversationId) === curPromise) state.conversationQueues.delete(conversationId);
                log(`[QUEUE] Request completed for conversation ${conversationId.substring(0, 8)}`);
            }
        } catch (error: any) {
            log(`[ERROR] ${error.message || error}`); log(`[ERROR] Stack: ${error.stack}`);
            if (!res.headersSent) sendAugmentError(res, error.message || 'Unknown error');
            else { try { res.write(JSON.stringify({ text: `\n\n[Error: ${error.message}]`, nodes: [], stop_reason: 1 }) + '\n'); res.end(); } catch (e) { log(`[ERROR] Failed to send error response: ${e}`); } }
        }
    });
}

// ========== 代理服务器生命周期 ==========
export async function startProxy(extensionContext: vscode.ExtensionContext) {
    if (state.proxyServer) { vscode.window.showWarningMessage('代理服务器已在运行'); return; }
    const config = vscode.workspace.getConfiguration('augmentProxy');
    state.currentConfig.provider = config.get('provider', 'anthropic');
    state.currentConfig.port = config.get('port', 8765);
    state.currentConfig.baseUrl = config.get(`${state.currentConfig.provider}.baseUrl`, DEFAULT_BASE_URLS[state.currentConfig.provider]);
    state.currentConfig.model = config.get(`${state.currentConfig.provider}.model`, DEFAULT_MODELS[state.currentConfig.provider]);
    state.currentConfig.wireApi = state.currentConfig.provider === 'custom'
        ? config.get('custom.wireApi', 'chat.completions')
        : 'chat.completions';
    if (state.currentConfig.provider === 'minimax') { state.currentConfig.enableCache = config.get('minimax.enableCache', true); state.currentConfig.enableInterleavedThinking = config.get('minimax.enableInterleavedThinking', true); }
    if (state.currentConfig.provider === 'deepseek') { state.currentConfig.enableThinking = config.get('deepseek.enableThinking', true); }
    // OMC 配置初始化
    state.currentConfig.omcEnabled = config.get('omc.enabled', false);
    state.currentConfig.omcMode = config.get('omc.mode', 'team') as string;
    state.currentConfig.omcContinuationEnforcement = config.get('omc.continuationEnforcement', true);
    state.currentConfig.omcMagicKeywords = config.get('omc.magicKeywords', true);
    const storedKey = await extensionContext.secrets.get(`apiKey.${state.currentConfig.provider}`);
    if (storedKey) { state.currentConfig.apiKey = storedKey; }
    else {
        const apiKey = await vscode.window.showInputBox({ prompt: `请输入 ${PROVIDER_NAMES[state.currentConfig.provider]} API Key`, password: true, placeHolder: 'sk-...' });
        if (!apiKey) { vscode.window.showErrorMessage('未提供 API Key'); return; }
        state.currentConfig.apiKey = apiKey;
        await extensionContext.secrets.store(`apiKey.${state.currentConfig.provider}`, apiKey);
    }
    try {
        state.proxyServer = http.createServer(handleProxyRequest);
        state.proxyServer.listen(state.currentConfig.port, async () => {
            log(`=== 代理服务器启动 ===`);
            log(`Provider: ${PROVIDER_NAMES[state.currentConfig.provider]}`);
            log(`端口: ${state.currentConfig.port}`);
            log(`Base URL: ${state.currentConfig.baseUrl}`);
            log(`Model: ${state.currentConfig.model}`);

            // 初始化 Viking Context Store
            try {
                const cacheDir = path.join(extensionContext.globalStorageUri.fsPath, 'viking-cache');
                if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
                state.vikingStore = new VikingContextStore(cacheDir);
                await state.vikingStore.init();
                log(`[VIKING] ✅ Viking Context Store 已初始化`);

                // 扫描工作区文件并生成分层上下文
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const rootPath = workspaceFolders[0].uri.fsPath;
                    log(`[VIKING] 🔍 扫描工作区: ${rootPath}`);

                    // 初始化 RAG 引擎（需要 workspaceRoot）
                    try {
                        const ragCacheDir = path.join(extensionContext.globalStorageUri.fsPath, 'rag-cache');
                        state.ragIndex = new RAGContextIndex({
                            workspaceRoot: rootPath,
                            cacheDir: ragCacheDir
                        });
                        await state.ragIndex.initStorage();
                        log(`[RAG] ✅ RAG 检索引擎已初始化`);
                    } catch (e: any) {
                        log(`[RAG] ⚠️ 初始化失败: ${e.message}`);
                    }

                    await scanAndIndexWorkspace(rootPath);
                }
            } catch (e: any) {
                log(`[VIKING] ⚠️ 初始化失败: ${e.message}`);
            }

            // 初始化 Session Memory
            try {
                const memoryDir = path.join(extensionContext.globalStorageUri.fsPath, 'session-memory');
                if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
                state.sessionMemory = new SessionMemory(memoryDir);
                await state.sessionMemory.init();
                log(`[MEMORY] ✅ Session Memory 已初始化`);
            } catch (e: any) {
                log(`[MEMORY] ⚠️ 初始化失败: ${e.message}`);
            }
            if (state.currentConfig.provider === 'minimax') { log(`Prompt 缓存: ${state.currentConfig.enableCache ? '启用' : '禁用'}`); log(`Interleaved Thinking: ${state.currentConfig.enableInterleavedThinking ? '启用' : '禁用'}`); }
            if (state.currentConfig.provider === 'deepseek') { log(`思考模式: ${state.currentConfig.enableThinking ? '启用' : '禁用'}`); log(`上下文缓存: 自动启用 (前缀匹配)`); }
            // 零注入登录绕过：自动配置 Augment 扩展使用代理
            // 原理：设置 apiToken + completionURL 后 useOAuth 返回 false
            // QIe.requestAuthToken 直接返回 { token, tenantId, tenantUrl, expiresAt }
            // NJe() 从 hostname 提取 tenant ID（proxy 模式下无关紧要）
            // 用 127.0.0.1 而非 proxy.localhost — Windows 不支持 *.localhost 子域名 DNS 解析（ENOTFOUND）
            // 扩展的 config change listener 检测到变化后自动 reload
            // 零注入登录绕过：写入 augment.advanced 对象（VSCode 不支持点号路径写入嵌套 object 属性）
            try {
                const proxyUrl = `http://127.0.0.1:${state.currentConfig.port}`;
                const augmentConfig = vscode.workspace.getConfiguration('augment');
                const currentAdvanced = augmentConfig.get<any>('advanced', {}) || {};
                const currentToken = currentAdvanced.apiToken || '';
                const currentUrl = currentAdvanced.completionURL || '';
                const alreadyConfigured = currentToken === 'PROXY-TOKEN' && currentUrl === proxyUrl;
                if (alreadyConfigured) {
                    // 配置已经正确，完全跳过 update（避免触发 Augment 扩展的 config change listener 导致多余重载）
                    log(`[AUTO-CONFIG] ✅ 配置已就绪，无需写入或重载`);
                } else {
                    // 首次配置或配置变更：写入并重载
                    const newAdvanced = { ...currentAdvanced, apiToken: 'PROXY-TOKEN', completionURL: proxyUrl };
                    await augmentConfig.update('advanced', newAdvanced, vscode.ConfigurationTarget.Global);
                    log(`[AUTO-CONFIG] ✅ Augment 扩展已自动配置`);
                    log(`[AUTO-CONFIG] completionURL = ${proxyUrl}`);
                    log(`[AUTO-CONFIG] 首次配置，需要重载窗口让 Augment 扩展进入 API Token 模式`);
                    extensionContext.globalState.update('proxyAutoStart', true);
                    setTimeout(() => {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }, 500);
                }
            } catch (e: any) {
                log(`[AUTO-CONFIG] ⚠️ 自动配置失败: ${e.message}`);
            }
        });
        state.proxyServer.on('error', (err: any) => { log(`[ERROR] ${err.message}`); vscode.window.showErrorMessage(`代理服务器错误: ${err.message}`); });
        updateStatusBar(true);
        vscode.window.showInformationMessage(`代理服务器已启动 - ${PROVIDER_NAMES[state.currentConfig.provider]} (端口: ${state.currentConfig.port})`);
    } catch (error: any) { vscode.window.showErrorMessage(`启动代理失败: ${error.message}`); }
}
// ========== 配置热更新 ==========
export async function refreshConfig() {
    if (!state.proxyServer) return; // 代理未运行时无需刷新
    const config = vscode.workspace.getConfiguration('augmentProxy');
    const newProvider = config.get('provider', 'anthropic') as string;
    const oldProvider = state.currentConfig.provider;
    state.currentConfig.provider = newProvider;
    state.currentConfig.port = config.get('port', 8765);
    state.currentConfig.baseUrl = config.get(`${newProvider}.baseUrl`, DEFAULT_BASE_URLS[newProvider]);
    state.currentConfig.model = config.get(`${newProvider}.model`, DEFAULT_MODELS[newProvider]);
    state.currentConfig.wireApi = newProvider === 'custom'
        ? config.get('custom.wireApi', 'chat.completions')
        : 'chat.completions';
    if (newProvider === 'minimax') {
        state.currentConfig.enableCache = config.get('minimax.enableCache', true);
        state.currentConfig.enableInterleavedThinking = config.get('minimax.enableInterleavedThinking', true);
    }
    if (newProvider === 'deepseek') {
        state.currentConfig.enableThinking = config.get('deepseek.enableThinking', true);
    }
    // OMC 配置
    state.currentConfig.omcEnabled = config.get('omc.enabled', false);
    state.currentConfig.omcMode = config.get('omc.mode', 'team') as string;
    state.currentConfig.omcContinuationEnforcement = config.get('omc.continuationEnforcement', true);
    state.currentConfig.omcMagicKeywords = config.get('omc.magicKeywords', true);
    // Provider 切换时重新读取 API Key
    if (newProvider !== oldProvider && state.extensionContext) {
        const storedKey = await state.extensionContext.secrets.get(`apiKey.${newProvider}`);
        if (storedKey) {
            state.currentConfig.apiKey = storedKey;
        } else {
            log(`[CONFIG] ⚠️ 切换到 ${PROVIDER_NAMES[newProvider]} 但未找到已保存的 API Key`);
        }
    }
    log(`[CONFIG] 🔄 配置已热更新: ${PROVIDER_NAMES[newProvider]} / ${state.currentConfig.model}`);
    updateStatusBar(true);
    if (state.sidebarProvider) state.sidebarProvider.sendFullStatusDebounced();
}

export async function stopProxy() {
    if (!state.proxyServer) { vscode.window.showWarningMessage('代理服务器未运行'); return; }
    state.proxyServer.close(); state.proxyServer = null;
    // 清除 autoStart flag
    state.extensionContext?.globalState.update('proxyAutoStart', false);
    // 清除 Augment 扩展的自动配置 — 扩展将 reload 回 OAuth 模式
    try {
        const augmentConfig = vscode.workspace.getConfiguration('augment');
        const currentAdvanced = augmentConfig.get<any>('advanced', {}) || {};
        const cleanAdvanced = { ...currentAdvanced, apiToken: '', completionURL: '' };
        await augmentConfig.update('advanced', cleanAdvanced, vscode.ConfigurationTarget.Global);
        log(`[AUTO-CONFIG] ✅ 已清除 Augment 扩展代理配置`);
    } catch (e: any) { log(`[AUTO-CONFIG] ⚠️ 清除配置失败: ${e.message}`); }
    updateStatusBar(false);
    log('代理服务器已停止'); vscode.window.showInformationMessage('代理服务器已停止');
}
export async function configureProvider() {
    const config = vscode.workspace.getConfiguration('augmentProxy');
    const cur = config.get('provider', 'anthropic');
    const selected = await vscode.window.showQuickPick(PROVIDERS.map((p: string) => ({ label: PROVIDER_NAMES[p], value: p, picked: p === cur })), { placeHolder: '选择 API 供应商' });
    if (selected) { await config.update('provider', (selected as any).value, vscode.ConfigurationTarget.Global); vscode.window.showInformationMessage(`已切换到 ${selected.label}`); }
}
export function showStatus() {
    const config = vscode.workspace.getConfiguration('augmentProxy');
    const provider = config.get('provider', 'anthropic') as string;
    const port = config.get('port', 8765);
    const baseUrl = config.get(`${provider}.baseUrl`, '');
    const model = config.get(`${provider}.model`, '');
    const augmentConfig = vscode.workspace.getConfiguration('augment');
    const autoApiToken = augmentConfig.get('advanced.apiToken', '') as string;
    const autoCompletionURL = augmentConfig.get('advanced.completionURL', '') as string;
    const autoConfigured = !!autoApiToken && !!autoCompletionURL;
    log(`\nAugment Proxy 状态\n==================\n运行状态: ${state.proxyServer ? '运行中' : '已停止'}\n自动配置: ${autoConfigured ? '✅ 已配置 (零注入模式)' : '❌ 未配置'}\nProvider: ${PROVIDER_NAMES[provider]}\n端口: ${port}\nBase URL: ${baseUrl}\nModel: ${model}\naugment.advanced.completionURL: ${autoCompletionURL || '(未设置)'}\naugment.advanced.apiToken: ${autoApiToken ? '***' : '(未设置)'}`);
}
export function updateStatusBar(proxyRunning: boolean) {
    if (!state.statusBarItem) return;
    state.statusBarItem.text = proxyRunning ? '$(radio-tower) Proxy' : '$(circle-slash) Proxy';
    state.statusBarItem.tooltip = proxyRunning
        ? `代理: 运行中 | 端口: ${state.currentConfig.port} | 零注入模式`
        : '代理: 已停止';
    state.statusBarItem.backgroundColor = proxyRunning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (state.sidebarProvider) state.sidebarProvider.updateStatus(proxyRunning);
}
