/**
 * Viking Tiered Context System — 基于 OpenViking 的分层上下文管理
 *
 * L0: ~100 tokens 摘要（代码结构 + 类型签名）— 适合批量注入 system prompt
 * L1: ~2k tokens 概要（上下文描述 + 关键代码元素 + imports/exports）
 * L2: 完整内容（按需加载，不缓存在内存中）
 *
 * URI 寻址: viking://resource/{relative-path}
 */

import { KvStore } from './storage';
import { parseCodeStructure, generateLocalContext, CodeStructure } from './context-generator';
import * as path from 'path';

export interface VikingTier {
    l0: string;   // ~100 tokens: 一句话摘要
    l1: string;   // ~2k tokens: 详细概要
    // l2 = 原始内容，不存储（从 BlobStorage 按需读取）
    structure: CodeStructure;
    hash: string;        // 内容 hash，用于失效检测
    updatedAt: number;
}

export interface VikingContextStats {
    totalResources: number;
    l0TotalTokens: number;
    l1TotalTokens: number;
}

export class VikingContextStore {
    private store: KvStore;
    private memCache: Map<string, VikingTier> = new Map();
    private ready: boolean = false;

    constructor(cacheDir: string) {
        this.store = new KvStore({ cacheDir, dbName: 'viking-context' });
    }

    async init(): Promise<void> {
        await this.store.ensureReady();
        // 预加载所有 viking tier 到内存
        for await (const [key, value] of this.store.entries('vk:')) {
            try {
                const filePath = key.slice(3); // remove 'vk:'
                this.memCache.set(filePath, JSON.parse(value));
            } catch { /* skip corrupt */ }
        }
        this.ready = true;
    }

    /**
     * 为单个文件生成 L0/L1 分层上下文
     */
    generateTier(filePath: string, content: string, hash: string): VikingTier {
        const cached = this.memCache.get(filePath);
        if (cached && cached.hash === hash) return cached;

        const structure = parseCodeStructure(content, filePath);
        const { context } = generateLocalContext(content, filePath);
        const ext = path.extname(filePath).toLowerCase();
        const fileName = path.basename(filePath);

        // === L0: ~100 tokens 极简摘要 ===
        const l0Parts: string[] = [];
        l0Parts.push(`[${fileName}]`);
        if (structure.type !== 'unknown') l0Parts.push(`type:${structure.type}`);
        if (structure.classes.length > 0) l0Parts.push(`cls:${structure.classes.slice(0, 3).join(',')}`);
        if (structure.functions.length > 0) l0Parts.push(`fn:${structure.functions.slice(0, 5).join(',')}`);
        if (structure.exports.length > 0) l0Parts.push(`exp:${structure.exports.slice(0, 3).join(',')}`);
        const l0 = l0Parts.join(' ');

        // === L1: ~2k tokens 详细概要 ===
        const l1Parts: string[] = [];
        l1Parts.push(`# ${filePath}`);
        l1Parts.push(`Type: ${structure.type} | ${ext}`);
        if (context) l1Parts.push(`Summary: ${context}`);
        if (structure.classes.length > 0) {
            l1Parts.push(`Classes: ${structure.classes.join(', ')}`);
        }
        if (structure.functions.length > 0) {
            l1Parts.push(`Functions: ${structure.functions.join(', ')}`);
        }
        if (structure.imports.length > 0) {
            l1Parts.push(`Imports: ${structure.imports.slice(0, 15).join(', ')}`);
        }
        if (structure.exports.length > 0) {
            l1Parts.push(`Exports: ${structure.exports.join(', ')}`);
        }
        // 提取关键代码片段（前 60 行，约 1.5k tokens）
        const lines = content.split('\n');
        const headSnippet = lines.slice(0, Math.min(60, lines.length)).join('\n');
        if (headSnippet.length > 0 && structure.type !== 'config') {
            l1Parts.push(`\`\`\`${ext.slice(1) || 'text'}\n${headSnippet}\n\`\`\``);
        }
        const l1 = l1Parts.join('\n');

        const tier: VikingTier = { l0, l1, structure, hash, updatedAt: Date.now() };
        this.memCache.set(filePath, tier);
        return tier;
    }

    /**
     * 批量生成并持久化
     */
    async batchGenerate(
        docs: Array<{ path: string; content: string; hash: string }>,
        onProgress?: (current: number, total: number) => void
    ): Promise<number> {
        let generated = 0;
        const ops: Array<{ type: 'put'; key: string; value: string }> = [];

        for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            const cached = this.memCache.get(doc.path);
            if (cached && cached.hash === doc.hash) {
                onProgress?.(i + 1, docs.length);
                continue;
            }
            const tier = this.generateTier(doc.path, doc.content, doc.hash);
            ops.push({ type: 'put', key: `vk:${doc.path}`, value: JSON.stringify(tier) });
            generated++;
            if (ops.length >= 50) {
                await this.store.batch(ops);
                ops.length = 0;
            }
            onProgress?.(i + 1, docs.length);
        }
        if (ops.length > 0) await this.store.batch(ops);
        return generated;
    }

    /** 获取单个文件的分层上下文 */
    getTier(filePath: string): VikingTier | undefined {
        return this.memCache.get(filePath);
    }

    /** 获取多个文件的 L0 摘要（用于 system prompt 注入） */
    getL0Batch(filePaths: string[]): string {
        const parts: string[] = [];
        for (const fp of filePaths) {
            const tier = this.memCache.get(fp);
            if (tier) parts.push(tier.l0);
        }
        return parts.join('\n');
    }

    /** 获取多个文件的 L1 概要 */
    getL1Batch(filePaths: string[]): string {
        return filePaths
            .map(fp => this.memCache.get(fp)?.l1)
            .filter(Boolean)
            .join('\n---\n');
    }

    /** 按目录聚合 L0 — 用于 Directory Recursive Retrieval */
    getDirectoryL0(dirPath: string): string {
        const parts: string[] = [];
        for (const [fp, tier] of this.memCache) {
            if (fp.startsWith(dirPath)) {
                parts.push(tier.l0);
            }
        }
        return parts.join('\n');
    }

    /** 获取所有已知文件路径 */
    getAllPaths(): string[] {
        return Array.from(this.memCache.keys());
    }

    /** 统计 */
    getStats(): VikingContextStats {
        let l0Tokens = 0, l1Tokens = 0;
        for (const tier of this.memCache.values()) {
            // 粗略按空格+标点估算 token 数
            l0Tokens += Math.ceil(tier.l0.length / 4);
            l1Tokens += Math.ceil(tier.l1.length / 4);
        }
        return { totalResources: this.memCache.size, l0TotalTokens: l0Tokens, l1TotalTokens: l1Tokens };
    }

    async close(): Promise<void> {
        await this.store.close();
    }
}

