/**
 * Semantic Embeddings Module - 语义向量嵌入
 * 
 * 使用 @huggingface/transformers + Xenova/all-MiniLM-L6-v2
 * 实现语义相似度搜索，解决 BM25 无法理解同义词的问题
 * 
 * 🔥 v1.6.0: 语义搜索增强
 */

import * as path from 'path';
import * as fs from 'fs';

// 动态导入 transformers.js（延迟加载以避免启动时间过长）
let pipeline: any = null;
let extractor: any = null;

// 嵌入缓存
interface EmbeddingCache {
    [path: string]: {
        embedding: number[];
        hash: string;  // 内容哈希，用于检测变化
    };
}

export class SemanticEmbeddings {
    private cacheDir: string;
    private cache: EmbeddingCache = {};
    private initialized: boolean = false;
    private modelLoading: Promise<void> | null = null;
    private onProgress?: (status: string) => void;

    constructor(cacheDir: string, onProgress?: (status: string) => void) {
        this.cacheDir = cacheDir;
        this.onProgress = onProgress;
    }

    // 初始化嵌入模型（延迟加载）
    async initialize(): Promise<boolean> {
        if (this.initialized) return true;
        if (this.modelLoading) {
            await this.modelLoading;
            return this.initialized;
        }

        this.modelLoading = this._loadModel();
        await this.modelLoading;
        return this.initialized;
    }

    private async _loadModel(): Promise<void> {
        try {
            this.onProgress?.('[Embedding] Loading transformers.js...');
            
            // 动态导入 @huggingface/transformers
            const transformers = await import('@huggingface/transformers');
            pipeline = transformers.pipeline;

            this.onProgress?.('[Embedding] Loading all-MiniLM-L6-v2 model...');
            
            // 创建特征提取管道
            // 模型会自动下载到 ~/.cache/huggingface/
            extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                // 使用 WASM 后端（纯 JS，无需 GPU）
                device: 'cpu',
                // 缓存目录
                cache_dir: path.join(this.cacheDir, 'models'),
            });

            this.initialized = true;
            this.onProgress?.('[Embedding] Model loaded successfully');

            // 加载嵌入缓存
            await this.loadCache();
        } catch (error: any) {
            this.onProgress?.(`[Embedding] Failed to load model: ${error.message}`);
            this.initialized = false;
        }
    }

    // 生成文本嵌入向量
    async embed(text: string): Promise<number[] | null> {
        if (!this.initialized || !extractor) {
            return null;
        }

        try {
            // 限制文本长度（模型最大 512 tokens）
            const truncated = text.slice(0, 2000);
            
            // 生成嵌入
            const output = await extractor(truncated, {
                pooling: 'mean',
                normalize: true
            });

            // 转换为普通数组
            return Array.from(output.data as Float32Array);
        } catch (error) {
            return null;
        }
    }

    // 批量生成嵌入（更高效）
    async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
        if (!this.initialized || !extractor) {
            return texts.map(() => null);
        }

        try {
            const truncated = texts.map(t => t.slice(0, 2000));
            const output = await extractor(truncated, {
                pooling: 'mean',
                normalize: true
            });

            // output.data 是 Float32Array，每 384 个元素是一个向量
            const dim = 384;
            const results: (number[] | null)[] = [];
            const data = output.data as Float32Array;

            for (let i = 0; i < texts.length; i++) {
                const start = i * dim;
                const end = start + dim;
                results.push(Array.from(data.slice(start, end)));
            }

            return results;
        } catch (error) {
            return texts.map(() => null);
        }
    }

    // 计算余弦相似度
    static cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) return 0;
        
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
        return magnitude === 0 ? 0 : dotProduct / magnitude;
    }

    // 缓存管理
    private getCachePath(): string {
        return path.join(this.cacheDir, 'embeddings-cache.json');
    }

    private async loadCache(): Promise<void> {
        try {
            const cachePath = this.getCachePath();
            if (fs.existsSync(cachePath)) {
                const data = fs.readFileSync(cachePath, 'utf-8');
                this.cache = JSON.parse(data);
            }
        } catch { /* 忽略 */ }
    }

    async saveCache(): Promise<void> {
        try {
            const cachePath = this.getCachePath();
            const dir = path.dirname(cachePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(cachePath, JSON.stringify(this.cache));
        } catch { /* 忽略 */ }
    }

    // 获取或生成文档嵌入（带缓存）
    async getDocumentEmbedding(docPath: string, content: string, hash: string): Promise<number[] | null> {
        // 检查缓存
        const cached = this.cache[docPath];
        if (cached && cached.hash === hash) {
            return cached.embedding;
        }

        // 生成新嵌入
        const embedding = await this.embed(content);
        if (embedding) {
            this.cache[docPath] = { embedding, hash };
        }
        return embedding;
    }

    // 语义搜索
    async semanticSearch(
        query: string,
        documents: Array<{ path: string; content: string; hash: string }>,
        topK: number = 10
    ): Promise<Array<{ path: string; score: number }>> {
        // 生成查询嵌入
        const queryEmbedding = await this.embed(query);
        if (!queryEmbedding) {
            return [];
        }

        // 计算每个文档的相似度
        const scores: Array<{ path: string; score: number }> = [];

        for (const doc of documents) {
            const docEmbedding = await this.getDocumentEmbedding(doc.path, doc.content, doc.hash);
            if (docEmbedding) {
                const score = SemanticEmbeddings.cosineSimilarity(queryEmbedding, docEmbedding);
                scores.push({ path: doc.path, score });
            }
        }

        // 按相似度排序
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, topK);
    }

    // 检查模型是否可用
    isAvailable(): boolean {
        return this.initialized;
    }

    // 清除缓存
    clearCache(): void {
        this.cache = {};
        try {
            const cachePath = this.getCachePath();
            if (fs.existsSync(cachePath)) {
                fs.unlinkSync(cachePath);
            }
        } catch { /* 忽略 */ }
    }

    // 获取缓存统计
    getCacheStats(): { size: number; documents: number } {
        const documents = Object.keys(this.cache).length;
        const size = JSON.stringify(this.cache).length;
        return { size, documents };
    }
}
