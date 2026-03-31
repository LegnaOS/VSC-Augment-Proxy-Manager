// ===== GrepTool =====
// 内容搜索，优先 ripgrep，fallback find+grep

import { buildTool, ToolResult, ToolContext } from './Tool';
import { log } from '../globals';

export const GrepTool = buildTool({
    name: 'grep',
    aliases: ['search', 'grep_search', 'search_files'],
    description: '在文件内容中搜索文本或正则表达式。返回匹配的文件和行。',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string' },
            path: { type: 'string' },
            include: { type: 'string' },
            case_sensitive: { type: 'boolean' },
        },
        required: ['query']
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultSizeChars: 80_000,

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const { execSync } = require('child_process');

        const query = (input.query || input.pattern || '') as string;
        const searchPath = (input.path || input.directory || context.workspacePath || context.cwd) as string;
        const include = (input.include || '') as string;
        const caseSensitive = input.case_sensitive !== false;

        if (!query) {
            return { success: false, content: '', error: 'Missing query parameter' };
        }

        log(`[GREP] Query: "${query}", Path: ${searchPath}`);

        try {
            let cmd: string;
            const excludeDirs = 'node_modules,.git,dist,build,.next,__pycache__,.venv,.cache,coverage';

            // 尝试 ripgrep
            try {
                execSync('which rg', { stdio: 'pipe' });
                const flags = [
                    caseSensitive ? '' : '-i',
                    '-n', '--no-heading', '--color=never',
                    '-C', '2', // 2 行上下文
                    '--max-count=50',
                    '--max-filesize=1M',
                ].filter(Boolean).join(' ');

                const excludeFlags = excludeDirs.split(',').map(d => `--glob=!${d}`).join(' ');
                const includeFlag = include ? `--glob="${include}"` : '';

                cmd = `rg ${flags} ${excludeFlags} ${includeFlag} -- "${query.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -500`;
            } catch {
                // fallback 到 grep
                const flags = [
                    caseSensitive ? '' : '-i',
                    '-rn', '--color=never',
                    '-C', '2',
                    '-m', '50',
                ].filter(Boolean).join(' ');

                const excludeFlags = excludeDirs.split(',').map(d => `--exclude-dir=${d}`).join(' ');
                const includeFlag = include ? `--include="${include}"` : '';

                cmd = `grep ${flags} ${excludeFlags} ${includeFlag} -- "${query.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -500`;
            }

            const result = execSync(cmd, {
                cwd: searchPath,
                timeout: 30_000,
                encoding: 'utf-8',
                maxBuffer: 5 * 1024 * 1024,
            });

            const output = (result || '').trim();
            if (!output) {
                return { success: true, content: 'No matches found.' };
            }

            const matchCount = output.split('\n').filter((l: string) => l && !l.startsWith('--')).length;
            log(`[GREP] Found ~${matchCount} matches`);

            return { success: true, content: output, metadata: { matchCount } };
        } catch (e: any) {
            // grep 返回 exit code 1 表示无匹配
            if (e.status === 1) {
                return { success: true, content: 'No matches found.' };
            }
            return { success: false, content: '', error: `Search failed: ${e.message}` };
        }
    }
});
