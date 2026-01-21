/**
 * LevelDB Storage Layer - 高效的键值存储
 * 
 * 与 Augment 实际实现一致，使用 LevelDB 替换 JSON 文件存储
 * 优势：增量写入、快速启动、低内存占用
 */

import { Level } from 'level';
import * as path from 'path';
import * as fs from 'fs';

export interface StorageOptions {
    cacheDir: string;
    dbName: string;
}

/**
 * LevelDB 键值存储封装
 * 提供异步的 get/set/delete/batch 操作
 */
export class KvStore {
    private db: Level<string, string> | null = null;
    private dbPath: string;
    private ready: Promise<void>;
    private isOpen: boolean = false;

    constructor(options: StorageOptions) {
        this.dbPath = path.join(options.cacheDir, options.dbName);
        this.ready = this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            // 确保目录存在
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            this.db = new Level<string, string>(this.dbPath, { 
                valueEncoding: 'json'
            });
            await this.db.open();
            this.isOpen = true;
        } catch (error) {
            console.error('[KvStore] Failed to initialize LevelDB:', error);
            this.db = null;
        }
    }

    async ensureReady(): Promise<boolean> {
        await this.ready;
        return this.db !== null && this.isOpen;
    }

    async get(key: string): Promise<string | undefined> {
        if (!await this.ensureReady()) return undefined;
        try {
            return await this.db!.get(key);
        } catch (error: any) {
            if (error.code === 'LEVEL_NOT_FOUND') return undefined;
            throw error;
        }
    }

    async getJson<T>(key: string): Promise<T | undefined> {
        const value = await this.get(key);
        if (value === undefined) return undefined;
        try {
            return JSON.parse(value) as T;
        } catch {
            return undefined;
        }
    }

    async set(key: string, value: string): Promise<void> {
        if (!await this.ensureReady()) return;
        await this.db!.put(key, value);
    }

    async setJson<T>(key: string, value: T): Promise<void> {
        await this.set(key, JSON.stringify(value));
    }

    async delete(key: string): Promise<void> {
        if (!await this.ensureReady()) return;
        try {
            await this.db!.del(key);
        } catch (error: any) {
            if (error.code !== 'LEVEL_NOT_FOUND') throw error;
        }
    }

    async has(key: string): Promise<boolean> {
        return (await this.get(key)) !== undefined;
    }

    /**
     * 批量操作 - 原子性写入
     */
    async batch(ops: Array<{ type: 'put' | 'del'; key: string; value?: string }>): Promise<void> {
        if (!await this.ensureReady()) return;
        const batch = this.db!.batch();
        for (const op of ops) {
            if (op.type === 'put' && op.value !== undefined) {
                batch.put(op.key, op.value);
            } else if (op.type === 'del') {
                batch.del(op.key);
            }
        }
        await batch.write();
    }

    /**
     * 遍历所有键值对
     */
    async *entries(prefix?: string): AsyncGenerator<[string, string]> {
        if (!await this.ensureReady()) return;
        const options = prefix ? { gte: prefix, lt: prefix + '\xff' } : {};
        for await (const [key, value] of this.db!.iterator(options)) {
            yield [key, value];
        }
    }

    /**
     * 获取所有键
     */
    async keys(prefix?: string): Promise<string[]> {
        const keys: string[] = [];
        for await (const [key] of this.entries(prefix)) {
            keys.push(key);
        }
        return keys;
    }

    /**
     * 清空指定前缀的所有数据
     */
    async clear(prefix?: string): Promise<void> {
        if (!await this.ensureReady()) return;
        if (prefix) {
            await this.db!.clear({ gte: prefix, lt: prefix + '\xff' });
        } else {
            await this.db!.clear();
        }
    }

    async close(): Promise<void> {
        if (this.db && this.isOpen) {
            await this.db.close();
            this.isOpen = false;
        }
    }
}

