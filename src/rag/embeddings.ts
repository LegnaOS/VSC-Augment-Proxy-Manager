/**
 * 语义嵌入引擎 - 支持本地模型 + 远程 API (GLM/OpenAI/Custom)
 * v1.7.0: 本地 all-MiniLM-L6-v2 模型，支持下载进度显示
 * v2.0.0: OpenViking 增强 - 远程 Embedding API 支持 (GLM/OpenAI/Custom OpenAI-compatible)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

interface EmbeddingCache {
    [docPath: string]: { embedding: number[]; hash: string };
}

export interface EmbeddingConfig {
    enabled: boolean;
    provider: 'glm' | 'openai' | 'custom';  // remote provider
    apiKey: string;
    baseUrl: string;
    model: string;
}

// 远程 Embedding 供应商默认配置
const EMBEDDING_DEFAULTS: Record<string, { baseUrl: string; model: string; dimensions: number; maxTokens: number }> = {
    glm: {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
        model: 'embedding-3',
        dimensions: 2048,
        maxTokens: 8192
    },
    openai: {
        baseUrl: 'https://api.openai.com/v1/embeddings',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        maxTokens: 8191
    },
    custom: {
        baseUrl: '',
        model: '',
        dimensions: 1024,
        maxTokens: 8192
    }
};

// v2.1.0: 本地模型选项
export interface LocalModelInfo {
    id: string;           // HuggingFace 模型 ID
    name: string;         // 显示名称
    dimensions: number;   // 输出维度
    maxTokens: number;    // 最大 token 数
    sizeMB: number;       // ONNX 模型大小 (MB)
    description: string;  // 简短描述
    lang: string;         // 语言支持
}

export const LOCAL_MODELS: LocalModelInfo[] = [
    {
        id: 'Xenova/all-MiniLM-L6-v2',
        name: 'MiniLM-L6 (22MB)',
        dimensions: 384, maxTokens: 512, sizeMB: 22,
        description: '最小最快，基础语义搜索',
        lang: 'English'
    },
    {
        id: 'Xenova/all-MiniLM-L12-v2',
        name: 'MiniLM-L12 (33MB)',
        dimensions: 384, maxTokens: 512, sizeMB: 33,
        description: '12层，比L6更准，速度略慢',
        lang: 'English'
    },
    {
        id: 'Xenova/bge-small-en-v1.5',
        name: 'BGE-Small (33MB)',
        dimensions: 384, maxTokens: 512, sizeMB: 33,
        description: 'BAAI BGE 小模型，代码搜索效果好',
        lang: 'English'
    },
    {
        id: 'Xenova/bge-base-en-v1.5',
        name: 'BGE-Base (109MB)',
        dimensions: 768, maxTokens: 512, sizeMB: 109,
        description: 'BGE 中等模型，性价比最高 ⭐',
        lang: 'English'
    },
    {
        id: 'Xenova/multilingual-e5-small',
        name: 'E5-Multi-Small (118MB)',
        dimensions: 384, maxTokens: 512, sizeMB: 118,
        description: '多语言支持，适合中文项目',
        lang: '多语言 (中/英/日/韩...)'
    },
];

export interface EmbeddingStatus {
    mode: 'local' | 'remote' | 'disabled';
    provider?: string;
    localModelId?: string;
    localModelName?: string;
    modelLoading: boolean;
    downloadProgress: number;
    downloadFile?: string;
    modelReady: boolean;
    cacheCount: number;
    error?: string;
    embeddingProgress?: string;
    isPreloading?: boolean;
    dimensions?: number;
}

export class SemanticEmbeddings {
    private cache: EmbeddingCache = {};
    private cacheDir: string;
    private initialized: boolean = false;
    private modelLoading: boolean = false;
    private modelReady: boolean = false;
    private downloadProgress: number = 0;
    private downloadFile: string = '';
    private pipeline: any = null;
    private lastError: string = '';
    private onProgress?: (status: string) => void;
    private onStatusChange?: (status: EmbeddingStatus) => void;
    private isPreloading: boolean = false;
    private preloadCurrent: number = 0;
    private preloadTotal: number = 0;
    // v2.0.0: 远程 API 配置
    private embeddingConfig: EmbeddingConfig | null = null;
    private useRemote: boolean = false;
    private remoteDimensions: number = 0;
    private remoteMaxTokens: number = 8192;
    // 远程 API 速率限制
    private lastRemoteCallMs: number = 0;
    private remoteMinIntervalMs: number = 50;
    // v2.1.0: 本地模型选择
    private localModelId: string = 'Xenova/all-MiniLM-L6-v2';
    private localDimensions: number = 384;
    // v3.0.0: HuggingFace 镜像
    private mirrorHost: string = '';
    // v3.0.0: 下载取消
    private _cancelRequested: boolean = false;

    constructor(cacheDir: string, onProgress?: (status: string) => void, onStatusChange?: (status: EmbeddingStatus) => void) {
        this.cacheDir = cacheDir;
        this.onProgress = onProgress;
        this.onStatusChange = onStatusChange;
    }

    // v2.1.0: 设置本地模型（必须在 initialize() 之前调用）
    setLocalModel(modelId: string): void {
        const info = LOCAL_MODELS.find(m => m.id === modelId);
        if (info) {
            this.localModelId = info.id;
            this.localDimensions = info.dimensions;
            this.onProgress?.(`[RAG] 📦 Local model set: ${info.name} (${info.dimensions}d, ~${info.sizeMB}MB)`);
        }
    }

    getLocalModelId(): string { return this.localModelId; }

    // v3.0.0: 设置 HuggingFace 镜像地址
    setMirror(mirror: string): void {
        this.mirrorHost = mirror;
        if (mirror) {
            this.onProgress?.(`[RAG] 🪞 Mirror set: ${mirror}`);
        }
    }

    // v3.0.0: 取消下载
    cancelDownload(): void {
        if (this.modelLoading) {
            this._cancelRequested = true;
            this.onProgress?.('[RAG] ⏹️ Download cancel requested...');
        }
    }

    // v2.0.0: 配置远程 Embedding API
    configureRemote(config: EmbeddingConfig): void {
        this.embeddingConfig = config;
        if (config.enabled && config.apiKey) {
            const defaults = EMBEDDING_DEFAULTS[config.provider] || EMBEDDING_DEFAULTS.custom;
            this.useRemote = true;
            this.remoteDimensions = defaults.dimensions;
            this.remoteMaxTokens = defaults.maxTokens;
            this.onProgress?.(`[RAG] 🌐 Remote embedding configured: ${config.provider} (${defaults.model})`);
        } else {
            this.useRemote = false;
        }
    }

    private notifyStatus(): void {
        this.onStatusChange?.(this.getStatus());
    }

    getStatus(): EmbeddingStatus {
        const localInfo = LOCAL_MODELS.find(m => m.id === this.localModelId);
        return {
            mode: this.useRemote ? 'remote' : 'local',
            provider: this.useRemote ? this.embeddingConfig?.provider : undefined,
            localModelId: this.localModelId,
            localModelName: localInfo?.name,
            modelLoading: this.modelLoading,
            downloadProgress: this.downloadProgress,
            downloadFile: this.downloadFile || undefined,
            modelReady: this.modelReady,
            cacheCount: Object.keys(this.cache).length,
            error: this.lastError || undefined,
            embeddingProgress: this.isPreloading ? `${this.preloadCurrent}/${this.preloadTotal}` : undefined,
            isPreloading: this.isPreloading,
            dimensions: this.useRemote ? this.remoteDimensions : this.localDimensions,
        };
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;

        // v2.0.0: 如果已配置远程 API，优先使用远程
        if (this.useRemote) {
            this.onProgress?.(`[RAG] 🌐 Using remote embedding API: ${this.embeddingConfig!.provider}`);
            // 测试远程 API 连通性
            try {
                const testEmb = await this.embedRemote('test connection');
                if (testEmb && testEmb.length > 0) {
                    this.remoteDimensions = testEmb.length;
                    this.modelReady = true;
                    this.initialized = true;
                    await this.loadCache();
                    this.onProgress?.(`[RAG] 🌐 Remote embedding ready: ${this.embeddingConfig!.provider}, dim=${this.remoteDimensions}`);
                    this.notifyStatus();
                    return;
                }
            } catch (err: any) {
                this.onProgress?.(`[RAG] ⚠️ Remote embedding test failed: ${err.message}, falling back to local`);
                this.useRemote = false;
            }
        }

        // 回退到本地模型
        await this.loadLocalModel();
    }

    // v2.1.0: 加载本地模型（可独立调用，支持切换模型）
    // v3.1.1: _wasmFallback — DLL/native binding 失败后自动回退 WASM backend
    async loadLocalModel(_retried = false, _wasmFallback = false): Promise<void> {
        const modelInfo = LOCAL_MODELS.find(m => m.id === this.localModelId) || LOCAL_MODELS[0];
        this.modelLoading = true;
        this._cancelRequested = false;
        this.downloadProgress = 0;
        this.downloadFile = '';
        this.lastError = '';
        this.notifyStatus();
        this.onProgress?.(`[RAG] 🧠 Loading transformers.js${_wasmFallback ? ' (WASM fallback)' : ''}...`);

        try {
            const { pipeline: tfPipeline, env } = await import('@huggingface/transformers');
            env.cacheDir = path.join(this.cacheDir, 'models');
            env.allowLocalModels = true;
            // v3.0.0: 使用镜像加速下载
            if (this.mirrorHost) {
                env.remoteHost = this.mirrorHost;
            }

            // v3.0.1: 检查模型是否已缓存 — 已下载就直接加载，跳过下载流程
            const modelCacheDir = path.join(env.cacheDir, this.localModelId);
            const onnxPath = path.join(modelCacheDir, 'onnx', 'model.onnx');
            const isCached = fs.existsSync(onnxPath);

            if (isCached) {
                this.onProgress?.(`[RAG] ✅ 模型已缓存，直接加载: ${modelInfo.name}`);
                this.downloadProgress = 100;
                this.notifyStatus();
            } else {
                if (this.mirrorHost) {
                    this.onProgress?.(`[RAG] 🪞 Using mirror: ${this.mirrorHost}`);
                }
                this.onProgress?.(`[RAG] 📥 首次下载模型: ${modelInfo.name} (~${modelInfo.sizeMB}MB)...`);
            }

            // v3.1.1: WASM fallback — native DLL 失败时用 WASM backend
            const pipelineOptions: any = {
                progress_callback: isCached ? undefined : (progress: any) => {
                    // v3.0.0: 检查取消请求
                    if (this._cancelRequested) {
                        throw new Error('DOWNLOAD_CANCELLED');
                    }
                    if (progress.status === 'initiate') {
                        this.downloadFile = progress.file || '';
                        this.downloadProgress = 0;
                        this.onProgress?.(`[RAG] 📦 ${modelInfo.name}: ${this.downloadFile} 准备中...`);
                        this.notifyStatus();
                    } else if (progress.status === 'download') {
                        this.downloadFile = progress.file || '';
                        this.downloadProgress = 0;
                        this.onProgress?.(`[RAG] 📥 ${modelInfo.name}: ${this.downloadFile} 开始下载...`);
                        this.notifyStatus();
                    } else if (progress.status === 'progress') {
                        const pct = typeof progress.progress === 'number'
                            ? Math.round(progress.progress)
                            : (progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0);
                        this.downloadProgress = pct;
                        this.downloadFile = progress.file || this.downloadFile;
                        const sizeMB = progress.total > 0 ? (progress.total / 1048576).toFixed(1) + 'MB' : '';
                        this.onProgress?.(`[RAG] 📥 ${modelInfo.name}: ${this.downloadFile} ${pct}% ${sizeMB}`);
                        this.notifyStatus();
                    } else if (progress.status === 'done') {
                        this.downloadProgress = 100;
                        this.onProgress?.(`[RAG] ✅ ${progress.file || 'file'} loaded`);
                        this.notifyStatus();
                    }
                }
            };
            if (_wasmFallback) {
                pipelineOptions.device = 'wasm';
            }

            this.pipeline = await tfPipeline('feature-extraction', this.localModelId, pipelineOptions);

            this.localDimensions = modelInfo.dimensions;
            this.modelReady = true;
            this.modelLoading = false;
            this.downloadProgress = 100;
            await this.loadCache();
            this.initialized = true;
            const backendLabel = _wasmFallback ? 'WASM' : 'native';
            this.onProgress?.(`[RAG] 🧠 Semantic engine ready: ${modelInfo.name} (${modelInfo.dimensions}d, ${backendLabel})`);
            this.notifyStatus();
        } catch (err: any) {
            const cancelled = this._cancelRequested || (err.message && err.message.includes('DOWNLOAD_CANCELLED'));
            this._cancelRequested = false;
            this.modelLoading = false;
            this.modelReady = false;
            this.pipeline = null;
            if (cancelled) {
                this.lastError = '';
                this.downloadProgress = 0;
                this.downloadFile = '';
                this.onProgress?.('[RAG] ⏹️ Download cancelled');
                this.notifyStatus();
                return; // 取消不抛异常
            }
            const errMsg = err.message || '';
            // v3.1.1: 检测 native DLL 加载失败 — 自动回退 WASM backend
            const isDllFailure = /DLL initialization|onnxruntime_binding|native.*failed|\.node/i.test(errMsg);
            if (isDllFailure && !_wasmFallback) {
                this.onProgress?.(`[RAG] ⚠️ Native ONNX runtime failed, falling back to WASM backend...`);
                return this.loadLocalModel(_retried, true);
            }
            // v3.0.0: 检测缓存损坏（Protobuf parsing failed / failed to load 等），自动清理并重试一次
            const isCorrupted = /protobuf parsing failed|failed to load.*onnx|invalid model|corrupted/i.test(errMsg);
            if (isCorrupted && !_retried) {
                this.onProgress?.(`[RAG] ⚠️ Model cache corrupted, cleaning and retrying...`);
                try {
                    const { env } = await import('@huggingface/transformers');
                    const modelCacheDir = path.join(env.cacheDir || path.join(this.cacheDir, 'models'), this.localModelId);
                    if (fs.existsSync(modelCacheDir)) {
                        fs.rmSync(modelCacheDir, { recursive: true, force: true });
                        this.onProgress?.(`[RAG] 🗑️ Deleted corrupted cache: ${modelCacheDir}`);
                    }
                } catch (cleanErr: any) {
                    this.onProgress?.(`[RAG] ⚠️ Cache cleanup failed: ${cleanErr.message}`);
                }
                // 重试一次
                return this.loadLocalModel(true, _wasmFallback);
            }
            this.lastError = errMsg || 'Failed to load model';
            this.onProgress?.(`[RAG] ❌ Model load failed: ${this.lastError}`);
            this.notifyStatus();
            throw err;
        }
    }

    // v2.1.0: 切换本地模型（重新初始化）
    async switchLocalModel(modelId: string): Promise<void> {
        const info = LOCAL_MODELS.find(m => m.id === modelId);
        if (!info) throw new Error(`Unknown model: ${modelId}`);
        // 清理旧 pipeline
        this.pipeline = null;
        this.initialized = false;
        this.modelReady = false;
        this.cache = {};  // 维度变了，缓存失效
        this.localModelId = modelId;
        this.localDimensions = info.dimensions;
        this.useRemote = false;
        await this.loadLocalModel();
    }

    // v2.0.0: 远程 Embedding API 调用
    private async embedRemote(text: string): Promise<number[] | null> {
        if (!this.embeddingConfig?.apiKey) return null;
        const cfg = this.embeddingConfig;
        const defaults = EMBEDDING_DEFAULTS[cfg.provider] || EMBEDDING_DEFAULTS.custom;
        const baseUrl = cfg.baseUrl || defaults.baseUrl;
        const model = cfg.model || defaults.model;

        if (!baseUrl) {
            this.onProgress?.('[RAG] ❌ Remote embedding: no base URL configured');
            return null;
        }

        // 速率限制
        const now = Date.now();
        const elapsed = now - this.lastRemoteCallMs;
        if (elapsed < this.remoteMinIntervalMs) {
            await new Promise(r => setTimeout(r, this.remoteMinIntervalMs - elapsed));
        }
        this.lastRemoteCallMs = Date.now();

        // 截断到最大 token 限制（粗略按字符算，中文 1 char ≈ 1-2 tokens）
        const maxChars = this.remoteMaxTokens * 3;
        const truncated = text.length > maxChars ? text.slice(0, maxChars) : text;

        return new Promise((resolve, reject) => {
            const url = new URL(baseUrl);
            const isHttps = url.protocol === 'https:';
            const requestBody = JSON.stringify({ model, input: truncated });
            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${cfg.apiKey}`,
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            };
            const httpModule = isHttps ? https : http;
            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Embedding API ${res.statusCode}: ${data.slice(0, 200)}`));
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const embedding = json.data?.[0]?.embedding;
                        if (Array.isArray(embedding)) {
                            resolve(embedding);
                        } else {
                            reject(new Error('No embedding in response'));
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse embedding response: ${e}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(30000, () => { req.destroy(); reject(new Error('Embedding API timeout')); });
            req.write(requestBody);
            req.end();
        });
    }

    // v2.0.0: 批量远程 Embedding（减少 API 调用次数）
    async embedBatchRemote(texts: string[]): Promise<(number[] | null)[]> {
        if (!this.embeddingConfig?.apiKey || texts.length === 0) return texts.map(() => null);
        const cfg = this.embeddingConfig;
        const defaults = EMBEDDING_DEFAULTS[cfg.provider] || EMBEDDING_DEFAULTS.custom;
        const baseUrl = cfg.baseUrl || defaults.baseUrl;
        const model = cfg.model || defaults.model;
        if (!baseUrl) return texts.map(() => null);

        const maxChars = this.remoteMaxTokens * 3;
        const truncated = texts.map(t => t.length > maxChars ? t.slice(0, maxChars) : t);

        // 分批处理（每批最多 20 个）
        const batchSize = 20;
        const results: (number[] | null)[] = [];
        for (let i = 0; i < truncated.length; i += batchSize) {
            const batch = truncated.slice(i, i + batchSize);
            try {
                const embeddings = await this.callBatchEmbeddingAPI(baseUrl, model, cfg.apiKey, batch);
                results.push(...embeddings);
            } catch (err: any) {
                this.onProgress?.(`[RAG] ⚠️ Batch embedding error: ${err.message}`);
                // 单个失败，逐个尝试
                for (const text of batch) {
                    try { results.push(await this.embedRemote(text)); }
                    catch { results.push(null); }
                }
            }
        }
        return results;
    }

    private async callBatchEmbeddingAPI(baseUrl: string, model: string, apiKey: string, inputs: string[]): Promise<(number[] | null)[]> {
        return new Promise((resolve, reject) => {
            const url = new URL(baseUrl);
            const isHttps = url.protocol === 'https:';
            const requestBody = JSON.stringify({ model, input: inputs });
            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            };
            const httpModule = isHttps ? https : http;
            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Batch Embedding API ${res.statusCode}: ${data.slice(0, 200)}`));
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const embeddings = (json.data || [])
                            .sort((a: any, b: any) => (a.index || 0) - (b.index || 0))
                            .map((d: any) => d.embedding || null);
                        resolve(embeddings);
                    } catch (e) {
                        reject(new Error(`Failed to parse batch response: ${e}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(60000, () => { req.destroy(); reject(new Error('Batch embedding API timeout')); });
            req.write(requestBody);
            req.end();
        });
    }

    async embed(text: string): Promise<number[] | null> {
        // v2.0.0: 优先使用远程 API
        if (this.useRemote) {
            try {
                return await this.embedRemote(text);
            } catch (err: any) {
                this.onProgress?.(`[RAG] ⚠️ Remote embed failed: ${err.message}`);
                // 如果有本地 pipeline，回退
                if (this.pipeline) {
                    return this.embedLocal(text);
                }
                return null;
            }
        }
        return this.embedLocal(text);
    }

    private async embedLocal(text: string): Promise<number[] | null> {
        if (!this.pipeline) return null;
        try {
            const truncated = text.slice(0, 512);
            const output = await this.pipeline(truncated, { pooling: 'mean', normalize: true });
            return Array.from(output.data as Float32Array);
        } catch (err: any) {
            this.onProgress?.(`[RAG] Embed error: ${err.message}`);
            return null;
        }
    }

    static cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) return 0;
        let dot = 0, nA = 0, nB = 0;
        for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i]; }
        const m = Math.sqrt(nA) * Math.sqrt(nB);
        return m === 0 ? 0 : dot / m;
    }

    // v2.1.0: 远程/本地分开缓存，本地按模型名区分
    private getCachePath(): string {
        if (this.useRemote) {
            return path.join(this.cacheDir, `embed-cache-${this.embeddingConfig?.provider || 'remote'}.json`);
        }
        // 本地模型：用模型短名做后缀，如 embed-cache-bge-base-en-v1.5.json
        const shortName = this.localModelId.replace('Xenova/', '');
        return path.join(this.cacheDir, `embed-cache-${shortName}.json`);
    }

    private async loadCache(): Promise<void> {
        try {
            const p = this.getCachePath();
            if (fs.existsSync(p)) {
                const loaded = JSON.parse(fs.readFileSync(p, 'utf-8'));
                // 验证缓存维度一致性
                const firstKey = Object.keys(loaded)[0];
                if (firstKey && loaded[firstKey]?.embedding) {
                    const cachedDim = loaded[firstKey].embedding.length;
                    const expectedDim = this.useRemote ? this.remoteDimensions : this.localDimensions;
                    if (cachedDim !== expectedDim && expectedDim > 0) {
                        this.onProgress?.(`[RAG] ⚠️ Cache dimension mismatch (${cachedDim} vs ${expectedDim}), clearing cache`);
                        this.cache = {};
                        return;
                    }
                }
                this.cache = loaded;
            }
            this.onProgress?.(`[RAG] Loaded ${Object.keys(this.cache).length} cached embeddings`);
        } catch { /* ignore */ }
    }

    async saveCache(): Promise<void> {
        try {
            const p = this.getCachePath();
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(this.cache));
        } catch { /* ignore */ }
    }

    async getDocEmbedding(docPath: string, content: string, hash: string): Promise<number[] | null> {
        const c = this.cache[docPath];
        if (c?.hash === hash) return c.embedding;
        const emb = await this.embed(content);
        if (emb) { this.cache[docPath] = { embedding: emb, hash }; this.notifyStatus(); }
        return emb;
    }

    async semanticSearch(query: string, docs: Array<{ path: string; content: string; hash: string }>, topK = 10) {
        const qEmb = await this.embed(query);
        if (!qEmb) return [];
        const scores: Array<{ path: string; score: number }> = [];
        for (const d of docs) {
            const dEmb = await this.getDocEmbedding(d.path, d.content, d.hash);
            if (dEmb) scores.push({ path: d.path, score: SemanticEmbeddings.cosineSimilarity(qEmb, dEmb) });
        }
        return scores.sort((a, b) => b.score - a.score).slice(0, topK);
    }

    isAvailable(): boolean { return this.initialized && this.modelReady; }
    clearCache(): void { this.cache = {}; try { fs.unlinkSync(this.getCachePath()); } catch { /* ignore */ } this.notifyStatus(); }
    getCacheStats() { return { documents: Object.keys(this.cache).length }; }

    // v2.0.0: 预加载 - 远程批量 / 本地逐个
    async preloadEmbeddings(
        docs: Array<{ path: string; content: string; hash: string }>,
        onProgress?: (current: number, total: number) => void
    ): Promise<void> {
        if (!this.isAvailable()) return;
        const total = docs.length;
        if (total === 0) return;

        this.isPreloading = true;
        this.preloadTotal = total;
        this.preloadCurrent = 0;
        this.notifyStatus();
        this.onProgress?.(`[RAG] 🔄 Pre-generating embeddings for ${total} documents...`);

        // 筛选出需要生成嵌入的文档
        const uncached = docs.filter(d => {
            const c = this.cache[d.path];
            return !c || c.hash !== d.hash;
        });
        this.onProgress?.(`[RAG] ${docs.length - uncached.length} cached, ${uncached.length} to embed`);

        let needsSave = false;

        if (this.useRemote && uncached.length > 0) {
            // 远程批量嵌入 — 每批 20 个
            const batchSize = 20;
            for (let i = 0; i < uncached.length; i += batchSize) {
                const batch = uncached.slice(i, i + batchSize);
                const texts = batch.map(d => d.content);
                const embeddings = await this.embedBatchRemote(texts);
                for (let j = 0; j < batch.length; j++) {
                    if (embeddings[j]) {
                        this.cache[batch[j].path] = { embedding: embeddings[j]!, hash: batch[j].hash };
                        needsSave = true;
                    }
                }
                this.preloadCurrent = Math.min(i + batchSize, uncached.length) + (docs.length - uncached.length);
                onProgress?.(this.preloadCurrent, total);
                this.notifyStatus();
                if (needsSave && (i + batchSize) % 100 === 0) { await this.saveCache(); needsSave = false; }
            }
        } else {
            // 本地逐个嵌入
            for (let i = 0; i < uncached.length; i++) {
                const doc = uncached[i];
                const emb = await this.embed(doc.content);
                if (emb) { this.cache[doc.path] = { embedding: emb, hash: doc.hash }; needsSave = true; }
                this.preloadCurrent = i + 1 + (docs.length - uncached.length);
                if ((i + 1) % 10 === 0) { onProgress?.(this.preloadCurrent, total); this.notifyStatus(); }
                if ((i + 1) % 50 === 0 && needsSave) { await this.saveCache(); needsSave = false; }
            }
        }

        if (needsSave) await this.saveCache();
        this.isPreloading = false;
        this.preloadCurrent = 0;
        this.preloadTotal = 0;
        this.notifyStatus();
        this.onProgress?.(`[RAG] ✅ Embeddings ready: ${Object.keys(this.cache).length} documents cached`);
    }
}
