/**
 * Session Memory System — 基于 OpenViking 的会话记忆自迭代
 * 
 * 功能：
 * 1. 自动从对话中提取用户偏好（编码风格、语言偏好、工具选择等）
 * 2. 记录 Agent 经验（成功的解决模式、常见错误修复等）
 * 3. 持久化到 LevelDB，跨会话生效
 * 4. 自动注入 system prompt，让 AI 具有长期记忆
 */

import { KvStore } from './storage';

export interface UserPreference {
    key: string;          // 偏好键，如 "language", "style", "framework"
    value: string;        // 偏好值
    confidence: number;   // 置信度 0-1
    source: string;       // 来源会话 ID
    updatedAt: number;
}

export interface AgentExperience {
    pattern: string;      // 经验模式描述
    context: string;      // 触发上下文
    resolution: string;   // 解决方案
    successCount: number; // 成功次数
    updatedAt: number;
}

export interface SessionMemoryStats {
    preferences: number;
    experiences: number;
    lastUpdated: number;
}

// 从对话中提取偏好的关键词匹配规则
const PREFERENCE_PATTERNS: Array<{ pattern: RegExp; key: string; extract: (match: RegExpMatchArray) => string }> = [
    { pattern: /(?:use|prefer|always use|write in)\s+(typescript|javascript|python|go|rust|java)/i, key: 'language', extract: m => m[1].toLowerCase() },
    { pattern: /(?:use|prefer)\s+(chinese|english|japanese|中文|英文)/i, key: 'response_language', extract: m => m[1] },
    { pattern: /(?:use|prefer|with)\s+(react|vue|angular|svelte|next\.?js|nuxt)/i, key: 'framework', extract: m => m[1].toLowerCase() },
    { pattern: /(?:use|prefer)\s+(tabs|spaces)/i, key: 'indentation', extract: m => m[1].toLowerCase() },
    { pattern: /(?:use|prefer|write)\s+(?:in\s+)?(functional|oop|class-based)\s+(?:style|approach|pattern)/i, key: 'coding_style', extract: m => m[1].toLowerCase() },
    { pattern: /(?:don'?t|never|avoid)\s+use\s+(\w+)/i, key: 'avoid', extract: m => m[1].toLowerCase() },
    { pattern: /用中文(?:回答|回复|解释)/i, key: 'response_language', extract: () => '中文' },
    { pattern: /(?:reply|respond|answer)\s+in\s+(chinese|english)/i, key: 'response_language', extract: m => m[1] },
];

export class SessionMemory {
    private store: KvStore;
    private preferences: Map<string, UserPreference> = new Map();
    private experiences: Map<string, AgentExperience> = new Map();
    private ready: boolean = false;

    constructor(cacheDir: string) {
        this.store = new KvStore({ cacheDir, dbName: 'session-memory' });
    }

    async init(): Promise<void> {
        await this.store.ensureReady();
        // 加载偏好
        for await (const [key, value] of this.store.entries('pref:')) {
            try {
                const pref: UserPreference = JSON.parse(value);
                this.preferences.set(key.slice(5), pref);
            } catch { /* skip */ }
        }
        // 加载经验
        for await (const [key, value] of this.store.entries('exp:')) {
            try {
                const exp: AgentExperience = JSON.parse(value);
                this.experiences.set(key.slice(4), exp);
            } catch { /* skip */ }
        }
        this.ready = true;
    }

    /**
     * 从用户消息中提取偏好（每次对话调用）
     */
    async extractFromUserMessage(message: string, conversationId: string): Promise<void> {
        for (const rule of PREFERENCE_PATTERNS) {
            const match = message.match(rule.pattern);
            if (match) {
                const value = rule.extract(match);
                const existing = this.preferences.get(rule.key);
                const confidence = existing ? Math.min(existing.confidence + 0.2, 1.0) : 0.5;
                const pref: UserPreference = {
                    key: rule.key,
                    value,
                    confidence,
                    source: conversationId,
                    updatedAt: Date.now()
                };
                this.preferences.set(rule.key, pref);
                await this.store.set(`pref:${rule.key}`, JSON.stringify(pref));
            }
        }
    }

    /**
     * 记录 Agent 经验（从成功的工具调用或修复中学习）
     */
    async recordExperience(pattern: string, context: string, resolution: string): Promise<void> {
        const key = this.hashKey(pattern);
        const existing = this.experiences.get(key);
        const exp: AgentExperience = {
            pattern,
            context: context.slice(0, 500),
            resolution: resolution.slice(0, 500),
            successCount: existing ? existing.successCount + 1 : 1,
            updatedAt: Date.now()
        };
        this.experiences.set(key, exp);
        await this.store.set(`exp:${key}`, JSON.stringify(exp));
    }

    /**
     * 生成 system prompt 注入内容
     * 按置信度排序，限制 token 数
     */
    buildMemoryPrompt(maxTokens: number = 500): string {
        const parts: string[] = [];
        // 偏好（高置信度优先）
        const sortedPrefs = [...this.preferences.values()]
            .filter(p => p.confidence >= 0.3)
            .sort((a, b) => b.confidence - a.confidence);
        if (sortedPrefs.length > 0) {
            parts.push('## User Preferences (learned from history)');
            for (const p of sortedPrefs.slice(0, 10)) {
                parts.push(`- ${p.key}: ${p.value} (confidence: ${(p.confidence * 100).toFixed(0)}%)`);
            }
        }
        // 经验（高成功次数优先）
        const sortedExps = [...this.experiences.values()]
            .sort((a, b) => b.successCount - a.successCount);
        if (sortedExps.length > 0) {
            parts.push('## Agent Experience (learned patterns)');
            for (const e of sortedExps.slice(0, 5)) {
                parts.push(`- Pattern: ${e.pattern}\n  Resolution: ${e.resolution}`);
            }
        }
        const prompt = parts.join('\n');
        // 粗略 token 限制
        const maxChars = maxTokens * 4;
        return prompt.length > maxChars ? prompt.slice(0, maxChars) + '\n...(truncated)' : prompt;
    }

    getStats(): SessionMemoryStats {
        const allUpdated = [
            ...[...this.preferences.values()].map(p => p.updatedAt),
            ...[...this.experiences.values()].map(e => e.updatedAt)
        ];
        return {
            preferences: this.preferences.size,
            experiences: this.experiences.size,
            lastUpdated: allUpdated.length > 0 ? Math.max(...allUpdated) : 0
        };
    }

    private hashKey(s: string): string {
        return s.replace(/[^a-z0-9]/gi, '_').slice(0, 64);
    }

    async close(): Promise<void> {
        await this.store.close();
    }
}

