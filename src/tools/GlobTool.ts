// ===== GlobTool =====
// 文件模式搜索，参考 Claude Code GlobTool

import { buildTool, ToolResult, ToolContext } from './Tool';
import { log } from '../globals';

export const GlobTool = buildTool({
    name: 'glob',
    aliases: ['find_files', 'list_files'],
    description: '使用 glob 模式搜索文件。支持 **/*.ts、src/**/*.js 等模式。返回匹配的文件路径列表。',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
        },
        required: ['pattern']
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultSizeChars: 60_000,

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const { execSync } = require('child_process');
        const path = require('path');

        const pattern = (input.pattern || '') as string;
        const searchPath = (input.path || context.workspacePath || context.cwd) as string;

        if (!pattern) {
            return { success: false, content: '', error: 'Missing pattern parameter' };
        }

        log(`[GLOB] Pattern: ${pattern}, Path: ${searchPath}`);

        try {
            // 使用 find + grep 模拟 glob（跨平台兼容）
            // 先尝试用 fd（如果安装了），否则 fallback 到 find
            let cmd: string;
            const excludeDirs = 'node_modules|.git|dist|build|.next|__pycache__|.venv|.cache|coverage';

            if (pattern.includes('*')) {
                // glob 模式 → find -name
                const namePattern = path.basename(pattern);
                const dirPattern = path.dirname(pattern);
                const baseDir = dirPattern === '.' ? searchPath : path.join(searchPath, dirPattern);

                cmd = `find "${baseDir}" -type f -name "${namePattern}" 2>/dev/null | grep -vE "(${excludeDirs})" | head -200 | sort`;
            } else {
                // 精确文件名搜索
                cmd = `find "${searchPath}" -type f -name "${pattern}" 2>/dev/null | grep -vE "(${excludeDirs})" | head -200 | sort`;
            }

            const result = execSync(cmd, {
                cwd: searchPath,
                timeout: 30_000,
                encoding: 'utf-8',
                maxBuffer: 5 * 1024 * 1024,
            });

            const files = (result || '').trim().split('\n').filter(Boolean);

            // 转为相对路径
            const relativePaths = files.map((f: string) => {
                if (f.startsWith(searchPath)) {
                    return f.substring(searchPath.length).replace(/^\//, '');
                }
                return f;
            });

            log(`[GLOB] Found ${relativePaths.length} files`);

            if (relativePaths.length === 0) {
                return { success: true, content: 'No files found matching the pattern.' };
            }

            return {
                success: true,
                content: relativePaths.join('\n'),
                metadata: { count: relativePaths.length }
            };
        } catch (e: any) {
            return { success: false, content: '', error: `Glob search failed: ${e.message}` };
        }
    }
});
