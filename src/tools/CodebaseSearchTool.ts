// ===== CodebaseSearchTool =====
// RAG 本地搜索，从 providers/openai.ts 的 codebase_search 拦截逻辑提取

import { buildTool, ToolResult, ToolContext } from './Tool';
import { state, log } from '../globals';

export const CodebaseSearchTool = buildTool({
    name: 'codebase_search',
    aliases: ['codebase-search', 'codebase-retrieval'],
    description: '搜索项目代码库和文档，查找相关代码片段。优先使用此工具而不是盲目浏览文件。',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string' },
        },
        required: ['query']
    },
    isReadOnly: true,
    isConcurrencySafe: true,

    isEnabled() {
        return !!state.ragIndex;
    },

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const query = (input.query || input.information_request || '') as string;
        if (!query) {
            return { success: false, content: '', error: 'Missing query parameter' };
        }

        if (!state.ragIndex) {
            return { success: false, content: '', error: 'RAG index not initialized' };
        }

        try {
            log(`[RAG] codebase_search: "${query}"`);
            const results = await state.ragIndex.search(query, 10);

            if (!results || results.length === 0) {
                return { success: true, content: 'No relevant code found for the query.' };
            }

            const formatted = results.map((r: any, i: number) => {
                const score = r.score ? ` (score: ${r.score.toFixed(3)})` : '';
                const filePath = r.filePath || r.path || 'unknown';
                const content = r.content || r.text || '';
                return `### Result ${i + 1}: ${filePath}${score}\n\`\`\`\n${content}\n\`\`\``;
            }).join('\n\n');

            log(`[RAG] codebase_search: found ${results.length} results`);
            return { success: true, content: formatted };
        } catch (e: any) {
            log(`[RAG] codebase_search error: ${e.message}`);
            return { success: false, content: '', error: `Search failed: ${e.message}` };
        }
    }
});
