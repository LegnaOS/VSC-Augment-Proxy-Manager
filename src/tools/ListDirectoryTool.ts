// ===== ListDirectoryTool =====
// 目录列表，带文件类型标注

import { buildTool, ToolResult, ToolContext } from './Tool';
import { log } from '../globals';

export const ListDirectoryTool = buildTool({
    name: 'list_directory',
    aliases: ['ls', 'list_dir'],
    description: '列出目录内容，显示文件和子目录。',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string' },
        },
        required: ['path']
    },
    isReadOnly: true,
    isConcurrencySafe: true,

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const fs = require('fs');
        const path = require('path');

        const dirPath = (input.path || context.workspacePath) as string;
        const repoRoot = context.repositoryRoot || context.workspacePath;
        const fullPath = path.isAbsolute(dirPath) ? dirPath : path.join(repoRoot, dirPath);

        try {
            if (!fs.existsSync(fullPath)) {
                return { success: false, content: '', error: `Directory not found: ${dirPath}` };
            }

            const stat = fs.statSync(fullPath);
            if (!stat.isDirectory()) {
                return { success: false, content: '', error: `Not a directory: ${dirPath}` };
            }

            const entries = fs.readdirSync(fullPath, { withFileTypes: true });
            const lines: string[] = [];

            // 目录优先，然后文件，各自按名称排序
            const dirs = entries.filter((e: any) => e.isDirectory()).sort((a: any, b: any) => a.name.localeCompare(b.name));
            const files = entries.filter((e: any) => !e.isDirectory()).sort((a: any, b: any) => a.name.localeCompare(b.name));

            for (const d of dirs) {
                lines.push(`📁 ${d.name}/`);
            }
            for (const f of files) {
                const fPath = path.join(fullPath, f.name);
                try {
                    const fStat = fs.statSync(fPath);
                    const size = fStat.size < 1024 ? `${fStat.size}B` :
                        fStat.size < 1024 * 1024 ? `${(fStat.size / 1024).toFixed(1)}KB` :
                            `${(fStat.size / 1024 / 1024).toFixed(1)}MB`;
                    lines.push(`📄 ${f.name} (${size})`);
                } catch {
                    lines.push(`📄 ${f.name}`);
                }
            }

            log(`[LIST_DIR] ${dirPath}: ${dirs.length} dirs, ${files.length} files`);

            return {
                success: true,
                content: lines.length > 0 ? lines.join('\n') : '(empty directory)',
                metadata: { dirCount: dirs.length, fileCount: files.length }
            };
        } catch (e: any) {
            return { success: false, content: '', error: e.message };
        }
    }
});
