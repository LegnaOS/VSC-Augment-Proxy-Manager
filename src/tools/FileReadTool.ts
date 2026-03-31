// ===== FileReadTool =====
// 增强文件读取，支持行范围、大小限制

import { buildTool, ToolResult, ToolContext } from './Tool';
import { log } from '../globals';

export const FileReadTool = buildTool({
    name: 'file_read',
    aliases: ['read_file', 'cat'],
    description: '读取文件内容，支持指定行范围。返回带行号的文件内容。',
    inputSchema: {
        type: 'object',
        properties: {
            file_path: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
        },
        required: ['file_path']
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultSizeChars: 100_000,

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const fs = require('fs');
        const path = require('path');

        const filePath = (input.file_path || input.path) as string;
        const offset = (input.offset || 0) as number;
        const limit = (input.limit || 2000) as number;

        if (!filePath) {
            return { success: false, content: '', error: 'Missing file_path parameter' };
        }

        const repoRoot = context.repositoryRoot || context.workspacePath;
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);

        try {
            if (!fs.existsSync(fullPath)) {
                return { success: false, content: '', error: `File not found: ${filePath}` };
            }

            const stat = fs.statSync(fullPath);
            if (stat.size > 2 * 1024 * 1024) { // 2MB
                return { success: false, content: '', error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 2MB.` };
            }

            const content = fs.readFileSync(fullPath, 'utf-8');
            const allLines = content.split('\n');
            const startLine = Math.max(0, offset);
            const endLine = Math.min(allLines.length, startLine + limit);
            const selectedLines = allLines.slice(startLine, endLine);

            // cat -n 格式
            const numbered = selectedLines.map((line: string, i: number) => {
                const lineNum = String(startLine + i + 1).padStart(6, ' ');
                return `${lineNum}\t${line}`;
            }).join('\n');

            const truncated = endLine < allLines.length;
            const suffix = truncated ? `\n\n[...truncated, ${allLines.length - endLine} more lines. Use offset=${endLine} to continue]` : '';

            log(`[FILE_READ] ${filePath}: lines ${startLine + 1}-${endLine} of ${allLines.length}`);

            return {
                success: true,
                content: numbered + suffix,
                metadata: { totalLines: allLines.length, startLine: startLine + 1, endLine, truncated }
            };
        } catch (e: any) {
            return { success: false, content: '', error: e.message };
        }
    }
});
