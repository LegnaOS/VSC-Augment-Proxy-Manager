/**
 * 语义嵌入引擎 - 使用 API Embedding
 * v1.6.0: 使用 API 而非本地模型，体积 ~3MB
 */
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

interface EmbeddingCache {
    [docPath: string]: { embedding: number[]; hash: string };
}

export interface EmbeddingConfig {
    provider: 'glm' | 'openai' | 'custom';
    apiKey: string;
    baseUrl?: string;
    model?: string;
}

export class SemanticEmbeddings {
    private cache: EmbeddingCache = {};
    private cacheDir: string;
    private config: EmbeddingConfig | null = null;
    private initialized: boolean = false;
    private onProgress?: (status: string) => void;

    constructor(cacheDir: string, onProgress?: (status: string) => void) {
        this.cacheDir = cacheDir;
        this.onProgress = onProgress;
    }

    configure(config: EmbeddingConfig): void {
        this.config = config;
        this.onProgress?.('[RAG] Embedding: ' + config.provider);
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        await this.loadCache();
        this.initialized = true;
    }

    async embed(text: string): Promise<number[] | null> {
        if (!this.config?.apiKey) return null;
        try {
            const truncated = text.slice(0, 8000);
            if (this.config.provider === 'glm') return this.embedGLM(truncated);
            if (this.config.provider === 'openai') return this.embedOpenAI(truncated);
            return this.embedCustom(truncated);
        } catch { return null; }
    }

    private async embedGLM(text: string): Promise<number[] | null> {
        const resp = await this.httpPost('https://open.bigmodel.cn/api/paas/v4/embeddings', {
            model: this.config?.model || 'embedding-3', input: text
        });
        return resp?.data?.[0]?.embedding || null;
    }

    private async embedOpenAI(text: string): Promise<number[] | null> {
        const base = this.config?.baseUrl || 'https://api.openai.com';
        const resp = await this.httpPost(base + '/v1/embeddings', {
            model: this.config?.model || 'text-embedding-3-small', input: text
        });
        return resp?.data?.[0]?.embedding || null;
    }

    private async embedCustom(text: string): Promise<number[] | null> {
        if (!this.config?.baseUrl) return null;
        const resp = await this.httpPost(this.config.baseUrl, {
            model: this.config?.model || 'embedding', input: text
        });
        return resp?.data?.[0]?.embedding || null;
    }

    private httpPost(url: string, body: object): Promise<any> {
        return new Promise((resolve, reject) => {
            const lib = url.startsWith('https') ? https : http;
            const parsed = new URL(url);
            const req = lib.request({
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + this.config?.apiKey
                }
            }, res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    if (res.statusCode && res.statusCode < 300) resolve(JSON.parse(data));
                    else reject(new Error('HTTP ' + res.statusCode));
                });
            });
            req.on('error', reject);
            req.write(JSON.stringify(body));
            req.end();
        });
    }

    static cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) return 0;
        let dot = 0, nA = 0, nB = 0;
        for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; nA += a[i]*a[i]; nB += b[i]*b[i]; }
        const m = Math.sqrt(nA) * Math.sqrt(nB);
        return m === 0 ? 0 : dot / m;
    }

    private getCachePath(): string { return path.join(this.cacheDir, 'embed-cache.json'); }

    private async loadCache(): Promise<void> {
        try {
            const p = this.getCachePath();
            if (fs.existsSync(p)) this.cache = JSON.parse(fs.readFileSync(p, 'utf-8'));
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
        if (emb) { this.cache[docPath] = { embedding: emb, hash }; }
        return emb;
    }

    async semanticSearch(query: string, docs: Array<{path: string; content: string; hash: string}>, topK = 10) {
        const qEmb = await this.embed(query);
        if (!qEmb) return [];
        const scores: Array<{path: string; score: number}> = [];
        for (const d of docs) {
            const dEmb = await this.getDocEmbedding(d.path, d.content, d.hash);
            if (dEmb) scores.push({ path: d.path, score: SemanticEmbeddings.cosineSimilarity(qEmb, dEmb) });
        }
        return scores.sort((a, b) => b.score - a.score).slice(0, topK);
    }

    isAvailable(): boolean { return this.initialized && !!this.config?.apiKey; }
    clearCache(): void { this.cache = {}; try { fs.unlinkSync(this.getCachePath()); } catch { /* ignore */ } }
    getCacheStats() { return { documents: Object.keys(this.cache).length }; }
}
