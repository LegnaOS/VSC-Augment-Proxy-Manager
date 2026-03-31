// ===== 工具注册表 =====
// 单例模式，管理所有已注册工具的查找、分发和格式转换

import { Tool, ToolContext, ToolResult } from './Tool';
import { log } from '../globals';

export class ToolRegistry {
    private tools = new Map<string, Tool>();
    private aliasMap = new Map<string, string>();

    register(tool: Tool): void {
        this.tools.set(tool.name, tool);
        if (tool.aliases) {
            for (const alias of tool.aliases) {
                this.aliasMap.set(alias, tool.name);
            }
        }
        log(`[REGISTRY] Registered tool: ${tool.name}${tool.aliases?.length ? ` (aliases: ${tool.aliases.join(', ')})` : ''}`);
    }

    get(name: string): Tool | undefined {
        return this.tools.get(name) ?? this.tools.get(this.aliasMap.get(name) ?? '');
    }

    isIntercepted(name: string): boolean {
        return this.get(name) !== undefined;
    }

    getAll(): Tool[] {
        return Array.from(this.tools.values());
    }

    getEnabled(): Tool[] {
        return this.getAll().filter(t => t.isEnabled?.() ?? true);
    }

    // 执行单个工具调用
    async execute(name: string, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult | null> {
        const tool = this.get(name);
        if (!tool) return null;
        if (tool.isEnabled && !tool.isEnabled()) return null;

        // fixInput
        let fixedInput = input;
        if (tool.fixInput) {
            fixedInput = tool.fixInput(input, context);
        }

        // validateInput
        if (tool.validateInput) {
            const validation = tool.validateInput(fixedInput);
            if (!validation.valid) {
                return { success: false, content: '', error: validation.error };
            }
        }

        // call
        const result = await tool.call(fixedInput, context);

        // 截断过大结果
        if (result.content && result.content.length > tool.maxResultSizeChars) {
            result.content = result.content.slice(0, tool.maxResultSizeChars) + '\n[...truncated]';
        }

        return result;
    }

    // 批量处理工具调用，分离拦截/透传
    async processToolCalls(
        toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
        context: ToolContext
    ): Promise<{
        intercepted: Array<{ id: string; name: string; result: ToolResult }>;
        passthrough: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    }> {
        const intercepted: Array<{ id: string; name: string; result: ToolResult }> = [];
        const passthrough: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

        // 分区：并发安全的只读工具可以并行
        const concurrent: typeof toolCalls = [];
        const serial: typeof toolCalls = [];

        for (const tc of toolCalls) {
            const tool = this.get(tc.name);
            if (!tool) {
                passthrough.push(tc);
                continue;
            }
            if (tool.isReadOnly && tool.isConcurrencySafe) {
                concurrent.push(tc);
            } else {
                serial.push(tc);
            }
        }

        // 并发执行只读工具
        if (concurrent.length > 0) {
            const results = await Promise.all(
                concurrent.map(async tc => {
                    const result = await this.execute(tc.name, tc.input, context);
                    return { tc, result };
                })
            );
            for (const { tc, result } of results) {
                if (result) {
                    intercepted.push({ id: tc.id, name: tc.name, result });
                } else {
                    passthrough.push(tc);
                }
            }
        }

        // 串行执行写入工具
        for (const tc of serial) {
            const result = await this.execute(tc.name, tc.input, context);
            if (result) {
                intercepted.push({ id: tc.id, name: tc.name, result });
            } else {
                passthrough.push(tc);
            }
        }

        return { intercepted, passthrough };
    }

    // 生成系统提示中的工具描述
    getToolDescriptions(): string {
        const enabled = this.getEnabled();
        if (enabled.length === 0) return '';
        return enabled.map(t => `- **${t.name}**: ${t.description}`).join('\n');
    }
}

// 全局单例
export const globalToolRegistry = new ToolRegistry();
