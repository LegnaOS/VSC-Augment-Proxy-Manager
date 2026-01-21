/**
 * RAG Context Index - 高效的本地代码检索系统
 * 
 * 基于Augment日志逆向分析实现：
 * - MtimeCache: 基于修改时间的增量索引
 * - BlobStorage: SHA256去重的内容存储
 * - TF-IDF: 高效的文本相关性搜索
 * - CheckpointManager: 增量同步检查点
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ============ 类型定义 ============

export interface IndexedDocument {
    path: string;           // 相对路径
    blobId: string;         // SHA256 hash
    mtime: number;          // 修改时间戳
    size: number;           // 文件大小
    tokens: string[];       // 分词结果
    termFreq: Map<string, number>;  // 词频
}

export interface SearchResult {
    path: string;
    content: string;
    lineStart: number;
    lineEnd: number;
    score: number;
    highlights: string[];   // 匹配的关键词
}

export interface RAGConfig {
    workspaceRoot: string;
    cacheDir: string;       // 缓存目录 (.augment-rag)
    maxFileSize: number;    // 最大文件大小 (默认 1MB)
    extensions: string[];   // 支持的扩展名
    ignoreDirs: string[];   // 忽略的目录
    checkpointThreshold: number;  // 检查点阈值 (默认 1000)
}

// ============ MtimeCache - 修改时间缓存 ============

export class MtimeCache {
    private cache: Map<string, number> = new Map();
    private cacheFile: string;
    private dirty: boolean = false;

    constructor(cacheDir: string) {
        this.cacheFile = path.join(cacheDir, 'mtime-cache.json');
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.cacheFile)) {
                const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
                this.cache = new Map(Object.entries(data));
            }
        } catch { /* 忽略加载错误 */ }
    }

    save(): void {
        if (!this.dirty) return;
        try {
            const dir = path.dirname(this.cacheFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const obj = Object.fromEntries(this.cache);
            fs.writeFileSync(this.cacheFile, JSON.stringify(obj, null, 2));
            this.dirty = false;
        } catch { /* 忽略保存错误 */ }
    }

    get(filePath: string): number | undefined {
        return this.cache.get(filePath);
    }

    set(filePath: string, mtime: number): void {
        this.cache.set(filePath, mtime);
        this.dirty = true;
    }

    delete(filePath: string): void {
        this.cache.delete(filePath);
        this.dirty = true;
    }

    has(filePath: string): boolean {
        return this.cache.has(filePath);
    }

    isModified(filePath: string, currentMtime: number): boolean {
        const cached = this.cache.get(filePath);
        return cached === undefined || cached !== currentMtime;
    }

    size(): number {
        return this.cache.size;
    }

    clear(): void {
        this.cache.clear();
        this.dirty = true;
    }
}

// ============ BlobStorage - 内容去重存储 ============

export class BlobStorage {
    private blobs: Map<string, string> = new Map();  // blobId -> content
    private pathToBlob: Map<string, string> = new Map();  // path -> blobId
    private blobFile: string;

    constructor(cacheDir: string) {
        this.blobFile = path.join(cacheDir, 'blobs.json');
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.blobFile)) {
                const data = JSON.parse(fs.readFileSync(this.blobFile, 'utf-8'));
                this.blobs = new Map(Object.entries(data.blobs || {}));
                this.pathToBlob = new Map(Object.entries(data.pathToBlob || {}));
            }
        } catch { /* 忽略加载错误 */ }
    }

    save(): void {
        try {
            const dir = path.dirname(this.blobFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const data = {
                blobs: Object.fromEntries(this.blobs),
                pathToBlob: Object.fromEntries(this.pathToBlob)
            };
            fs.writeFileSync(this.blobFile, JSON.stringify(data));
        } catch { /* 忽略保存错误 */ }
    }

    static computeHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    }

    store(filePath: string, content: string): string {
        const blobId = BlobStorage.computeHash(content);
        if (!this.blobs.has(blobId)) {
            this.blobs.set(blobId, content);
        }
        this.pathToBlob.set(filePath, blobId);
        return blobId;
    }

    get(blobId: string): string | undefined {
        return this.blobs.get(blobId);
    }

    getByPath(filePath: string): string | undefined {
        const blobId = this.pathToBlob.get(filePath);
        return blobId ? this.blobs.get(blobId) : undefined;
    }

    getBlobId(filePath: string): string | undefined {
        return this.pathToBlob.get(filePath);
    }

    delete(filePath: string): void {
        this.pathToBlob.delete(filePath);
        // 注意：不删除blob本身，因为可能被其他文件引用
    }
}

// ============ TF-IDF 搜索引擎 ============

export class TFIDFEngine {
    private documents: Map<string, IndexedDocument> = new Map();
    private idf: Map<string, number> = new Map();  // 逆文档频率
    private indexFile: string;

    constructor(cacheDir: string) {
        this.indexFile = path.join(cacheDir, 'tfidf-index.json');
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.indexFile)) {
                const data = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));
                for (const [path, doc] of Object.entries(data.documents || {})) {
                    const d = doc as any;
                    this.documents.set(path, {
                        ...d,
                        termFreq: new Map(Object.entries(d.termFreq || {}))
                    });
                }
                this.idf = new Map(Object.entries(data.idf || {}));
            }
        } catch { /* 忽略加载错误 */ }
    }

    save(): void {
        try {
            const dir = path.dirname(this.indexFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const docs: any = {};
            for (const [path, doc] of this.documents) {
                docs[path] = {
                    ...doc,
                    termFreq: Object.fromEntries(doc.termFreq)
                };
            }
            const data = {
                documents: docs,
                idf: Object.fromEntries(this.idf)
            };
            fs.writeFileSync(this.indexFile, JSON.stringify(data));
        } catch { /* 忽略保存错误 */ }
    }

    // 分词器 - 支持驼峰、下划线、中文
    static tokenize(text: string): string[] {
        const tokens: string[] = [];

        // 1. 分割驼峰命名 (camelCase -> camel, case)
        text = text.replace(/([a-z])([A-Z])/g, '$1 $2');

        // 2. 分割下划线和连字符
        text = text.replace(/[_\-]/g, ' ');

        // 3. 提取单词和中文字符
        const words = text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5]+/g) || [];

        for (const word of words) {
            if (word.length >= 2) {  // 忽略单字符
                tokens.push(word);
            }
        }

        return tokens;
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

    // 搜索 - 返回TF-IDF分数最高的文档
    search(query: string, topK: number = 10): Array<{ path: string; score: number; matchedTerms: string[] }> {
        const queryTokens = TFIDFEngine.tokenize(query);
        if (queryTokens.length === 0) return [];

        const queryTermFreq = TFIDFEngine.computeTermFreq(queryTokens);
        const results: Array<{ path: string; score: number; matchedTerms: string[] }> = [];

        for (const [docPath, doc] of this.documents) {
            let score = 0;
            const matchedTerms: string[] = [];

            for (const [term, queryFreq] of queryTermFreq) {
                const docFreq = doc.termFreq.get(term) || 0;
                if (docFreq > 0) {
                    const idf = this.idf.get(term) || 1;
                    // TF-IDF = tf * idf
                    const tf = docFreq / doc.tokens.length;
                    score += tf * idf * queryFreq;
                    matchedTerms.push(term);
                }
            }

            if (score > 0) {
                results.push({ path: docPath, score, matchedTerms });
            }
        }

        // 按分数排序
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }

    getDocument(filePath: string): IndexedDocument | undefined {
        return this.documents.get(filePath);
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
    private checkpointId: number = 0;
    private pendingChanges: number = 0;
    private initialized: boolean = false;

    constructor(config: Partial<RAGConfig> & { workspaceRoot: string }) {
        this.config = {
            workspaceRoot: config.workspaceRoot,
            cacheDir: config.cacheDir || path.join(config.workspaceRoot, '.augment-rag'),
            maxFileSize: config.maxFileSize || 1024 * 1024,  // 1MB
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

        this.loadCheckpoint();
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
                    this.indexFile(relativePath, content, mtime, stat.size);
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
        this.save();
        this.initialized = true;
    }

    // 扫描文件
    private scanFiles(dir: string, depth: number = 0): string[] {
        if (depth > 15) return [];  // 最大深度限制

        const results: string[] = [];
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (this.config.ignoreDirs.includes(item)) continue;
                if (item.startsWith('.') && item !== '.github') continue;

                const fullPath = path.join(dir, item);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        results.push(...this.scanFiles(fullPath, depth + 1));
                    } else if (stat.isFile()) {
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
    private indexFile(relativePath: string, content: string, mtime: number, size: number): void {
        const blobId = this.blobStorage.store(relativePath, content);
        const tokens = TFIDFEngine.tokenize(content);
        const termFreq = TFIDFEngine.computeTermFreq(tokens);

        const doc: IndexedDocument = {
            path: relativePath,
            blobId,
            mtime,
            size,
            tokens,
            termFreq
        };

        this.tfidfEngine.addDocument(doc);
        this.pendingChanges++;

        // 达到检查点阈值时保存
        if (this.pendingChanges >= this.config.checkpointThreshold) {
            this.checkpoint();
        }
    }

    // 创建检查点
    checkpoint(): void {
        this.checkpointId++;
        this.save();
        this.pendingChanges = 0;
    }

    // 保存所有缓存
    save(): void {
        this.mtimeCache.save();
        this.blobStorage.save();
        this.tfidfEngine.save();
        this.saveCheckpoint();
    }

    // 搜索
    search(query: string, topK: number = 10): SearchResult[] {
        const tfidfResults = this.tfidfEngine.search(query, topK * 2);
        const results: SearchResult[] = [];

        for (const result of tfidfResults) {
            const content = this.blobStorage.getByPath(result.path);
            if (!content) continue;

            // 找到最相关的代码片段
            const snippet = this.extractBestSnippet(content, result.matchedTerms);
            if (snippet) {
                results.push({
                    path: result.path,
                    content: snippet.content,
                    lineStart: snippet.lineStart,
                    lineEnd: snippet.lineEnd,
                    score: result.score,
                    highlights: result.matchedTerms
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
    addToIndex(filePath: string): void {
        try {
            const fullPath = path.join(this.config.workspaceRoot, filePath);
            const stat = fs.statSync(fullPath);

            if (stat.size > this.config.maxFileSize) return;

            const content = fs.readFileSync(fullPath, 'utf-8');
            this.indexFile(filePath, content, stat.mtimeMs, stat.size);
            this.mtimeCache.set(filePath, stat.mtimeMs);
            this.tfidfEngine.rebuildIDF();
        } catch { /* 忽略错误 */ }
    }

    // 增量更新 - 删除文件
    removeFromIndex(filePath: string): void {
        this.tfidfEngine.removeDocument(filePath);
        this.blobStorage.delete(filePath);
        this.mtimeCache.delete(filePath);
        this.tfidfEngine.rebuildIDF();
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
    clear(): void {
        this.mtimeCache.clear();
        this.tfidfEngine = new TFIDFEngine(this.config.cacheDir);
        this.blobStorage = new BlobStorage(this.config.cacheDir);
        this.checkpointId = 0;
        this.pendingChanges = 0;
        this.initialized = false;
    }
}

