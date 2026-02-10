// ===== HTTP 代理服务器和路由处理 =====
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { state, log } from './globals';
import { CodebaseRetrievalRequest, CodeSnippet } from './types';
import { PROVIDERS, PROVIDER_NAMES, DEFAULT_BASE_URLS, DEFAULT_MODELS, isAnthropicFormat, isGoogleFormat } from './config';
import { extractWorkspaceInfo, buildSystemPrompt, sendAugmentError } from './messages';
import { forwardToAnthropicStream } from './providers/anthropic';
import { forwardToOpenAIStream } from './providers/openai';
import { forwardToGoogleStream } from './providers/google';
const { RAGContextIndex } = require('./rag');
const { SemanticEmbeddings } = require('./rag/embeddings');

// ========== 会话级请求队列 ==========
const conversationQueues = new Map<string, Promise<void>>();

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
    else if (urlPath === '/notifications/read') handleNotificationsRead(req, res);
    else if (urlPath === '/record-request-events') handleRecordRequestEvents(req, res);
    else if (urlPath === '/report-feature-vector') handleReportFeatureVector(req, res);
    else if (urlPath === '/remote-agents/list-stream') handleRemoteAgentsListStream(req, res);
    else if (urlPath === '/agents/check-tool-safety') handleCheckToolSafety(req, res);
    else if (urlPath === '/settings/get-tenant-tool-permissions') handleTenantToolPermissions(req, res);
    else if (urlPath === '/search-external-sources') handleSearchExternalSources(req, res);
    else if (urlPath === '/get-implicit-external-sources') handleGetImplicitExternalSources(req, res);
    else if (urlPath === '/record-session-events' || urlPath === '/record-user-events'
        || urlPath === '/resolve-completions' || urlPath === '/resolve-edit'
        || urlPath === '/resolve-instruction' || urlPath === '/resolve-smart-paste'
        || urlPath === '/resolve-next-edit' || urlPath === '/completion-feedback'
        || urlPath === '/chat-feedback' || urlPath === '/next-edit-feedback'
        || urlPath === '/record-preference-sample' || urlPath === '/notifications/mark-as-read'
        || urlPath === '/save-chat' || urlPath === '/context-canvas/list'
        || urlPath === '/resolve-chat-input-completion') {
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
    const modelId = "proxy-model";
    log(`[GET-MODELS] Returning model: ${modelId} (actual: ${state.currentConfig.provider}/${state.currentConfig.model})`);
    // 完整的 get-models 响应 — 匹配 Augment 扩展 toGetModelsResult 解析器所需的所有字段
    res.end(JSON.stringify({
        default_model: modelId,
        models: [{
            name: modelId,
            internal_name: modelId,
            suggested_prefix_char_count: 10000,
            suggested_suffix_char_count: 3000,
            completion_timeout_ms: 30000
        }],
        feature_flags: {
            enableCompletions: true,
            enableChat: true,
            enableInstructions: true,
            enableSmartPaste: true,
            enableNextEdit: false,
            enableHindsight: false,
            enableSentry: false,
            enableCompletionFileEditEvents: false,
            maxUploadSizeBytes: 1048576,
            enableCommitIndexing: false,
            vscodeNextEditMinVersion: "99.99.99",
            vscodeBackgroundAgentsMinVersion: "0.0.0",
            agentChatModel: modelId,
            fraudSignEndpoints: false,
            notificationPollingIntervalMs: 0
        },
        user_tier: "pro",
        user: {
            id: "proxy-user",
            email: "proxy@augmentcode.com",
            tenant_id: "proxy",
            tenant_name: "Proxy"
        },
        bootstrap_settings: {}
    }));
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

// ========== RAG 初始化 ==========
export async function initializeRAGIndex(): Promise<void> {
    const roots = getWorkspaceRoots(); if (roots.length === 0) return;
    const workspaceRoot = roots[0];
    try {
        state.ragIndex = new RAGContextIndex({ workspaceRoot });
        log('[RAG] Initializing LevelDB storage...'); await state.ragIndex.initStorage();
        log(`[RAG] Indexing files in ${workspaceRoot}...`);
        const t0 = Date.now();
        await state.ragIndex.initialize((c: number, t: number) => { if (c % 500 === 0) log(`[RAG] Indexing progress: ${c}/${t}`); });
        const stats = state.ragIndex.getStats();
        log(`[RAG] Index ready: ${stats.documentCount} docs, checkpoint ${stats.checkpointId}, took ${((Date.now()-t0)/1000).toFixed(2)}s`);
        const cfg = vscode.workspace.getConfiguration('augmentProxy');
        if (cfg.get('embedding.enabled', true) as boolean) {
            try {
                state.semanticEngine = new SemanticEmbeddings(path.join(workspaceRoot, '.augment-rag'), (m: string) => log(m), (s: any) => { if (state.sidebarProvider) state.sidebarProvider.updateEmbeddingStatus(s); });
                await state.semanticEngine.initialize(); state.ragIndex.setSemanticEngine(state.semanticEngine);
                log('[RAG] 🧠 Semantic search enabled'); log('[RAG] 🔄 Pre-generating embeddings...');
                await state.ragIndex.preloadEmbeddings((c: number, t: number) => { if (c % 50 === 0 || c === t) log(`[RAG] Embedding progress: ${c}/${t}`); });
            } catch (e: any) { log(`[RAG] ⚠️ Semantic engine failed: ${e.message}`); log('[RAG] Falling back to BM25 mode'); }
        } else { log('[RAG] BM25 mode (semantic search disabled)'); }
    } catch (err) { log(`[RAG] Failed to initialize: ${err}`); state.ragIndex = null; }
}
export async function closeRAGIndex(): Promise<void> {
    if (state.ragIndex) { try { await state.ragIndex.close(); log('[RAG] LevelDB storage closed'); } catch (e) { log(`[RAG] Error closing: ${e}`); } state.ragIndex = null; }
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
function handleRecordRequestEvents(req: any, res: any) {
    let body = ''; req.on('data', (c: any) => body += c); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); });
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
            // 会话级请求队列 — 防止同一会话并发请求导致工具在 checkingSafety 阶段被取消
            const pending = conversationQueues.get(conversationId);
            if (pending) { log(`[QUEUE] Waiting for pending request on conversation ${conversationId.substring(0, 8)}...`); try { await pending; } catch {} log(`[QUEUE] Previous request completed, proceeding...`); }
            let resolveReq: () => void;
            const curPromise = new Promise<void>(r => { resolveReq = r; });
            conversationQueues.set(conversationId, curPromise);
            try {
                // 调试日志
                log(`[DEBUG] Request keys: ${Object.keys(augmentReq).join(', ')}`);
                if (augmentReq.nodes?.length) {
                    augmentReq.nodes.forEach((n: any, i: number) => {
                        log(`[DEBUG] node[${i}]: type=${n.type}, keys=${Object.keys(n).join(',')}`);
                        if (n.type === 1 && n.tool_result_node) log(`[DEBUG] node[${i}] TOOL_RESULT: tool_use_id=${n.tool_result_node.tool_use_id}, content_len=${(n.tool_result_node.content || '').length}`);
                        if (n.type === 4 && n.ide_state_node) log(`[DEBUG] node[${i}] IDE_STATE: ${JSON.stringify(n.ide_state_node).substring(0, 500)}`);
                    });
                }
                const workspaceInfo = extractWorkspaceInfo(augmentReq);
                log(`[WORKSPACE] extracted: workspace=${workspaceInfo.workspacePath || 'N/A'}, repositoryRoot=${workspaceInfo.repositoryRoot || 'N/A'}, cwd=${workspaceInfo.cwd || 'N/A'}, currentFile=${workspaceInfo.currentFile || 'N/A'}`);
                if (augmentReq.chat_history?.length) {
                    augmentReq.chat_history.forEach((ex: any, i: number) => {
                        const rn = ex.response_nodes || []; const qn = ex.request_nodes || [];
                        log(`[DEBUG] chat_history[${i}]: response_nodes=${rn.length}, request_nodes=${qn.length}, has_request_message=${!!ex.request_message}`);
                        if (ex.request_message) log(`[DEBUG] chat_history[${i}].request_message: "${(ex.request_message || '').slice(0, 100)}..."`);
                        rn.forEach((n: any, j: number) => { if (n.type === 5) { const tu = n.tool_use || n.tool_use_node || {}; log(`[DEBUG] chat_history[${i}].response_nodes[${j}]: TOOL_USE, tool_use=${JSON.stringify(tu).slice(0, 300)}`); } });
                        qn.forEach((n: any, j: number) => { if (n.type === 1) log(`[DEBUG] chat_history[${i}].request_nodes[${j}]: TOOL_RESULT, tool_result=${JSON.stringify(n.tool_result_node || {}).slice(0, 200)}`); });
                    });
                }
                if (augmentReq.blobs) log(`[DEBUG] blobs: ${Array.isArray(augmentReq.blobs) ? `array[${augmentReq.blobs.length}]` : Object.keys(augmentReq.blobs).slice(0, 5).join(',')}`);
                if (augmentReq.user_guided_blobs) log(`[DEBUG] user_guided_blobs: ${Array.isArray(augmentReq.user_guided_blobs) ? `array[${augmentReq.user_guided_blobs.length}]` : Object.keys(augmentReq.user_guided_blobs).slice(0, 5).join(',')}`);
                if (augmentReq.path) log(`[DEBUG] path: ${augmentReq.path}`);
                if (augmentReq.prefix) log(`[DEBUG] prefix length: ${augmentReq.prefix.length}`);
                if (augmentReq.suffix) log(`[DEBUG] suffix length: ${augmentReq.suffix.length}`);
                if (augmentReq.tool_definitions) log(`[DEBUG] tool_definitions: ${JSON.stringify(augmentReq.tool_definitions).substring(0, 500)}`);
                else log(`[DEBUG] tool_definitions: undefined or null`);
                if (!state.currentConfig.apiKey) { sendAugmentError(res, `No API key for ${state.currentConfig.provider}`); return; }
                // 转发到目标 provider
                if (isAnthropicFormat(state.currentConfig.provider)) await forwardToAnthropicStream(augmentReq, res);
                else if (isGoogleFormat(state.currentConfig.provider)) await forwardToGoogleStream(augmentReq, res);
                else await forwardToOpenAIStream(augmentReq, res);
            } finally {
                resolveReq!();
                if (conversationQueues.get(conversationId) === curPromise) conversationQueues.delete(conversationId);
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
    if (state.currentConfig.provider === 'minimax') { state.currentConfig.enableCache = config.get('minimax.enableCache', true); state.currentConfig.enableInterleavedThinking = config.get('minimax.enableInterleavedThinking', true); }
    if (state.currentConfig.provider === 'deepseek') { state.currentConfig.enableThinking = config.get('deepseek.enableThinking', true); }
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
            if (state.currentConfig.provider === 'minimax') { log(`Prompt 缓存: ${state.currentConfig.enableCache ? '启用' : '禁用'}`); log(`Interleaved Thinking: ${state.currentConfig.enableInterleavedThinking ? '启用' : '禁用'}`); }
            if (state.currentConfig.provider === 'deepseek') { log(`思考模式: ${state.currentConfig.enableThinking ? '启用' : '禁用'}`); log(`上下文缓存: 自动启用 (前缀匹配)`); }
            // 零注入登录绕过：自动配置 Augment 扩展使用代理
            // 原理：设置 apiToken + completionURL 后 useOAuth 返回 false
            // QIe.requestAuthToken 直接返回 { token, tenantId, tenantUrl, expiresAt }
            // NJe() 从 proxy.localhost 提取 "proxy" 作为 tenant ID
            // 扩展的 config change listener 检测到变化后自动 reload
            try {
                const proxyUrl = `http://proxy.localhost:${state.currentConfig.port}`;
                const augmentConfig = vscode.workspace.getConfiguration('augment');
                await augmentConfig.update('advanced.apiToken', 'PROXY-TOKEN', vscode.ConfigurationTarget.Global);
                await augmentConfig.update('advanced.completionURL', proxyUrl, vscode.ConfigurationTarget.Global);
                log(`[AUTO-CONFIG] ✅ Augment 扩展已自动配置`);
                log(`[AUTO-CONFIG] apiToken = PROXY-TOKEN (扩展内部会 toUpperCase)`);
                log(`[AUTO-CONFIG] completionURL = ${proxyUrl}`);
                log(`[AUTO-CONFIG] 扩展将自动 reload 进入 API Token 模式，无需登录`);
            } catch (e: any) {
                log(`[AUTO-CONFIG] ⚠️ 自动配置失败: ${e.message}`);
                log(`[AUTO-CONFIG] 请手动设置: augment.advanced.apiToken = 任意非空字符串`);
                log(`[AUTO-CONFIG] 请手动设置: augment.advanced.completionURL = http://proxy.localhost:${state.currentConfig.port}`);
            }
        });
        state.proxyServer.on('error', (err: any) => { log(`[ERROR] ${err.message}`); vscode.window.showErrorMessage(`代理服务器错误: ${err.message}`); });
        updateStatusBar(true);
        vscode.window.showInformationMessage(`代理服务器已启动 - ${PROVIDER_NAMES[state.currentConfig.provider]} (端口: ${state.currentConfig.port})`);
    } catch (error: any) { vscode.window.showErrorMessage(`启动代理失败: ${error.message}`); }
}
export async function stopProxy() {
    if (!state.proxyServer) { vscode.window.showWarningMessage('代理服务器未运行'); return; }
    state.proxyServer.close(); state.proxyServer = null;
    // 清除 Augment 扩展的自动配置 — 扩展将 reload 回 OAuth 模式
    try {
        const augmentConfig = vscode.workspace.getConfiguration('augment');
        await augmentConfig.update('advanced.apiToken', undefined, vscode.ConfigurationTarget.Global);
        await augmentConfig.update('advanced.completionURL', undefined, vscode.ConfigurationTarget.Global);
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
    if (state.sidebarProvider) state.sidebarProvider.updateStatus(proxyRunning, proxyRunning);
}
