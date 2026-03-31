// ===== BashTool =====
// 在代理层执行 shell 命令，参考 Claude Code BashTool

import { buildTool, ToolResult, ToolContext } from './Tool';
import { log } from '../globals';

const READ_ONLY_COMMANDS = /^\s*(ls|cat|head|tail|wc|find|grep|rg|ag|ack|which|where|type|file|stat|du|df|pwd|echo|printf|date|whoami|hostname|uname|env|printenv|git\s+(log|status|diff|show|branch|tag|remote|config|rev-parse)|tree|less|more|sort|uniq|cut|awk|sed\s+-n|tr|tee|diff|comm|join|paste|column|jq|yq|curl\s+.*--head|ping\s+-c|dig|nslookup|host|npm\s+(ls|list|outdated|view|info|search)|yarn\s+(list|info|why)|bun\s+(pm\s+ls)|pip\s+(list|show|freeze)|python\s+-c|node\s+-e|ruby\s+-e)\b/;

function isReadOnlyCommand(command: string): boolean {
    return READ_ONLY_COMMANDS.test(command);
}

export const BashTool = buildTool({
    name: 'bash',
    aliases: ['shell', 'execute_command', 'run_command'],
    description: '执行 shell 命令。用于运行构建、测试、搜索文件、查看系统信息等操作。',
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string' },
            timeout: { type: 'number' },
        },
        required: ['command']
    },
    maxResultSizeChars: 100_000,

    get isReadOnly() {
        return false; // 动态判断在 call 中处理
    },

    get isConcurrencySafe() {
        return false;
    },

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const { execSync } = require('child_process');
        const command = (input.command || '') as string;
        const timeout = ((input.timeout as number) || 120) * 1000;

        if (!command.trim()) {
            return { success: false, content: '', error: 'Empty command' };
        }

        log(`[BASH] Executing: ${command.substring(0, 200)}${command.length > 200 ? '...' : ''}`);

        try {
            const result = execSync(command, {
                cwd: context.workspacePath || context.cwd,
                timeout,
                maxBuffer: 10 * 1024 * 1024, // 10MB
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' }
            });

            const output = (result || '').toString();
            log(`[BASH] Success (${output.length} chars)`);

            return {
                success: true,
                content: output || '(no output)',
            };
        } catch (e: any) {
            const stdout = e.stdout?.toString() || '';
            const stderr = e.stderr?.toString() || '';
            const exitCode = e.status ?? -1;
            const output = [stdout, stderr].filter(Boolean).join('\n');

            if (e.killed || e.signal === 'SIGTERM') {
                log(`[BASH] Timeout after ${timeout / 1000}s`);
                return {
                    success: false,
                    content: output || '',
                    error: `Command timed out after ${timeout / 1000}s`
                };
            }

            log(`[BASH] Exit code ${exitCode}`);
            return {
                success: exitCode === 0,
                content: output || `Exit code: ${exitCode}`,
                error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined
            };
        }
    }
});
