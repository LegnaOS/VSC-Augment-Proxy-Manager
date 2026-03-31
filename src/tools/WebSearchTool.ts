// ===== WebSearchTool =====
// $web_search 透传（Kimi 内置联网搜索工具）

import { buildTool, ToolResult } from './Tool';
import { log } from '../globals';

export const WebSearchTool = buildTool({
    name: '$web_search',
    description: 'Kimi 内置联网搜索工具，原封不动返回 arguments',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    isConcurrencySafe: true,

    async call(input: Record<string, unknown>): Promise<ToolResult> {
        log(`[INTERCEPT] $web_search: returning arguments as-is for Kimi`);
        return {
            success: true,
            content: JSON.stringify(input),
            metadata: { passthrough: true }
        };
    }
});
