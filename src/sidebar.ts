// ===== 侧边栏 Provider =====
import * as vscode from 'vscode';
import { state, log } from './globals';
import { PROVIDERS, PROVIDER_NAMES, DEFAULT_BASE_URLS, DEFAULT_MODELS } from './config';
import { startProxy, stopProxy } from './proxy';


export class AugmentProxySidebarProvider implements vscode.WebviewViewProvider {
    _extensionUri: vscode.Uri;
    _view?: vscode.WebviewView;
    _proxyRunning = false;
    _embeddingStatus: any = null;
    _lastContextStatus: any = null;
    private _sendFullStatusTimer: any = null;

    constructor(extensionUri: vscode.Uri) { this._extensionUri = extensionUri; }

    /** Debounced sendFullStatus — 多次快速调用合并为一次，避免 config change 事件 race condition */
    sendFullStatusDebounced() {
        if (this._sendFullStatusTimer) clearTimeout(this._sendFullStatusTimer);
        this._sendFullStatusTimer = setTimeout(() => { this._sendFullStatusTimer = null; this.sendFullStatus(); }, 80);
    }

    updateStatus(proxyRunning: boolean) {
        this._proxyRunning = proxyRunning;
        if (this._view) this._view.webview.postMessage({ type: 'status', proxyRunning });
    }
    updateEmbeddingStatus(status: any) {
        this._embeddingStatus = status;
        if (this._view) this._view.webview.postMessage({ type: 'embeddingStatus', ...status });
    }
    updateContextStatus(contextStats: any) {
        this._lastContextStatus = contextStats;
        if (this._view) this._view.webview.postMessage({ type: 'contextStatus', ...contextStats });
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();
        webviewView.webview.onDidReceiveMessage(async (msg: any) => {
            switch (msg.command) {
                case 'startProxy': await startProxy(state.extensionContext!); break;
                case 'stopProxy': await stopProxy(); break;

                case 'refresh': this.sendFullStatus(); break;
                case 'saveConfig': await this.saveConfig(msg.config); break;
                case 'setApiKey':
                    await state.extensionContext!.secrets.store(`apiKey.${msg.provider}`, msg.apiKey);
                    vscode.window.showInformationMessage(`${PROVIDER_NAMES[msg.provider]} API Key 已保存`);
                    break;
                case 'getConfig': this.sendFullStatus(); break;
                case 'setCompressionThreshold':
                    await vscode.workspace.getConfiguration('augmentProxy').update('compressionThreshold', msg.threshold, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`压缩阈值已设置为 ${msg.threshold}%`);
                    break;
                case 'fetchModels': await this.fetchModels(msg.provider); break;
                case 'saveOmc': await this.saveOMCConfig(msg.omc); break;
                case 'saveEmbedding': await this.saveEmbeddingConfig(msg.embedding); break;
                case 'switchLocalModel':
                    try {
                        const augCfg = vscode.workspace.getConfiguration('augmentProxy');
                        await augCfg.update('embedding.localModel', msg.modelId, vscode.ConfigurationTarget.Global);
                        if (msg.mirror !== undefined) {
                            await augCfg.update('embedding.mirror', msg.mirror, vscode.ConfigurationTarget.Global);
                        }
                        if (state.semanticEngine) {
                            if (msg.mirror) state.semanticEngine.setMirror(msg.mirror);
                            await state.semanticEngine.switchLocalModel(msg.modelId);
                            vscode.window.showInformationMessage(`本地模型已切换: ${msg.modelId.replace('Xenova/', '')}`);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`模型切换失败: ${err.message}`);
                    }
                    break;
                case 'cancelDownload':
                    if (state.semanticEngine) {
                        state.semanticEngine.cancelDownload();
                        log('[RAG] ⏹️ 下载取消请求已发送');
                    }
                    break;
            }
        });
        this.sendFullStatus();
    }

    async saveConfig(config: any) {
        const vscodeConfig = vscode.workspace.getConfiguration('augmentProxy');
        if (config.provider) await vscodeConfig.update('provider', config.provider, vscode.ConfigurationTarget.Global);
        if (config.port) await vscodeConfig.update('port', parseInt(config.port), vscode.ConfigurationTarget.Global);
        if (config.provider && config.baseUrl !== undefined) await vscodeConfig.update(`${config.provider}.baseUrl`, config.baseUrl, vscode.ConfigurationTarget.Global);
        if (config.provider && config.model !== undefined) await vscodeConfig.update(`${config.provider}.model`, config.model, vscode.ConfigurationTarget.Global);
        if (config.provider === 'custom' && config.format) await vscodeConfig.update('custom.format', config.format, vscode.ConfigurationTarget.Global);
        if (config.provider === 'custom' && config.wireApi) await vscodeConfig.update('custom.wireApi', config.wireApi, vscode.ConfigurationTarget.Global);
        // 保存 thinking 设置
        if (config.provider && config.enableThinking !== undefined) {
            await vscodeConfig.update(`${config.provider}.enableThinking`, config.enableThinking, vscode.ConfigurationTarget.Global);
        }
        vscode.window.showInformationMessage('配置已保存');
        this.sendFullStatus();
    }

    async saveOMCConfig(omc: any) {
        const vscodeConfig = vscode.workspace.getConfiguration('augmentProxy');
        await vscodeConfig.update('omc.enabled', omc.enabled, vscode.ConfigurationTarget.Global);
        await vscodeConfig.update('omc.mode', omc.mode, vscode.ConfigurationTarget.Global);
        await vscodeConfig.update('omc.continuationEnforcement', omc.continuationEnforcement, vscode.ConfigurationTarget.Global);
        await vscodeConfig.update('omc.magicKeywords', omc.magicKeywords, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`OMC 配置已保存 (${omc.enabled ? '启用' : '禁用'}, 模式: ${omc.mode})`);
        this.sendFullStatusDebounced();
    }

    async saveEmbeddingConfig(emb: any) {
        const vscodeConfig = vscode.workspace.getConfiguration('augmentProxy');
        await vscodeConfig.update('embedding.enabled', emb.enabled, vscode.ConfigurationTarget.Global);
        await vscodeConfig.update('embedding.provider', emb.provider, vscode.ConfigurationTarget.Global);
        await vscodeConfig.update('embedding.apiKey', emb.apiKey, vscode.ConfigurationTarget.Global);
        await vscodeConfig.update('embedding.baseUrl', emb.baseUrl, vscode.ConfigurationTarget.Global);
        await vscodeConfig.update('embedding.model', emb.model, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Embedding 配置已保存 (${emb.enabled ? '启用' : '禁用'}, ${emb.provider})`);
        this.sendFullStatusDebounced();
    }

    async sendFullStatus() {
        if (!this._view) return;
        const config = vscode.workspace.getConfiguration('augmentProxy');
        const provider = config.get('provider', 'anthropic') as string;
        const configData: any = { provider, port: config.get('port', 8765), providers: {}, compressionThreshold: 80 };
        for (const p of PROVIDERS) {
            configData.providers[p] = {
                name: PROVIDER_NAMES[p],
                baseUrl: config.get(`${p}.baseUrl`, DEFAULT_BASE_URLS[p]),
                model: config.get(`${p}.model`, DEFAULT_MODELS[p]),
                hasApiKey: !!(await state.extensionContext!.secrets.get(`apiKey.${p}`)),
                enableThinking: config.get(`${p}.enableThinking`, false)
            };
        }
        configData.providers['custom'].format = config.get('custom.format', 'anthropic');
        configData.providers['custom'].wireApi = config.get('custom.wireApi', 'chat.completions');
        configData.compressionThreshold = config.get('compressionThreshold', 80);
        // Embedding 配置
        configData.embedding = {
            enabled: config.get('embedding.enabled', false),
            provider: config.get('embedding.provider', 'glm'),
            apiKey: config.get('embedding.apiKey', ''),
            baseUrl: config.get('embedding.baseUrl', ''),
            model: config.get('embedding.model', ''),
            localModel: config.get('embedding.localModel', 'Xenova/all-MiniLM-L6-v2'),
            mirror: config.get('embedding.mirror', '')
        };
        // OMC 配置
        configData.omc = {
            enabled: config.get('omc.enabled', false),
            mode: config.get('omc.mode', 'team'),
            continuationEnforcement: config.get('omc.continuationEnforcement', true),
            magicKeywords: config.get('omc.magicKeywords', true)
        };
        this._view.webview.postMessage({
            type: 'fullStatus', proxyRunning: !!state.proxyServer,
            config: configData,
            embeddingStatus: this._embeddingStatus || { mode: 'local', modelLoading: false, modelReady: false, downloadProgress: 0, cacheCount: 0 },
            contextStatus: this._lastContextStatus
        });
    }

    async fetchModels(provider: string) {
        if (!this._view) return;
        try {
            const apiKey = await state.extensionContext!.secrets.get(`apiKey.${provider}`);
            if (!apiKey) { this._view.webview.postMessage({ type: 'modelsList', provider, models: [], error: '请先配置 API Key' }); return; }
            let models: any[] = [];
            switch (provider) {
                case 'google': models = await this.fetchGoogleModels(apiKey); break;
                case 'openai': models = await this.fetchOpenAIModels(apiKey); break;
                case 'anthropic': models = this.getAnthropicModels(); break;
                case 'minimax': models = this.getMinimaxModels(); break;
                case 'deepseek': models = this.getDeepseekModels(); break;
                case 'glm': models = await this.fetchGLMModels(apiKey); break;
                case 'kimi': models = this.getKimiModels(); break;
                case 'kimi-anthropic': models = this.getKimiModels(); break;
                default: models = [];
            }
            this._view.webview.postMessage({ type: 'modelsList', provider, models });
        } catch (error: any) { this._view.webview.postMessage({ type: 'modelsList', provider, models: [], error: error.message }); }
    }

    async fetchGoogleModels(apiKey: string) {
        try {
            const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey;
            log('[FETCH MODELS] Fetching Google models...');
            const response = await fetch(url);
            if (!response.ok) { const t = await response.text(); log(`[FETCH MODELS] Google API error: ${response.status} ${t}`); throw new Error(`API 返回错误: ${response.status}`); }
            const data: any = await response.json();
            if (data.models && Array.isArray(data.models)) {
                const models = data.models
                    .filter((m: any) => {
                        const name = m.name || ''; const methods = m.supportedGenerationMethods || [];
                        return methods.includes('generateContent') && name.includes('models/gemini-') && !name.includes('gemma') && !name.includes('embedding')
                            && !name.includes('tts') && !name.includes('image') && !name.includes('audio') && !name.includes('robotics') && !name.includes('computer-use') && !name.includes('deep-research');
                    })
                    .map((m: any) => ({ id: m.name.replace('models/', ''), name: m.displayName || m.name.replace('models/', ''), description: m.description || '' }))
                    .sort((a: any, b: any) => {
                        const s = (id: string) => { let sc = 0; if (id.includes('gemini-3')) sc += 3000; else if (id.includes('gemini-2.5')) sc += 2500; else if (id.includes('gemini-2')) sc += 2000; else if (id.includes('gemini-1')) sc += 1000; if (id.includes('pro')) sc += 300; else if (id.includes('flash') && !id.includes('lite')) sc += 200; else if (id.includes('lite')) sc += 100; if (id.includes('latest')) sc += 50; if (id.includes('preview')) sc += 30; if (id.includes('exp')) sc += 20; return sc; };
                        return s(b.id) - s(a.id);
                    });
                log(`[FETCH MODELS] Found ${models.length} Google Gemini models`);
                return models;
            }
            log('[FETCH MODELS] No models found in response'); return [];
        } catch (error: any) {
            log(`[FETCH MODELS] Google error: ${error.message}`);
            return [ { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', description: 'Latest Gemini 3 Pro' }, { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', description: 'Latest Gemini 3 Flash' }, { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Stable Gemini 2.5 Pro' }, { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Stable Gemini 2.5 Flash' }, { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Gemini 2.0 Flash' }, { id: 'gemini-exp-1206', name: 'Gemini Experimental 1206', description: 'Experimental release' } ];
        }
    }


    async fetchOpenAIModels(apiKey: string) {
        try {
            const response = await fetch('https://api.openai.com/v1/models', { headers: { 'Authorization': `Bearer ${apiKey}` } });
            const data: any = await response.json();
            if (data.data) return data.data.filter((m: any) => m.id.includes('gpt')).map((m: any) => ({ id: m.id, name: m.id })).sort((a: any, b: any) => b.id.localeCompare(a.id));
            return [];
        } catch (error: any) { log(`[FETCH MODELS] OpenAI error: ${error.message}`); return []; }
    }
    async fetchGLMModels(apiKey: string) {
        try {
            const response = await fetch('https://open.bigmodel.cn/api/paas/v4/models', { headers: { 'Authorization': `Bearer ${apiKey}` } });
            const data: any = await response.json();
            if (data.data) return data.data.map((m: any) => ({ id: m.id, name: m.id }));
            return [];
        } catch (error: any) {
            log(`[FETCH MODELS] GLM error: ${error.message}`);
            return [ { id: 'glm-4.7', name: 'GLM-4.7' }, { id: 'glm-4-plus', name: 'GLM-4-Plus' }, { id: 'glm-4-air', name: 'GLM-4-Air' }, { id: 'glm-4-flash', name: 'GLM-4-Flash' } ];
        }
    }
    getAnthropicModels() {
        return [ { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (2025-05-14)' }, { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet (2024-10-22)' }, { id: 'claude-3-5-sonnet-20240620', name: 'Claude 3.5 Sonnet (2024-06-20)' }, { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' }, { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' }, { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' } ];
    }
    getMinimaxModels() {
        return [ { id: 'MiniMax-M2.2', name: 'MiniMax-M2.2' }, { id: 'MiniMax-Text-01', name: 'MiniMax-Text-01' } ];
    }
    getDeepseekModels() {
        return [ { id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (思考模式)' } ];
    }
    getKimiModels() {
        return [
            { id: 'kimi-k2.5', name: 'Kimi K2.5 (最新多模态，推荐)' },
            { id: 'kimi-k2-0905-preview', name: 'Kimi K2 0905 Preview' },
            { id: 'kimi-k2-0711-preview', name: 'Kimi K2 0711 Preview (编码强)' },
            { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo Preview' },
            { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo' },
            { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
            { id: 'moonshot-v1-8k', name: 'Moonshot V1 8K' },
            { id: 'moonshot-v1-32k', name: 'Moonshot V1 32K' },
            { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K' },
            { id: 'moonshot-v1-auto', name: 'Moonshot V1 Auto' },
            { id: 'moonshot-v1-8k-vision-preview', name: 'Moonshot V1 8K Vision' },
            { id: 'moonshot-v1-32k-vision-preview', name: 'Moonshot V1 32K Vision' },
            { id: 'moonshot-v1-128k-vision-preview', name: 'Moonshot V1 128K Vision' }
        ];
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
select, input { width: 100%; padding: 6px 8px; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
select:focus, input:focus { outline: 1px solid var(--vscode-focusBorder); }
button { width: 100%; padding: 8px; margin: 4px 0; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; font-size: 13px; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.small { padding: 4px 8px; font-size: 11px; }
button:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-row { display: flex; gap: 8px; }
.btn-row button { flex: 1; }
.api-key-row { display: flex; gap: 4px; }
.api-key-row input { flex: 1; }
.api-key-row button { width: auto; padding: 6px 12px; }
.key-status { font-size: 11px; margin-top: 2px; }
.key-status.saved { color: #4caf50; }
.key-status.missing { color: #ff9800; }
.info { font-size: 11px; opacity: 0.7; margin-top: 4px; }
.checkbox-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.checkbox-row input[type="checkbox"] { width: auto; margin: 0; }
.checkbox-row label { margin: 0; opacity: 1; cursor: pointer; }
</style>
</head>
<body>
    <div class="section">
        <div class="title">状态</div>
        <div class="status"><span class="dot" id="proxyDot"></span><span id="proxyStatus">代理: 检查中...</span></div>
    </div>
    <div class="section">
        <div class="title">Provider 配置</div>
        <div class="row"><label>选择 Provider</label>
            <select id="provider"><option value="minimax">MiniMax</option><option value="anthropic">Anthropic (Claude)</option><option value="deepseek">DeepSeek</option><option value="glm">GLM (智谱)</option><option value="openai">OpenAI</option><option value="google">Google Gemini</option><option value="kimi">Kimi (月之暗面)</option><option value="kimi-anthropic">Kimi Coding Plan (编码套餐)</option><option value="custom">自定义</option></select>
        </div>
        <div class="row"><label>API Key</label>
            <div class="api-key-row"><input type="password" id="apiKey" placeholder="sk-..."><button class="small" id="saveKeyBtn">保存</button></div>
            <div class="key-status" id="keyStatus"></div>
        </div>
        <div class="row"><label>Base URL</label><input type="text" id="baseUrl" placeholder="https://api.example.com/v1/..."></div>
        <div class="row"><label>Model</label>
            <div style="display: flex; gap: 4px; align-items: stretch;">
                <select id="modelSelect" style="flex: 1;"><option value="">-- 选择模型 --</option></select>
                <button class="small" id="refreshModelsBtn" title="刷新模型列表" style="width: 32px; padding: 6px 4px; flex-shrink: 0;">🔄</button>
            </div>
            <input type="text" id="model" placeholder="或手动输入模型名称" style="margin-top: 4px;">
            <div class="info" id="modelInfo"></div>
        </div>
        <div class="row" id="formatRow" style="display:none"><label>API 格式 (自定义)</label>
            <select id="format"><option value="anthropic">Anthropic 格式</option><option value="openai">OpenAI 格式</option></select>
        </div>
        <div class="row" id="wireApiRow" style="display:none"><label>OpenAI Wire API</label>
            <select id="wireApi"><option value="chat.completions">chat.completions</option><option value="responses">responses</option></select>
        </div>
        <div class="checkbox-row">
            <input type="checkbox" id="enableThinking">
            <label for="enableThinking">启用 Thinking (思考模式)</label>
        </div>
        <div class="info" style="margin-top: -4px; margin-left: 24px;">支持 MiniMax, DeepSeek, Kimi Coding 等模型的思考输出</div>
        <div class="row"><label>代理端口</label><input type="number" id="port" value="8765" min="1024" max="65535"></div>
        <button id="saveConfigBtn">保存配置</button>
    </div>
    <div class="section">
        <div class="title">代理控制</div>
        <div class="btn-row"><button id="startBtn">▶ 启动</button><button id="stopBtn" class="secondary">■ 停止</button></div>
    </div>
    <div class="section">
        <div class="title">🚀 OMC 编排增强</div>
        <div class="row" style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="omcEnabled" style="width: auto;">
            <label for="omcEnabled" style="display: inline; margin: 0; font-size: 13px; opacity: 1;">启用 oh-my-claudecode</label>
        </div>
        <div id="omcOptions" style="display:none;">
            <div class="row"><label>编排模式</label>
                <select id="omcMode">
                    <option value="team">Team (推荐) - 规范流水线</option>
                    <option value="autopilot">Autopilot - 自主执行</option>
                    <option value="ultrawork">Ultrawork - 极致性能</option>
                    <option value="ralph">Ralph - 持久验证</option>
                    <option value="ecomode">Ecomode - Token 高效</option>
                    <option value="pipeline">Pipeline - 顺序处理</option>
                </select>
            </div>
            <div class="row" style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="omcContinuation" checked style="width: auto;">
                <label for="omcContinuation" style="display: inline; margin: 0; font-size: 12px;">持续执行强化</label>
            </div>
            <div class="row" style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="omcMagicKw" checked style="width: auto;">
                <label for="omcMagicKw" style="display: inline; margin: 0; font-size: 12px;">魔法关键词</label>
            </div>
            <div class="info">关键词: ultrawork / search / analyze / ultrathink</div>
            <button id="saveOmcBtn" class="small" style="margin-top: 4px;">保存 OMC 配置</button>
        </div>
    </div>
    <div class="section">
        <div class="title">🧠 语义搜索</div>
        <div class="status"><span class="dot" id="embeddingDot"></span><span id="embeddingStatus">模型: 未加载</span></div>
        <div id="downloadProgress" style="display:none; margin: 8px 0;">
            <div style="background: var(--vscode-input-background); border-radius: 4px; height: 6px; overflow: hidden;"><div id="progressBar" style="height: 100%; background: #4caf50; width: 0%; transition: width 0.3s;"></div></div>
            <div id="progressText" style="font-size: 11px; opacity: 0.7; margin-top: 2px;">下载中: 0%</div>
            <button id="cancelDownloadBtn" class="small" style="margin-top: 4px; background: #f44336;">⏹️ 取消下载</button>
        </div>
        <div id="embeddingProgressRow" style="display:none; font-size: 11px; opacity: 0.8; margin: 4px 0;"><span>🔄 正在生成嵌入:</span><span id="embeddingProgressText" style="margin-left: 4px; color: #4caf50;">0/0</span></div>
        <div class="status" style="font-size: 11px; opacity: 0.8;"><span>缓存文档:</span><span id="cacheCount" style="margin-left: 4px;">0</span></div>
        <div style="font-size: 11px; opacity: 0.6; margin: 6px 0 2px;">📦 本地模型 <span style="color: #4caf50;">（默认，启动代理后自动加载）</span></div>
        <div class="row"><label>选择模型</label>
            <select id="localModelSelect">
                <option value="Xenova/all-MiniLM-L6-v2">MiniLM-L6 (22MB) — 最小最快</option>
                <option value="Xenova/all-MiniLM-L12-v2">MiniLM-L12 (33MB) — 12层更准</option>
                <option value="Xenova/bge-small-en-v1.5">BGE-Small (33MB) — 代码搜索好</option>
                <option value="Xenova/bge-base-en-v1.5">BGE-Base (109MB) — 性价比最高 ⭐</option>
                <option value="Xenova/bge-large-en-v1.5">BGE-Large (335MB) — 最高精度</option>
                <option value="Xenova/multilingual-e5-small">E5-Multi-Small (118MB) — 多语言</option>
                <option value="Xenova/multilingual-e5-base">E5-Multi-Base (278MB) — 中文最佳 ⭐</option>
            </select>
        </div>
        <div id="localModelInfo" style="font-size: 11px; opacity: 0.7; margin: 4px 0; padding: 4px 8px; background: var(--vscode-input-background); border-radius: 4px;"></div>
        <div class="row" style="margin-top: 4px;"><label>🪞 下载镜像</label>
            <select id="mirrorSelect">
                <option value="">HuggingFace 官方</option>
                <option value="https://hf-mirror.com/">hf-mirror.com (国内快)</option>
            </select>
        </div>
        <button id="switchModelBtn" class="small" style="margin-top: 4px;">⬇️ 下载并使用此模型</button>
        <div style="border-top: 1px solid var(--vscode-input-background); margin: 12px 0 8px; opacity: 0.5;"></div>
        <div style="font-size: 11px; opacity: 0.6; margin-bottom: 4px;">🌐 远程 Embedding API <span style="opacity: 0.5;">（可选，替代或增强本地模型）</span></div>
        <div class="row" style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="embEnabled" style="width: auto;">
            <label for="embEnabled" style="display: inline; margin: 0; font-size: 12px; opacity: 0.8;">启用远程 Embedding API</label>
        </div>
        <div id="embOptions" style="display:none;">
            <div class="row"><label>Embedding 供应商</label>
                <select id="embProvider">
                    <option value="glm">智谱 GLM embedding-3</option>
                    <option value="openai">OpenAI text-embedding-3-small</option>
                    <option value="custom">自定义 Embedding API</option>
                </select>
            </div>
            <div class="row"><label>Embedding API Key</label>
                <input type="password" id="embApiKey" placeholder="留空则使用 LLM 的 API Key">
            </div>
            <div id="embCustomRow" style="display:none;">
                <div class="row"><label>自定义 Base URL</label><input type="text" id="embBaseUrl" placeholder="https://api.example.com/v1/embeddings"></div>
                <div class="row"><label>自定义模型名称</label><input type="text" id="embModel" placeholder="留空使用默认"></div>
            </div>
            <button id="saveEmbBtn" class="small" style="margin-top: 4px;">保存 Embedding 配置</button>
        </div>
    </div>
    <div class="section">
        <div class="title">📊 上下文状态</div>
        <div class="status" style="font-size: 11px; opacity: 0.8;"><span>Token 使用:</span><span id="contextTokens" style="margin-left: 4px; color: #4caf50;">0 / 200K (0%)</span></div>
        <div class="status" style="font-size: 11px; opacity: 0.8;"><span>交互次数:</span><span id="contextExchanges" style="margin-left: 4px;">0</span></div>
        <div id="contextCompression" style="display:none; font-size: 11px; opacity: 0.8; margin: 4px 0; color: #ff9800;"><span>⚠️ 已压缩</span></div>
        <div class="row" style="margin-top: 8px;"><label>压缩阈值 (%)</label><input type="number" id="compressionThreshold" min="50" max="95" value="80" style="width: 100%;"><div class="info">超过此百分比时自动压缩上下文</div></div>
    </div>

    <button id="refreshBtn" class="secondary">🔄 刷新状态</button>

<script>
const vscode = acquireVsCodeApi();
let currentConfig = {};
let availableModels = [];
const $provider = document.getElementById('provider');
const $apiKey = document.getElementById('apiKey');
const $baseUrl = document.getElementById('baseUrl');
const $model = document.getElementById('model');
const $modelSelect = document.getElementById('modelSelect');
const $refreshModelsBtn = document.getElementById('refreshModelsBtn');
const $modelInfo = document.getElementById('modelInfo');
const $format = document.getElementById('format');
const $formatRow = document.getElementById('formatRow');
const $wireApi = document.getElementById('wireApi');
const $wireApiRow = document.getElementById('wireApiRow');
const $port = document.getElementById('port');
const $keyStatus = document.getElementById('keyStatus');
const $enableThinking = document.getElementById('enableThinking');

function updateCustomProviderUI() {
    const isCustom = $provider.value === 'custom';
    const isOpenAIFormat = isCustom && $format.value === 'openai';
    $formatRow.style.display = isCustom ? 'block' : 'none';
    $wireApiRow.style.display = isOpenAIFormat ? 'block' : 'none';
}

$provider.onchange = () => {
    const p = $provider.value;
    const pConfig = currentConfig.providers?.[p] || {};
    $baseUrl.value = pConfig.baseUrl || '';
    $model.value = pConfig.model || '';
    if (p === 'custom') {
        $format.value = pConfig.format || 'anthropic';
        $wireApi.value = pConfig.wireApi || 'chat.completions';
    }
    updateCustomProviderUI();
    $enableThinking.checked = pConfig.enableThinking || false;
    updateKeyStatus(pConfig.hasApiKey);
    $apiKey.value = '';
    $modelSelect.innerHTML = '<option value="">-- 选择模型 --</option>';
    availableModels = [];
    $modelInfo.textContent = '';
};
$format.onchange = () => updateCustomProviderUI();
$refreshModelsBtn.onclick = () => {
    const provider = $provider.value;
    $modelInfo.textContent = '正在获取模型列表...';
    $refreshModelsBtn.disabled = true;
    vscode.postMessage({command: 'fetchModels', provider});
};
$modelSelect.onchange = () => { if ($modelSelect.value) $model.value = $modelSelect.value; };
function updateKeyStatus(hasKey) {
    if (hasKey) { $keyStatus.textContent = '✓ 已保存'; $keyStatus.className = 'key-status saved'; }
    else { $keyStatus.textContent = '⚠ 未设置'; $keyStatus.className = 'key-status missing'; }
}
document.getElementById('startBtn').onclick = () => vscode.postMessage({command:'startProxy'});
document.getElementById('stopBtn').onclick = () => vscode.postMessage({command:'stopProxy'});
document.getElementById('refreshBtn').onclick = () => vscode.postMessage({command:'refresh'});
document.getElementById('saveKeyBtn').onclick = () => {
    const apiKey = $apiKey.value.trim(); if (!apiKey) return;
    vscode.postMessage({command:'setApiKey', provider: $provider.value, apiKey});
    $apiKey.value = ''; updateKeyStatus(true);
};
document.getElementById('saveConfigBtn').onclick = () => {
    vscode.postMessage({ command: 'saveConfig', config: {
        provider: $provider.value,
        baseUrl: $baseUrl.value,
        model: $model.value,
        port: $port.value,
        format: $format.value,
        wireApi: $wireApi.value,
        enableThinking: $enableThinking.checked
    } });
};
// OMC 控制
const $omcEnabled = document.getElementById('omcEnabled');
const $omcOptions = document.getElementById('omcOptions');
const $omcMode = document.getElementById('omcMode');
const $omcContinuation = document.getElementById('omcContinuation');
const $omcMagicKw = document.getElementById('omcMagicKw');
$omcEnabled.onchange = () => {
    $omcOptions.style.display = $omcEnabled.checked ? 'block' : 'none';
    // 自动保存 enabled 状态
    vscode.postMessage({ command: 'saveOmc', omc: {
        enabled: $omcEnabled.checked,
        mode: $omcMode.value,
        continuationEnforcement: $omcContinuation.checked,
        magicKeywords: $omcMagicKw.checked
    } });
};
document.getElementById('saveOmcBtn').onclick = () => {
    vscode.postMessage({ command: 'saveOmc', omc: {
        enabled: $omcEnabled.checked,
        mode: $omcMode.value,
        continuationEnforcement: $omcContinuation.checked,
        magicKeywords: $omcMagicKw.checked
    } });
};
// Embedding 配置控制
const $embEnabled = document.getElementById('embEnabled');
const $embOptions = document.getElementById('embOptions');
const $embProvider = document.getElementById('embProvider');
const $embApiKey = document.getElementById('embApiKey');
const $embBaseUrl = document.getElementById('embBaseUrl');
const $embModel = document.getElementById('embModel');
const $embCustomRow = document.getElementById('embCustomRow');
const $localModelSelect = document.getElementById('localModelSelect');
const $localModelInfo = document.getElementById('localModelInfo');
const $switchModelBtn = document.getElementById('switchModelBtn');
const $cancelDownloadBtn = document.getElementById('cancelDownloadBtn');
const $mirrorSelect = document.getElementById('mirrorSelect');
const localModels = {
    'Xenova/all-MiniLM-L6-v2': { dim: 384, size: 22, desc: '最小最快，基础语义搜索', lang: 'English' },
    'Xenova/all-MiniLM-L12-v2': { dim: 384, size: 33, desc: '12层，比L6更准，速度略慢', lang: 'English' },
    'Xenova/bge-small-en-v1.5': { dim: 384, size: 33, desc: 'BAAI BGE 小模型，代码搜索效果好', lang: 'English' },
    'Xenova/bge-base-en-v1.5': { dim: 768, size: 109, desc: 'BGE 中等模型，性价比最高 ⭐', lang: 'English' },
    'Xenova/bge-large-en-v1.5': { dim: 1024, size: 335, desc: 'BGE 大模型，最高精度', lang: 'English' },
    'Xenova/multilingual-e5-small': { dim: 384, size: 118, desc: '多语言支持，适合中文项目', lang: '多语言' },
    'Xenova/multilingual-e5-base': { dim: 768, size: 278, desc: '多语言中等模型，中文效果最佳 ⭐', lang: '多语言' }
};
function updateLocalModelInfo() {
    const m = localModels[$localModelSelect.value];
    if (m) $localModelInfo.innerHTML = '<b>' + m.dim + '</b>维 · <b>' + m.size + '</b>MB · ' + m.lang + '<br>' + m.desc;
}
$localModelSelect.onchange = updateLocalModelInfo;
updateLocalModelInfo();
$switchModelBtn.onclick = () => {
    $switchModelBtn.disabled = true;
    $switchModelBtn.textContent = '⏳ 下载中...';
    vscode.postMessage({ command: 'switchLocalModel', modelId: $localModelSelect.value, mirror: $mirrorSelect.value });
};
$cancelDownloadBtn.onclick = () => {
    vscode.postMessage({ command: 'cancelDownload' });
    $cancelDownloadBtn.disabled = true;
    $cancelDownloadBtn.textContent = '⏳ 取消中...';
};
$embEnabled.onchange = () => {
    $embOptions.style.display = $embEnabled.checked ? 'block' : 'none';
    // 自动保存 enabled 状态
    vscode.postMessage({ command: 'saveEmbedding', embedding: {
        enabled: $embEnabled.checked,
        provider: $embProvider.value,
        apiKey: $embApiKey.value,
        baseUrl: $embBaseUrl.value,
        model: $embModel.value
    } });
};
$embProvider.onchange = () => { $embCustomRow.style.display = $embProvider.value === 'custom' ? 'block' : 'none'; };
document.getElementById('saveEmbBtn').onclick = () => {
    vscode.postMessage({ command: 'saveEmbedding', embedding: {
        enabled: $embEnabled.checked,
        provider: $embProvider.value,
        apiKey: $embApiKey.value,
        baseUrl: $embBaseUrl.value,
        model: $embModel.value
    } });
};
function updateEmbeddingUI(status) {
    const dot = document.getElementById('embeddingDot');
    const statusText = document.getElementById('embeddingStatus');
    const progressDiv = document.getElementById('downloadProgress');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const cacheCount = document.getElementById('cacheCount');
    const embeddingProgressRow = document.getElementById('embeddingProgressRow');
    const embeddingProgressText = document.getElementById('embeddingProgressText');
    if (status.localModelId) $localModelSelect.value = status.localModelId;
    if (status.modelLoading) {
        dot.className = 'dot'; dot.style.background = '#ff9800'; dot.style.animation = 'pulse 1s infinite';
        const modelName = status.localModelName || '模型';
        const fileInfo = status.downloadFile ? ' (' + status.downloadFile + ')' : '';
        statusText.textContent = modelName + ': 加载中...'; progressDiv.style.display = 'block';
        progressBar.style.width = status.downloadProgress + '%';
        progressText.textContent = '下载' + fileInfo + ': ' + status.downloadProgress + '%';
        embeddingProgressRow.style.display = 'none';
        $switchModelBtn.disabled = true; $switchModelBtn.textContent = '⏳ 下载中...';
        $cancelDownloadBtn.disabled = false; $cancelDownloadBtn.textContent = '⏹️ 取消下载';
    } else if (status.modelReady) {
        dot.className = 'dot on'; dot.style.animation = ''; progressDiv.style.display = 'none';
        const modelName = status.localModelName || '模型';
        const dimInfo = status.dimensions ? ' (' + status.dimensions + 'd)' : '';
        if (status.isPreloading && status.embeddingProgress) { statusText.textContent = modelName + dimInfo + ' 生成中...'; embeddingProgressRow.style.display = 'block'; embeddingProgressText.textContent = status.embeddingProgress; }
        else { statusText.textContent = modelName + dimInfo + ' ✓'; embeddingProgressRow.style.display = 'none'; }
        $switchModelBtn.disabled = false; $switchModelBtn.textContent = '⬇️ 下载并使用此模型';
    } else if (status.error) {
        dot.className = 'dot off'; dot.style.animation = ''; statusText.textContent = '模型: 加载失败'; progressDiv.style.display = 'none'; embeddingProgressRow.style.display = 'none';
        $switchModelBtn.disabled = false; $switchModelBtn.textContent = '⬇️ 下载并使用此模型';
    } else {
        dot.className = 'dot off'; dot.style.animation = ''; statusText.textContent = '模型: 未加载'; progressDiv.style.display = 'none'; embeddingProgressRow.style.display = 'none';
        $switchModelBtn.disabled = false; $switchModelBtn.textContent = '⬇️ 下载并使用此模型';
    }
    cacheCount.textContent = status.cacheCount || 0;
}
function updateContextUI(status) {
    if (!status) return;
    const tokenLimit = status.token_limit || 200000;
    const tokenLimitK = tokenLimit >= 1000000 ? (tokenLimit / 1000000).toFixed(1) + 'M' : (tokenLimit / 1000).toFixed(0) + 'K';
    const estimatedTokens = status.estimated_tokens || 0;
    const usagePercent = status.usage_percentage || 0;
    let color = '#4caf50';
    if (usagePercent > 80) color = '#f44336';
    else if (usagePercent > 60) color = '#ff9800';
    document.getElementById('contextTokens').textContent = estimatedTokens + ' / ' + tokenLimitK + ' (' + usagePercent.toFixed(1) + '%)';
    document.getElementById('contextTokens').style.color = color;
    document.getElementById('contextExchanges').textContent = status.total_exchanges || 0;
    document.getElementById('contextCompression').style.display = status.compressed ? 'block' : 'none';
}
window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'status') {
        document.getElementById('proxyDot').className = 'dot ' + (msg.proxyRunning ? 'on' : 'off');
        document.getElementById('proxyStatus').textContent = '代理: ' + (msg.proxyRunning ? '运行中' : '已停止');
        document.getElementById('startBtn').disabled = msg.proxyRunning;
        document.getElementById('stopBtn').disabled = !msg.proxyRunning;
    } else if (msg.type === 'embeddingStatus') { updateEmbeddingUI(msg); }
    else if (msg.type === 'contextStatus') { updateContextUI(msg); }
    else if (msg.type === 'modelsList') {
        $refreshModelsBtn.disabled = false;
        if (msg.error) { $modelInfo.textContent = '❌ ' + msg.error; $modelInfo.style.color = '#f44336'; }
        else if (msg.models && msg.models.length > 0) {
            availableModels = msg.models; $modelSelect.innerHTML = '<option value="">-- 选择模型 --</option>';
            msg.models.forEach(m => { const opt = document.createElement('option'); opt.value = m.id; opt.textContent = m.name; $modelSelect.appendChild(opt); });
            $modelInfo.textContent = '✓ 找到 ' + msg.models.length + ' 个模型'; $modelInfo.style.color = '#4caf50';
        } else { $modelInfo.textContent = '未找到可用模型'; $modelInfo.style.color = '#ff9800'; }
    } else if (msg.type === 'fullStatus') {
        document.getElementById('proxyDot').className = 'dot ' + (msg.proxyRunning ? 'on' : 'off');
        document.getElementById('proxyStatus').textContent = '代理: ' + (msg.proxyRunning ? '运行中' : '已停止');
        document.getElementById('startBtn').disabled = msg.proxyRunning;
        document.getElementById('stopBtn').disabled = !msg.proxyRunning;
        currentConfig = msg.config; $provider.value = msg.config.provider; $port.value = msg.config.port;
        const pConfig = msg.config.providers?.[msg.config.provider] || {};
        $baseUrl.value = pConfig.baseUrl || ''; $model.value = pConfig.model || '';
        if (msg.config.provider === 'custom') {
            $format.value = pConfig.format || 'anthropic';
            $wireApi.value = pConfig.wireApi || 'chat.completions';
        }
        updateCustomProviderUI();
        $enableThinking.checked = pConfig.enableThinking || false;
        updateKeyStatus(pConfig.hasApiKey);
        if (msg.embeddingStatus) updateEmbeddingUI(msg.embeddingStatus);
        document.getElementById('compressionThreshold').value = msg.config.compressionThreshold || 80;
        if (msg.contextStatus) updateContextUI(msg.contextStatus);
        // 恢复 Embedding 配置状态
        if (msg.config.embedding) {
            $embEnabled.checked = msg.config.embedding.enabled || false;
            $embOptions.style.display = msg.config.embedding.enabled ? 'block' : 'none';
            $embProvider.value = msg.config.embedding.provider || 'glm';
            $embApiKey.value = msg.config.embedding.apiKey || '';
            $embBaseUrl.value = msg.config.embedding.baseUrl || '';
            $embModel.value = msg.config.embedding.model || '';
            $embCustomRow.style.display = msg.config.embedding.provider === 'custom' ? 'block' : 'none';
            if (msg.config.embedding.localModel) { $localModelSelect.value = msg.config.embedding.localModel; updateLocalModelInfo(); }
            if (msg.config.embedding.mirror !== undefined) { $mirrorSelect.value = msg.config.embedding.mirror; }
        }
        // 恢复 OMC 状态
        if (msg.config.omc) {
            $omcEnabled.checked = msg.config.omc.enabled || false;
            $omcOptions.style.display = msg.config.omc.enabled ? 'block' : 'none';
            $omcMode.value = msg.config.omc.mode || 'team';
            $omcContinuation.checked = msg.config.omc.continuationEnforcement !== false;
            $omcMagicKw.checked = msg.config.omc.magicKeywords !== false;
        }
    }
});
document.getElementById('compressionThreshold').onchange = () => {
    const threshold = parseInt(document.getElementById('compressionThreshold').value);
    if (threshold >= 50 && threshold <= 95) vscode.postMessage({command: 'setCompressionThreshold', threshold});
};
vscode.postMessage({command:'getConfig'});
</script>
</body>
</html>`;
    }
}