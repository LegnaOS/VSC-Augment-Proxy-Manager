// ===== 新增工具的 Schema 定义 =====
// 注入到 Augment 的 tool_definitions 中，让 AI 知道这些工具的存在

export const EXTRA_TOOL_SCHEMAS = {
    bash: {
        name: 'bash',
        description: 'Execute a shell command in the workspace directory. Use for running builds, tests, searching files, viewing system info, etc. Commands run with a 120s timeout.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                command: { type: 'string', description: 'The shell command to execute' },
                timeout: { type: 'number', description: 'Timeout in seconds (default: 120)' }
            },
            required: ['command'],
            additionalProperties: false
        }
    },
    glob: {
        name: 'glob',
        description: 'Search for files using glob patterns like **/*.ts or src/**/*.js. Returns matching file paths sorted by modification time.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                pattern: { type: 'string', description: 'Glob pattern to match files (e.g. **/*.ts, src/**/*.js)' },
                path: { type: 'string', description: 'Directory to search in (default: workspace root)' }
            },
            required: ['pattern'],
            additionalProperties: false
        }
    },
    grep: {
        name: 'grep',
        description: 'Search file contents for text or regex patterns. Returns matching files and lines with context.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: { type: 'string', description: 'Text or regex pattern to search for' },
                path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
                include: { type: 'string', description: 'File pattern to include (e.g. *.ts)' },
                case_sensitive: { type: 'boolean', description: 'Case sensitive search (default: true)' }
            },
            required: ['query'],
            additionalProperties: false
        }
    },
    file_read: {
        name: 'file_read',
        description: 'Read file contents with line numbers. Supports line range selection with offset/limit.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                file_path: { type: 'string', description: 'Path to the file to read' },
                offset: { type: 'number', description: 'Starting line number (0-based, default: 0)' },
                limit: { type: 'number', description: 'Number of lines to read (default: 2000)' }
            },
            required: ['file_path'],
            additionalProperties: false
        }
    },
    list_directory: {
        name: 'list_directory',
        description: 'List directory contents showing files and subdirectories with sizes.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: { type: 'string', description: 'Directory path to list' }
            },
            required: ['path'],
            additionalProperties: false
        }
    }
};

// 转换为 Anthropic 格式
export function getExtraToolsAnthropic(): any[] {
    return Object.values(EXTRA_TOOL_SCHEMAS).map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema
    }));
}

// 转换为 OpenAI 格式
export function getExtraToolsOpenAI(): any[] {
    return Object.values(EXTRA_TOOL_SCHEMAS).map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema
        }
    }));
}

// 转换为 Gemini 格式
export function getExtraToolsGemini(): any[] {
    return Object.values(EXTRA_TOOL_SCHEMAS).map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
    }));
}
