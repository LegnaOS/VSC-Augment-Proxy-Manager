/**
 * RAG Context Index - 高效的本地代码检索系统
 *
 * 基于Augment日志逆向分析实现：
 * - MtimeCache: 基于修改时间的增量索引
 * - BlobStorage: SHA256去重的内容存储
 * - TF-IDF: 高效的文本相关性搜索
 * - CheckpointManager: 增量同步检查点
 *
 * 🔥 v0.10.0: 使用 LevelDB 替换 JSON 存储 (与 Augment 一致)
 * 🔥 v1.6.0: 混合搜索 (BM25 + 语义向量)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { KvStore } from './storage';
import { CodeStructure, generateLocalContext, LLMConfig } from './context-generator';
import { SemanticEmbeddings } from './embeddings';
import { VikingContextStore } from './viking-context';

// ============ 类型定义 ============

export interface IndexedDocument {
    path: string;           // 相对路径
    blobId: string;         // SHA256 hash
    mtime: number;          // 修改时间戳
    size: number;           // 文件大小
    tokens: string[];       // 分词结果
    termFreq: Map<string, number>;  // 词频
    // 🔥 v0.11.0: Contextual Embeddings 增强
    contextualContent?: string;     // LLM 生成的上下文描述
    codeStructure?: CodeStructure;  // 代码结构分析
}

export interface SearchResult {
    path: string;
    content: string;
    lineStart: number;
    lineEnd: number;
    score: number;
    highlights: string[];   // 匹配的关键词
    // 🔥 v0.11.0: Contextual Embeddings 增强
    contextualContent?: string;     // 上下文描述
    codeStructure?: CodeStructure;  // 代码结构
}

export interface RAGConfig {
    workspaceRoot: string;
    cacheDir: string;       // 缓存目录 (.augment-rag)
    maxFileSize: number;    // 最大文件大小 (默认 1MB)
    extensions: string[];   // 支持的扩展名
    ignoreDirs: string[];   // 忽略的目录
    checkpointThreshold: number;  // 检查点阈值 (默认 1000)
}

// ============ MtimeCache - 修改时间缓存 (LevelDB) ============

export class MtimeCache {
    private memCache: Map<string, number> = new Map();  // 内存缓存用于同步访问
    private store: KvStore;
    private dirty: boolean = false;
    private initialized: boolean = false;

    constructor(cacheDir: string) {
        this.store = new KvStore({ cacheDir, dbName: 'mtime-cache' });
    }

    async init(): Promise<void> {
        if (this.initialized) return;
        // 从 LevelDB 加载到内存缓存
        try {
            for await (const [key, value] of this.store.entries('mtime:')) {
                const filePath = key.slice(6);  // 移除 'mtime:' 前缀
                this.memCache.set(filePath, parseInt(value, 10));
            }
        } catch { /* 忽略加载错误 */ }
        this.initialized = true;
    }

    async save(): Promise<void> {
        if (!this.dirty) return;
        // 批量写入 LevelDB
        const ops: Array<{ type: 'put'; key: string; value: string }> = [];
        for (const [filePath, mtime] of this.memCache) {
            ops.push({ type: 'put', key: `mtime:${filePath}`, value: String(mtime) });
        }
        if (ops.length > 0) {
            await this.store.batch(ops);
        }
        this.dirty = false;
    }

    get(filePath: string): number | undefined {
        return this.memCache.get(filePath);
    }

    set(filePath: string, mtime: number): void {
        this.memCache.set(filePath, mtime);
        this.dirty = true;
    }

    delete(filePath: string): void {
        this.memCache.delete(filePath);
        this.dirty = true;
        // 异步删除 LevelDB
        this.store.delete(`mtime:${filePath}`).catch(() => {});
    }

    has(filePath: string): boolean {
        return this.memCache.has(filePath);
    }

    isModified(filePath: string, currentMtime: number): boolean {
        const cached = this.memCache.get(filePath);
        return cached === undefined || cached !== currentMtime;
    }

    size(): number {
        return this.memCache.size;
    }

    async clear(): Promise<void> {
        this.memCache.clear();
        this.dirty = false;
        await this.store.clear('mtime:');
    }

    async close(): Promise<void> {
        await this.save();
        await this.store.close();
    }
}

// ============ BlobStorage - 内容去重存储 (LevelDB) ============

export class BlobStorage {
    private blobCache: Map<string, string> = new Map();  // 热门 blob 内存缓存
    private pathToBlob: Map<string, string> = new Map();  // path -> blobId
    private kvStore: KvStore;
    private initialized: boolean = false;
    private dirty: boolean = false;
    private maxCacheSize: number = 500;  // 最多缓存500个blob在内存中

    constructor(cacheDir: string) {
        this.kvStore = new KvStore({ cacheDir, dbName: 'blob-storage' });
    }

    async init(): Promise<void> {
        if (this.initialized) return;
        // 只加载 path -> blobId 映射到内存
        try {
            for await (const [key, value] of this.kvStore.entries('path:')) {
                const filePath = key.slice(5);  // 移除 'path:' 前缀
                this.pathToBlob.set(filePath, value);
            }
        } catch { /* 忽略加载错误 */ }
        this.initialized = true;
    }

    async save(): Promise<void> {
        if (!this.dirty) return;
        // 批量保存 path -> blobId 映射
        const ops: Array<{ type: 'put'; key: string; value: string }> = [];
        for (const [filePath, blobId] of this.pathToBlob) {
            ops.push({ type: 'put', key: `path:${filePath}`, value: blobId });
        }
        if (ops.length > 0) {
            await this.kvStore.batch(ops);
        }
        this.dirty = false;
    }

    static computeHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    }

    async storeBlob(filePath: string, content: string): Promise<string> {
        const blobId = BlobStorage.computeHash(content);

        // 检查 blob 是否已存在
        if (!this.blobCache.has(blobId)) {
            const existing = await this.kvStore.get(`blob:${blobId}`);
            if (!existing) {
                // 新 blob，写入 LevelDB
                await this.kvStore.set(`blob:${blobId}`, content);
            }
            // 添加到内存缓存 (LRU)
            if (this.blobCache.size >= this.maxCacheSize) {
                const firstKey = this.blobCache.keys().next().value;
                if (firstKey) this.blobCache.delete(firstKey);
            }
            this.blobCache.set(blobId, content);
        }

        this.pathToBlob.set(filePath, blobId);
        this.dirty = true;
        return blobId;
    }

    // 同步版本用于兼容现有代码
    storeSync(filePath: string, content: string): string {
        const blobId = BlobStorage.computeHash(content);
        this.blobCache.set(blobId, content);
        this.pathToBlob.set(filePath, blobId);
        this.dirty = true;
        // 异步写入
        this.kvStore.set(`blob:${blobId}`, content).catch(() => {});
        return blobId;
    }

    async get(blobId: string): Promise<string | undefined> {
        // 先查内存缓存
        if (this.blobCache.has(blobId)) {
            return this.blobCache.get(blobId);
        }
        // 再查 LevelDB
        const content = await this.kvStore.get(`blob:${blobId}`);
        if (content) {
            // 添加到内存缓存
            if (this.blobCache.size >= this.maxCacheSize) {
                const firstKey = this.blobCache.keys().next().value;
                if (firstKey) this.blobCache.delete(firstKey);
            }
            this.blobCache.set(blobId, content);
        }
        return content;
    }

    // 同步版本 - 只从内存缓存获取
    getSync(blobId: string): string | undefined {
        return this.blobCache.get(blobId);
    }

    async getByPath(filePath: string): Promise<string | undefined> {
        const blobId = this.pathToBlob.get(filePath);
        return blobId ? await this.get(blobId) : undefined;
    }

    getByPathSync(filePath: string): string | undefined {
        const blobId = this.pathToBlob.get(filePath);
        return blobId ? this.blobCache.get(blobId) : undefined;
    }

    getBlobId(filePath: string): string | undefined {
        return this.pathToBlob.get(filePath);
    }

    delete(filePath: string): void {
        this.pathToBlob.delete(filePath);
        this.dirty = true;
        this.kvStore.delete(`path:${filePath}`).catch(() => {});
    }

    async close(): Promise<void> {
        await this.save();
        await this.kvStore.close();
    }
}

// ============ 查询缓存 - LRU实现 ============

export class QueryCache<T> {
    private cache: Map<string, { result: T; timestamp: number }> = new Map();
    private maxSize: number;
    private ttlMs: number;

    constructor(maxSize: number = 100, ttlMs: number = 60000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }

    get(key: string): T | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        // 检查是否过期
        if (Date.now() - entry.timestamp > this.ttlMs) {
            this.cache.delete(key);
            return undefined;
        }

        // LRU: 移到末尾
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.result;
    }

    set(key: string, result: T): void {
        // 如果已存在，先删除
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        // 如果达到最大容量，删除最老的
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) this.cache.delete(firstKey);
        }

        this.cache.set(key, { result, timestamp: Date.now() });
    }

    clear(): void {
        this.cache.clear();
    }

    size(): number {
        return this.cache.size;
    }
}

// ============ TF-IDF 搜索引擎 ============

// 代码相关的停用词
const CODE_STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for', 'on',
    'with', 'at', 'by', 'from', 'as', 'into', 'and', 'but', 'if', 'or',
    'var', 'let', 'const', 'function', 'class', 'return', 'import', 'export',
    'this', 'that', 'null', 'undefined', 'true', 'false', 'new', 'void',
    'public', 'private', 'protected', 'static', 'async', 'await', 'try',
    'catch', 'throw', 'finally', 'else', 'switch', 'case', 'break', 'continue'
]);

// 重要的入口文件名模式 - 这些文件应该获得更高权重
const IMPORTANT_FILE_PATTERNS = [
    /^index\.[jt]sx?$/i,
    /^main\.[jt]sx?$/i,
    /^app\.[jt]sx?$/i,
    /^server\.[jt]sx?$/i,
    /^extension\.[jt]s$/i,
    /^mod\.rs$/i,
    /^lib\.rs$/i,
    /^__init__\.py$/i,
    /package\.json$/i,
    /tsconfig\.json$/i
];

export class TFIDFEngine {
    private documents: Map<string, IndexedDocument> = new Map();
    private idf: Map<string, number> = new Map();  // 逆文档频率
    private store: KvStore;
    private queryCache: QueryCache<Array<{ path: string; score: number; matchedTerms: string[] }>>;
    private initialized: boolean = false;
    private dirty: boolean = false;

    constructor(cacheDir: string) {
        this.store = new KvStore({ cacheDir, dbName: 'tfidf-index' });
        this.queryCache = new QueryCache(100, 60000);  // 100条缓存，60秒过期
    }

    async init(): Promise<void> {
        if (this.initialized) return;
        try {
            // 加载 IDF 表
            const idfData = await this.store.get('meta:idf');
            if (idfData) {
                this.idf = new Map(Object.entries(JSON.parse(idfData)));
            }

            // 加载文档索引
            for await (const [key, value] of this.store.entries('doc:')) {
                const docPath = key.slice(4);  // 移除 'doc:' 前缀
                const d = JSON.parse(value);
                this.documents.set(docPath, {
                    ...d,
                    termFreq: new Map(Object.entries(d.termFreq || {}))
                });
            }
        } catch { /* 忽略加载错误 */ }
        this.initialized = true;
    }

    async save(): Promise<void> {
        if (!this.dirty) return;
        try {
            const ops: Array<{ type: 'put'; key: string; value: string }> = [];

            // 保存 IDF 表
            ops.push({
                type: 'put',
                key: 'meta:idf',
                value: JSON.stringify(Object.fromEntries(this.idf))
            });

            // 批量保存文档
            for (const [docPath, doc] of this.documents) {
                const serialized = {
                    ...doc,
                    termFreq: Object.fromEntries(doc.termFreq)
                };
                ops.push({ type: 'put', key: `doc:${docPath}`, value: JSON.stringify(serialized) });
            }

            await this.store.batch(ops);
            this.dirty = false;
        } catch { /* 忽略保存错误 */ }
    }

    // 同步保存 - 仅标记为脏，实际保存延迟到 close()
    saveSync(): void {
        this.dirty = true;
    }

    async close(): Promise<void> {
        await this.save();
        await this.store.close();
    }

    // 🔥 增强分词器 - 支持驼峰、下划线、代码符号、中文
    static tokenize(text: string): string[] {
        const tokens: string[] = [];
        const seen = new Set<string>();

        // 1. 提取完整的代码标识符 (保留原始形式)
        const identifiers = text.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) || [];
        for (const id of identifiers) {
            const lower = id.toLowerCase();
            if (lower.length >= 2 && !CODE_STOP_WORDS.has(lower) && !seen.has(lower)) {
                seen.add(lower);
                tokens.push(lower);
            }
        }

        // 2. 分割驼峰命名 (camelCase -> [camel, case])
        const camelSplit = text.replace(/([a-z])([A-Z])/g, '$1 $2');
        const camelWords = camelSplit.toLowerCase().match(/[a-z][a-z0-9]*/g) || [];
        for (const word of camelWords) {
            if (word.length >= 2 && !CODE_STOP_WORDS.has(word) && !seen.has(word)) {
                seen.add(word);
                tokens.push(word);
            }
        }

        // 3. 分割下划线命名 (snake_case -> [snake, case])
        const snakeParts = text.split(/[_\-]+/);
        for (const part of snakeParts) {
            const lower = part.toLowerCase();
            if (lower.length >= 2 && !CODE_STOP_WORDS.has(lower) && !seen.has(lower)) {
                seen.add(lower);
                tokens.push(lower);
            }
        }

        // 4. 提取中文词汇 - 🔥 增强：添加单字和双字组合
        const chinese = text.match(/[\u4e00-\u9fa5]+/g) || [];
        for (const word of chinese) {
            // 添加完整词组
            if (!seen.has(word)) {
                seen.add(word);
                tokens.push(word);
            }

            // 🔥 如果词组长度 >= 2，添加单个中文字
            if (word.length >= 2) {
                for (const char of word) {
                    if (!seen.has(char)) {
                        seen.add(char);
                        tokens.push(char);
                    }
                }
            }

            // 🔥 如果词组长度 >= 4，添加双字组合（模拟常见中文词汇）
            if (word.length >= 4) {
                for (let i = 0; i < word.length - 1; i++) {
                    const bigram = word.substring(i, i + 2);
                    if (!seen.has(bigram)) {
                        seen.add(bigram);
                        tokens.push(bigram);
                    }
                }
            }
        }

        // 5. 提取数字标识符 (如 v2, http2, utf8)
        const numericIds = text.match(/[a-z]+\d+|\d+[a-z]+/gi) || [];
        for (const id of numericIds) {
            const lower = id.toLowerCase();
            if (!seen.has(lower)) {
                seen.add(lower);
                tokens.push(lower);
            }
        }

        return tokens;
    }

    // 🔥 从查询中提取搜索词 (用于精确匹配加分)
    static extractExactTerms(query: string): string[] {
        const terms: string[] = [];

        // 提取引号中的精确匹配词
        const quoted = query.match(/"([^"]+)"/g) || [];
        for (const q of quoted) {
            terms.push(q.replace(/"/g, '').toLowerCase());
        }

        // 提取看起来像代码标识符的词
        const identifiers = query.match(/[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g) || [];
        for (const id of identifiers) {
            terms.push(id.toLowerCase());
        }

        return [...new Set(terms)];
    }

    // 计算词频
    static computeTermFreq(tokens: string[]): Map<string, number> {
        const freq = new Map<string, number>();
        for (const token of tokens) {
            freq.set(token, (freq.get(token) || 0) + 1);
        }
        return freq;
    }

    // 添加文档到索引
    addDocument(doc: IndexedDocument): void {
        this.documents.set(doc.path, doc);
    }

    // 删除文档
    removeDocument(filePath: string): void {
        this.documents.delete(filePath);
    }

    // 重新计算IDF
    rebuildIDF(): void {
        const docCount = this.documents.size;
        if (docCount === 0) return;

        const docFreq = new Map<string, number>();

        for (const doc of this.documents.values()) {
            const uniqueTerms = new Set(doc.tokens);
            for (const term of uniqueTerms) {
                docFreq.set(term, (docFreq.get(term) || 0) + 1);
            }
        }

        this.idf.clear();
        for (const [term, freq] of docFreq) {
            // IDF = log(N / df) + 1
            this.idf.set(term, Math.log(docCount / freq) + 1);
        }
    }

    // 🔥 增强搜索 - 支持缓存、权重加成
    search(query: string, topK: number = 10): Array<{ path: string; score: number; matchedTerms: string[] }> {
        // 检查缓存
        const cacheKey = `${query}:${topK}`;
        const cached = this.queryCache.get(cacheKey);
        if (cached) return cached;

        const queryTokens = TFIDFEngine.tokenize(query);
        if (queryTokens.length === 0) return [];

        const queryTermFreq = TFIDFEngine.computeTermFreq(queryTokens);
        const exactTerms = TFIDFEngine.extractExactTerms(query);
        const results: Array<{ path: string; score: number; matchedTerms: string[] }> = [];

        for (const [docPath, doc] of this.documents) {
            let score = 0;
            const matchedTerms: string[] = [];

            // 1. 基础TF-IDF分数
            for (const [term, queryFreq] of queryTermFreq) {
                const docFreq = doc.termFreq.get(term) || 0;
                if (docFreq > 0) {
                    const idf = this.idf.get(term) || 1;
                    const tf = docFreq / doc.tokens.length;
                    score += tf * idf * queryFreq;
                    matchedTerms.push(term);
                }
            }

            if (score > 0) {
                // 2. 🔥 文件名匹配加成
                const fileName = path.basename(docPath).toLowerCase();
                const fileNameNoExt = fileName.replace(/\.[^.]+$/, '');
                for (const term of exactTerms) {
                    if (fileName.includes(term) || fileNameNoExt.includes(term)) {
                        score *= 2.0;  // 文件名匹配，分数翻倍
                        break;
                    }
                }

                // 3. 🔥 路径匹配加成 (目录名包含关键词)
                const pathLower = docPath.toLowerCase();
                for (const term of exactTerms) {
                    if (pathLower.includes('/' + term + '/') || pathLower.includes('\\' + term + '\\')) {
                        score *= 1.3;  // 路径包含关键词，加30%
                        break;
                    }
                }

                // 4. 🔥 重要文件加成
                for (const pattern of IMPORTANT_FILE_PATTERNS) {
                    if (pattern.test(fileName)) {
                        score *= 1.5;  // 入口文件加50%
                        break;
                    }
                }

                // 5. 🔥 匹配词数量加成
                if (matchedTerms.length >= 3) {
                    score *= 1.2;  // 匹配3个以上关键词，加20%
                }

                results.push({ path: docPath, score, matchedTerms });
            }
        }

        // 按分数排序
        results.sort((a, b) => b.score - a.score);
        const finalResults = results.slice(0, topK);

        // 缓存结果
        this.queryCache.set(cacheKey, finalResults);

        return finalResults;
    }

    // 清除查询缓存 (在索引更新时调用)
    clearCache(): void {
        this.queryCache.clear();
    }

    getDocument(filePath: string): IndexedDocument | undefined {
        return this.documents.get(filePath);
    }

    // 🔥 v1.6.0: 获取所有文档（用于语义搜索）
    getAllDocuments(): Map<string, IndexedDocument> {
        return this.documents;
    }

    size(): number {
        return this.documents.size;
    }
}

// ============ RAG Context Index - 主类 ============

export class RAGContextIndex {
    private config: RAGConfig;
    private mtimeCache: MtimeCache;
    private blobStorage: BlobStorage;
    private tfidfEngine: TFIDFEngine;
    private semanticEngine: SemanticEmbeddings | null = null;
    private vikingStore: VikingContextStore | null = null;  // v2.0.0: Viking 分层上下文
    private checkpointId: number = 0;
    private pendingChanges: number = 0;
    private initialized: boolean = false;
    private storageReady: boolean = false;
    private onProgress?: (status: string) => void;

    constructor(config: Partial<RAGConfig> & { workspaceRoot: string }, onProgress?: (status: string) => void) {
        this.onProgress = onProgress;
        this.config = {
            workspaceRoot: config.workspaceRoot,
            cacheDir: config.cacheDir || path.join(config.workspaceRoot, '.augment-rag'),
            maxFileSize: config.maxFileSize || 1024 * 1024,
            extensions: config.extensions || [
                '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
                '.py', '.pyw',
                '.go', '.rs', '.java', '.kt', '.scala',
                '.c', '.cpp', '.cc', '.h', '.hpp',
                '.cs', '.rb', '.php', '.swift',
                '.vue', '.svelte', '.astro',
                '.json', '.yaml', '.yml', '.toml',
                '.md', '.mdx', '.txt',
                '.sql', '.graphql', '.prisma',
                '.sh', '.bash', '.zsh', '.fish',
                '.dockerfile', '.containerfile'
            ],
            ignoreDirs: config.ignoreDirs || [
                'node_modules', '.git', 'dist', 'build', 'out',
                '.next', '.nuxt', '.output',
                '__pycache__', '.venv', 'venv', '.env',
                'target', 'bin', 'obj',
                '.augment-rag', '.augment'
            ],
            checkpointThreshold: config.checkpointThreshold || 1000
        };

        this.mtimeCache = new MtimeCache(this.config.cacheDir);
        this.blobStorage = new BlobStorage(this.config.cacheDir);
        this.tfidfEngine = new TFIDFEngine(this.config.cacheDir);
        this.semanticEngine = null;
    }

    setSemanticEngine(engine: SemanticEmbeddings): void {
        this.semanticEngine = engine;
        this.onProgress?.('[RAG] Semantic engine configured');
    }

    // v2.0.0: 设置 Viking 分层上下文存储
    setVikingStore(store: VikingContextStore): void {
        this.vikingStore = store;
        this.onProgress?.('[RAG] Viking context store configured');
    }

    getVikingStore(): VikingContextStore | null { return this.vikingStore; }

    // 🔥 v1.7.1: 预加载所有文档嵌入（语义搜索）
    async preloadEmbeddings(onProgress?: (current: number, total: number) => void): Promise<void> {
        if (!this.semanticEngine?.isAvailable()) {
            this.onProgress?.('[RAG] Semantic engine not available, skipping preload');
            return;
        }

        // 收集所有文档
        const documents: Array<{ path: string; content: string; hash: string }> = [];
        for (const [docPath, doc] of this.getAllDocuments()) {
            const content = await this.blobStorage.get(doc.blobId);
            if (content) {
                documents.push({ path: docPath, content, hash: doc.blobId });
            }
        }

        if (documents.length === 0) {
            this.onProgress?.('[RAG] No documents to preload');
            return;
        }

        this.onProgress?.(`[RAG] Preloading embeddings for ${documents.length} documents...`);
        await this.semanticEngine.preloadEmbeddings(documents, onProgress);
    }

    // 🔥 初始化 LevelDB 存储层
    async initStorage(): Promise<void> {
        if (this.storageReady) return;
        await Promise.all([
            this.mtimeCache.init(),
            this.blobStorage.init(),
            this.tfidfEngine.init()
        ]);
        this.loadCheckpoint();
        this.storageReady = true;
    }

    private loadCheckpoint(): void {
        try {
            const cpFile = path.join(this.config.cacheDir, 'checkpoint.json');
            if (fs.existsSync(cpFile)) {
                const data = JSON.parse(fs.readFileSync(cpFile, 'utf-8'));
                this.checkpointId = data.checkpointId || 0;
            }
        } catch { /* 忽略 */ }
    }

    private saveCheckpoint(): void {
        try {
            const dir = this.config.cacheDir;
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const cpFile = path.join(dir, 'checkpoint.json');
            fs.writeFileSync(cpFile, JSON.stringify({
                checkpointId: this.checkpointId,
                timestamp: Date.now(),
                documentCount: this.tfidfEngine.size()
            }));
        } catch { /* 忽略 */ }
    }

    // 初始化索引 - 扫描工作区
    async initialize(onProgress?: (current: number, total: number) => void): Promise<void> {
        if (this.initialized) return;

        // 确保存储层已初始化
        await this.initStorage();

        const files = this.scanFiles(this.config.workspaceRoot);
        const total = files.length;
        let processed = 0;
        let indexed = 0;

        for (const file of files) {
            try {
                const stat = fs.statSync(file);
                const mtime = stat.mtimeMs;
                const relativePath = path.relative(this.config.workspaceRoot, file);

                // 检查是否需要重新索引
                if (!this.mtimeCache.isModified(relativePath, mtime)) {
                    processed++;
                    continue;
                }

                // 读取并索引文件
                if (stat.size <= this.config.maxFileSize) {
                    const content = fs.readFileSync(file, 'utf-8');
                    await this.indexFile(relativePath, content, mtime, stat.size);
                    indexed++;
                }

                this.mtimeCache.set(relativePath, mtime);
                processed++;

                if (onProgress && processed % 100 === 0) {
                    onProgress(processed, total);
                }
            } catch { /* 忽略单个文件错误 */ }
        }

        // 重建IDF并保存
        this.tfidfEngine.rebuildIDF();
        await this.save();
        this.initialized = true;
    }

    // 扫描文件（支持 iCloud 和网络路径）
    private scanFiles(dir: string, depth: number = 0, visitedPaths: Set<string> = new Set()): string[] {
        if (depth > 15) return [];  // 最大深度限制

        // 🔥 解析真实路径（处理符号链接，特别是 iCloud）
        let realDir: string;
        try {
            realDir = fs.realpathSync(dir);
        } catch {
            realDir = dir;
        }

        // 🔥 防止循环引用（符号链接可能导致）
        if (visitedPaths.has(realDir)) {
            return [];
        }
        visitedPaths.add(realDir);

        const results: string[] = [];
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (this.config.ignoreDirs.includes(item)) continue;
                if (item.startsWith('.') && item !== '.github') continue;

                const fullPath = path.join(dir, item);
                try {
                    // 🔥 使用 lstatSync 检测符号链接，然后用 statSync 获取实际文件信息
                    const lstat = fs.lstatSync(fullPath);

                    if (lstat.isSymbolicLink()) {
                        // 解析符号链接目标
                        try {
                            const realPath = fs.realpathSync(fullPath);
                            const realStat = fs.statSync(realPath);

                            if (realStat.isDirectory()) {
                                results.push(...this.scanFiles(fullPath, depth + 1, visitedPaths));
                            } else if (realStat.isFile()) {
                                const ext = path.extname(item).toLowerCase();
                                if (this.config.extensions.includes(ext) || ext === '') {
                                    results.push(fullPath);  // 使用原始路径，保持一致性
                                }
                            }
                        } catch { /* 符号链接目标不存在或无权限 */ }
                    } else if (lstat.isDirectory()) {
                        results.push(...this.scanFiles(fullPath, depth + 1, visitedPaths));
                    } else if (lstat.isFile()) {
                        const ext = path.extname(item).toLowerCase();
                        if (this.config.extensions.includes(ext) || ext === '') {
                            results.push(fullPath);
                        }
                    }
                } catch { /* 忽略权限错误 */ }
            }
        } catch { /* 忽略权限错误 */ }
        return results;
    }

    // 索引单个文件
    private async indexFile(relativePath: string, content: string, mtime: number, size: number): Promise<void> {
        const blobId = this.blobStorage.storeSync(relativePath, content);  // 使用同步版本

        // 🔥 v0.11.0: 生成代码结构和上下文描述
        const { context: contextualContent, codeStructure } = generateLocalContext(content, relativePath);

        // 将上下文描述和原始内容合并用于 tokenize
        // 这样搜索时可以匹配上下文关键词
        const contentWithContext = `${contextualContent}\n\n${content}`;
        const tokens = TFIDFEngine.tokenize(contentWithContext);
        const termFreq = TFIDFEngine.computeTermFreq(tokens);

        const doc: IndexedDocument = {
            path: relativePath,
            blobId,
            mtime,
            size,
            tokens,
            termFreq,
            contextualContent,
            codeStructure
        };

        this.tfidfEngine.addDocument(doc);
        this.pendingChanges++;

        // 达到检查点阈值时保存
        if (this.pendingChanges >= this.config.checkpointThreshold) {
            await this.checkpoint();
        }
    }

    // 创建检查点
    async checkpoint(): Promise<void> {
        this.checkpointId++;
        await this.save();
        this.pendingChanges = 0;
    }

    // 保存所有缓存 (异步)
    async save(): Promise<void> {
        await Promise.all([
            this.mtimeCache.save(),
            this.blobStorage.save(),
            this.tfidfEngine.save()
        ]);
        this.saveCheckpoint();
    }

    async close(): Promise<void> {
        const tasks: Promise<void>[] = [
            this.mtimeCache.close(),
            this.blobStorage.close(),
            this.tfidfEngine.close()
        ];
        if (this.vikingStore) tasks.push(this.vikingStore.close());
        await Promise.all(tasks);
    }

    // v2.0.0: Viking 增强搜索 — 向量初筛 → 目录聚合 → 递归下钻 → 结果整合
    async searchAsync(query: string, topK: number = 10): Promise<SearchResult[]> {
        if (this.semanticEngine?.isAvailable()) {
            // Step 1: 向量初筛 — 取 topK * 3 的粗选结果
            const initialResults = await this.semanticSearch(query, topK * 3);

            // Step 2: 目录聚合 — 统计每个目录的命中数和总分
            if (initialResults.length > topK && this.vikingStore) {
                const dirScores = new Map<string, { score: number; count: number; paths: string[] }>();
                for (const r of initialResults) {
                    const dir = path.dirname(r.path);
                    const entry = dirScores.get(dir) || { score: 0, count: 0, paths: [] };
                    entry.score += r.score;
                    entry.count++;
                    entry.paths.push(r.path);
                    dirScores.set(dir, entry);
                }

                // Step 3: 找到得分最高的目录们（top 3）
                const topDirs = [...dirScores.entries()]
                    .sort((a, b) => b[1].score - a[1].score)
                    .slice(0, 3);

                // Step 4: 递归下钻 — 从高分目录中取更多文件
                const boostedPaths = new Set<string>();
                for (const [dir] of topDirs) {
                    // 获取该目录下所有文件，加入候选
                    const allDocs = this.getAllDocuments();
                    for (const [docPath] of allDocs) {
                        if (docPath.startsWith(dir + '/') || docPath.startsWith(dir + '\\')) {
                            boostedPaths.add(docPath);
                        }
                    }
                }

                // Step 5: 合并结果 — 高分目录的文件加权
                const resultSet = new Map<string, SearchResult>();
                for (const r of initialResults) {
                    resultSet.set(r.path, r);
                }
                // 来自高分目录但不在初筛结果中的文件，用 BM25 补分
                for (const p of boostedPaths) {
                    if (!resultSet.has(p)) {
                        // 目录关联性加权 — 同目录文件获得一个基础分
                        const dirBonus = 0.3;
                        const content = await this.blobStorage.getByPath(p);
                        if (content) {
                            const queryTerms = TFIDFEngine.tokenize(query);
                            const snippet = this.extractBestSnippet(content, queryTerms);
                            if (snippet) {
                                resultSet.set(p, {
                                    path: p,
                                    content: snippet.content,
                                    lineStart: snippet.lineStart,
                                    lineEnd: snippet.lineEnd,
                                    score: dirBonus,
                                    highlights: queryTerms,
                                });
                            }
                        }
                    }
                }

                return [...resultSet.values()]
                    .sort((a, b) => b.score - a.score)
                    .slice(0, topK);
            }

            return initialResults.slice(0, topK);
        }
        return this.search(query, topK);
    }

    // v1.6.0: 纯语义搜索
    private async semanticSearch(query: string, topK: number): Promise<SearchResult[]> {
        if (!this.semanticEngine) return [];

        // 收集所有文档
        const documents: Array<{ path: string; content: string; hash: string }> = [];
        for (const [docPath, doc] of this.getAllDocuments()) {
            const content = await this.blobStorage.get(doc.blobId);
            if (content) {
                documents.push({ path: docPath, content, hash: doc.blobId });
            }
        }

        // 执行语义搜索
        const semanticResults = await this.semanticEngine.semanticSearch(query, documents, topK * 2);
        const results: SearchResult[] = [];

        for (const result of semanticResults) {
            const content = await this.blobStorage.getByPath(result.path);
            if (!content) continue;

            const doc = this.tfidfEngine.getDocument(result.path);
            // 语义搜索用查询词作为高亮
            const queryTerms = TFIDFEngine.tokenize(query);
            const snippet = this.extractBestSnippet(content, queryTerms);

            if (snippet) {
                results.push({
                    path: result.path,
                    content: snippet.content,
                    lineStart: snippet.lineStart,
                    lineEnd: snippet.lineEnd,
                    score: result.score,
                    highlights: queryTerms,
                    contextualContent: doc?.contextualContent,
                    codeStructure: doc?.codeStructure
                });
            }
        }

        return results.slice(0, topK);
    }

    // 🔥 v1.6.0: 获取所有文档（用于语义搜索）
    private getAllDocuments(): Map<string, IndexedDocument> {
        return this.tfidfEngine.getAllDocuments();
    }

    // 搜索 (BM25，同步版本 - 作为降级方案)
    search(query: string, topK: number = 10): SearchResult[] {
        const tfidfResults = this.tfidfEngine.search(query, topK * 2);
        const results: SearchResult[] = [];

        for (const result of tfidfResults) {
            const content = this.blobStorage.getByPathSync(result.path);
            if (!content) continue;

            // 🔥 v0.11.0: 获取文档的上下文描述和代码结构
            const doc = this.tfidfEngine.getDocument(result.path);

            // 找到最相关的代码片段
            const snippet = this.extractBestSnippet(content, result.matchedTerms);
            if (snippet) {
                results.push({
                    path: result.path,
                    content: snippet.content,
                    lineStart: snippet.lineStart,
                    lineEnd: snippet.lineEnd,
                    score: result.score,
                    highlights: result.matchedTerms,
                    // 🔥 v0.11.0: 添加上下文信息
                    contextualContent: doc?.contextualContent,
                    codeStructure: doc?.codeStructure
                });
            }
        }

        return results.slice(0, topK);
    }

    // 提取最佳代码片段
    private extractBestSnippet(content: string, matchedTerms: string[]): { content: string; lineStart: number; lineEnd: number } | null {
        const lines = content.split('\n');
        const lineScores: Array<{ lineNum: number; score: number }> = [];

        // 计算每行的匹配分数
        for (let i = 0; i < lines.length; i++) {
            const lineLower = lines[i].toLowerCase();
            let score = 0;
            for (const term of matchedTerms) {
                if (lineLower.includes(term)) {
                    score += 1;
                    // 完整单词匹配加分
                    const regex = new RegExp(`\\b${term}\\b`, 'i');
                    if (regex.test(lines[i])) {
                        score += 0.5;
                    }
                }
            }
            if (score > 0) {
                lineScores.push({ lineNum: i, score });
            }
        }

        if (lineScores.length === 0) {
            // 没有匹配，返回文件开头
            const endLine = Math.min(30, lines.length);
            return {
                content: lines.slice(0, endLine).join('\n'),
                lineStart: 1,
                lineEnd: endLine
            };
        }

        // 找到分数最高的行
        lineScores.sort((a, b) => b.score - a.score);
        const bestLine = lineScores[0].lineNum;

        // 提取上下文 (前后各15行)
        const contextBefore = 15;
        const contextAfter = 15;
        const startLine = Math.max(0, bestLine - contextBefore);
        const endLine = Math.min(lines.length, bestLine + contextAfter + 1);

        return {
            content: lines.slice(startLine, endLine).join('\n'),
            lineStart: startLine + 1,
            lineEnd: endLine
        };
    }

    // 增量更新 - 添加或更新文件
    async addToIndex(filePath: string): Promise<void> {
        try {
            const fullPath = path.join(this.config.workspaceRoot, filePath);
            const stat = fs.statSync(fullPath);

            if (stat.size > this.config.maxFileSize) return;

            const content = fs.readFileSync(fullPath, 'utf-8');
            await this.indexFile(filePath, content, stat.mtimeMs, stat.size);
            this.mtimeCache.set(filePath, stat.mtimeMs);
            this.tfidfEngine.rebuildIDF();
            this.tfidfEngine.clearCache();
        } catch { /* 忽略错误 */ }
    }

    // 🔥 增量更新 - 添加内容（用于batch-upload）
    async addContentToIndex(filePath: string, content: string): Promise<void> {
        try {
            if (content.length > this.config.maxFileSize) return;

            const mtime = Date.now();
            await this.indexFile(filePath, content, mtime, content.length);
            this.mtimeCache.set(filePath, mtime);
            this.tfidfEngine.rebuildIDF();
            this.tfidfEngine.clearCache();
        } catch { /* 忽略错误 */ }
    }

    // 增量更新 - 删除文件
    removeFromIndex(filePath: string): void {
        this.tfidfEngine.removeDocument(filePath);
        this.blobStorage.delete(filePath);
        this.mtimeCache.delete(filePath);
        this.tfidfEngine.rebuildIDF();
        this.tfidfEngine.clearCache();
    }

    // 🔥 批量添加到索引（用于batch-upload）
    async addBatchToIndex(files: Array<{ path: string; content: string }>): Promise<number> {
        let indexed = 0;
        for (const file of files) {
            try {
                if (file.content.length <= this.config.maxFileSize) {
                    const mtime = Date.now();
                    await this.indexFile(file.path, file.content, mtime, file.content.length);
                    this.mtimeCache.set(file.path, mtime);
                    indexed++;
                }
            } catch { /* 忽略单个文件错误 */ }
        }

        if (indexed > 0) {
            this.tfidfEngine.rebuildIDF();
            this.tfidfEngine.clearCache();
            await this.save();
        }

        return indexed;
    }

    // 获取统计信息
    getStats(): { documentCount: number; checkpointId: number; cacheSize: number } {
        return {
            documentCount: this.tfidfEngine.size(),
            checkpointId: this.checkpointId,
            cacheSize: this.mtimeCache.size()
        };
    }

    // 导出索引到文件
    exportToFile(filePath: string): void {
        const data = {
            version: 1,
            workspaceRoot: this.config.workspaceRoot,
            checkpointId: this.checkpointId,
            timestamp: Date.now()
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }

    // 清除索引
    async clear(): Promise<void> {
        await this.mtimeCache.clear();
        this.tfidfEngine = new TFIDFEngine(this.config.cacheDir);
        this.blobStorage = new BlobStorage(this.config.cacheDir);
        this.checkpointId = 0;
        this.pendingChanges = 0;
        this.initialized = false;
        this.storageReady = false;
    }
}

