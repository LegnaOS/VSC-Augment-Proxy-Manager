/**
 * 语义嵌入引擎 - 使用 transformers.js 本地模型
 * v1.7.0: 本地 all-MiniLM-L6-v2 模型，支持下载进度显示
 */
import * as fs from 'fs';
import * as path from 'path';

interface EmbeddingCache {
    [docPath: string]: { embedding: number[]; hash: string };
}

export interface EmbeddingStatus {
    mode: 'local' | 'disabled';
    modelLoading: boolean;
    downloadProgress: number;
    modelReady: boolean;
    cacheCount: number;
    error?: string;
    // 🔥 v1.7.1: 嵌入预加载进度
    embeddingProgress?: string;  // 格式: "42/128" 或 null
    isPreloading?: boolean;
}

export class SemanticEmbeddings {
    private cache: EmbeddingCache = {};
    private cacheDir: string;
    private initialized: boolean = false;
    private modelLoading: boolean = false;
    private modelReady: boolean = false;
    private downloadProgress: number = 0;
    private pipeline: any = null;
    private lastError: string = '';
    private onProgress?: (status: string) => void;
    private onStatusChange?: (status: EmbeddingStatus) => void;
    // 🔥 v1.7.1: 预加载状态
    private isPreloading: boolean = false;
    private preloadCurrent: number = 0;
    private preloadTotal: number = 0;

    constructor(cacheDir: string, onProgress?: (status: string) => void, onStatusChange?: (status: EmbeddingStatus) => void) {
        this.cacheDir = cacheDir;
        this.onProgress = onProgress;
        this.onStatusChange = onStatusChange;
    }

    private notifyStatus(): void {
        this.onStatusChange?.(this.getStatus());
    }

    getStatus(): EmbeddingStatus {
        return {
            mode: 'local',
            modelLoading: this.modelLoading,
            downloadProgress: this.downloadProgress,
            modelReady: this.modelReady,
            cacheCount: Object.keys(this.cache).length,
            error: this.lastError || undefined,
            // 🔥 v1.7.1: 预加载进度
            embeddingProgress: this.isPreloading ? `${this.preloadCurrent}/${this.preloadTotal}` : undefined,
            isPreloading: this.isPreloading,
        };
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        this.modelLoading = true;
        this.notifyStatus();
        this.onProgress?.('[RAG] 🧠 Loading transformers.js...');

        try {
            // 动态导入 transformers.js
            const { pipeline, env } = await import('@huggingface/transformers');

            // 设置缓存目录到插件目录
            env.cacheDir = path.join(this.cacheDir, 'models');
            env.allowLocalModels = true;

            this.onProgress?.('[RAG] 📥 Downloading model: all-MiniLM-L6-v2...');

            // 创建 feature-extraction pipeline
            this.pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                progress_callback: (progress: any) => {
                    if (progress.status === 'downloading') {
                        this.downloadProgress = Math.round((progress.loaded / progress.total) * 100) || 0;
                        this.onProgress?.(`[RAG] 📥 Downloading: ${this.downloadProgress}%`);
                        this.notifyStatus();
                    } else if (progress.status === 'done') {
                        this.downloadProgress = 100;
                        this.onProgress?.('[RAG] ✅ Model downloaded');
                        this.notifyStatus();
                    }
                }
            });

            this.modelReady = true;
            this.modelLoading = false;
            await this.loadCache();
            this.initialized = true;
            this.onProgress?.('[RAG] 🧠 Semantic engine ready (local model)');
            this.notifyStatus();
        } catch (err: any) {
            this.lastError = err.message || 'Failed to load model';
            this.modelLoading = false;
            this.modelReady = false;
            this.onProgress?.(`[RAG] ❌ Model load failed: ${this.lastError}`);
            this.notifyStatus();
            throw err;
        }
    }

    async embed(text: string): Promise<number[] | null> {
        if (!this.pipeline) return null;
        try {
            const truncated = text.slice(0, 512); // MiniLM 最大 512 tokens
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

    private getCachePath(): string { return path.join(this.cacheDir, 'embed-cache.json'); }

    private async loadCache(): Promise<void> {
        try {
            const p = this.getCachePath();
            if (fs.existsSync(p)) this.cache = JSON.parse(fs.readFileSync(p, 'utf-8'));
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

    // 🔥 v1.7.1: 预加载所有文档嵌入
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

        let needsSave = false;
        for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            this.preloadCurrent = i + 1;

            // 检查缓存是否已有该文档的嵌入
            const cached = this.cache[doc.path];
            if (cached?.hash === doc.hash) {
                // 已有缓存，跳过
                if ((i + 1) % 50 === 0) {
                    onProgress?.(i + 1, total);
                    this.notifyStatus();
                }
                continue;
            }

            // 生成嵌入
            const emb = await this.embed(doc.content);
            if (emb) {
                this.cache[doc.path] = { embedding: emb, hash: doc.hash };
                needsSave = true;
            }

            // 定期更新进度和保存缓存
            if ((i + 1) % 10 === 0) {
                onProgress?.(i + 1, total);
                this.notifyStatus();
            }
            if ((i + 1) % 50 === 0 && needsSave) {
                await this.saveCache();
                needsSave = false;
            }
        }

        // 保存最终缓存
        if (needsSave) {
            await this.saveCache();
        }

        this.isPreloading = false;
        this.preloadCurrent = 0;
        this.preloadTotal = 0;
        this.notifyStatus();

        this.onProgress?.(`[RAG] ✅ Embeddings ready: ${Object.keys(this.cache).length} documents cached`);
    }
}
