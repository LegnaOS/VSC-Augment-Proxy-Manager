// ===== 工具参数修正和转换函数 =====

import { state, log } from './globals';

// ========== 判断是否为代码搜索工具 ==========
export function isCodebaseSearchTool(name: string): boolean {
    return name === 'codebase_search' || name === 'codebase-search' || name === 'codebase-retrieval';
}

// ========== 检查是否只有 codebase_search 工具调用 ==========
export function hasOnlyCodebaseSearchCalls(toolCalls: Array<{ name: string }>): boolean {
    if (toolCalls.length === 0) return false;
    return toolCalls.every(tc => isCodebaseSearchTool(tc.name));
}

// ========== 过滤出 codebase_search 工具调用 ==========
export function filterCodebaseSearchCalls(toolCalls: Array<{ id: string; name: string; arguments: string }>): Array<{ id: string; query: string }> {
    return toolCalls
        .filter(tc => isCodebaseSearchTool(tc.name))
        .map(tc => {
            try {
                const args = JSON.parse(tc.arguments || '{}');
                return { id: tc.id, query: args.query || args.information_request || '' };
            } catch {
                return { id: tc.id, query: '' };
            }
        });
}

// ========== 统一工具参数修正函数 ==========
// 合并路径修正 + Playwright/view/save-file/str-replace-editor 参数修正
// 所有 provider (Anthropic/OpenAI/Google) 共用此函数
export function fixToolCallInput(toolName: string, input: any, workspaceInfo: any): any {
    // ========== 路径修正 ==========
    const fileTools = ['save-file', 'view', 'remove-files', 'str-replace-editor'];
    if (fileTools.includes(toolName) && workspaceInfo) {
        const workspacePath = workspaceInfo.workspacePath || '';
        const repoRoot = workspaceInfo.repositoryRoot || '';

        let relativePrefix = '';
        if (repoRoot && workspacePath && workspacePath.startsWith(repoRoot) && workspacePath !== repoRoot) {
            relativePrefix = workspacePath.substring(repoRoot.length).replace(/^\//, '');
        }

        if (relativePrefix) {
            if (input.path && typeof input.path === 'string' && !input.path.startsWith('/') && !input.path.startsWith(relativePrefix)) {
                const originalPath = input.path;
                input.path = relativePrefix + '/' + input.path;
                log(`[PATH FIX] ${toolName}: "${originalPath}" -> "${input.path}"`);
            }
            if (input.file_paths && Array.isArray(input.file_paths)) {
                input.file_paths = input.file_paths.map((p: string) => {
                    if (typeof p === 'string' && !p.startsWith('/') && !p.startsWith(relativePrefix)) {
                        const newPath = relativePrefix + '/' + p;
                        log(`[PATH FIX] ${toolName} file_paths: "${p}" -> "${newPath}"`);
                        return newPath;
                    }
                    return p;
                });
            }
        }
    }

    // ========== Playwright 参数修正 ==========
    if (toolName.includes('Playwright')) {
        if (toolName === 'browser_wait_for_Playwright') {
            if (input.time !== undefined && typeof input.time === 'string') {
                const numTime = parseInt(input.time, 10);
                if (!isNaN(numTime)) { log(`[FIX] browser_wait_for: time "${input.time}" -> ${numTime}`); input.time = numTime; }
            }
            if (input.wait_time !== undefined && input.time === undefined) {
                input.time = typeof input.wait_time === 'string' ? parseInt(input.wait_time, 10) : input.wait_time;
                delete input.wait_time;
            }
        }
        if (toolName === 'browser_run_code_Playwright' && input.code !== undefined && input.function === undefined) {
            input.function = input.code; delete input.code;
        }
        if (toolName === 'browser_evaluate_Playwright') {
            if (input.expression !== undefined && input.function === undefined) { input.function = input.expression; delete input.expression; }
            if (input.code !== undefined && input.function === undefined) { input.function = input.code; delete input.code; }
        }
    }

    // ========== view 参数修正 ==========
    if (toolName === 'view' && input.view_range !== undefined && typeof input.view_range === 'string') {
        try {
            const parsed = JSON.parse(input.view_range);
            if (Array.isArray(parsed) && parsed.length === 2) {
                input.view_range = parsed.map((n: any) => typeof n === 'string' ? parseInt(n, 10) : n);
                log(`[FIX] view_range: string -> array`);
            }
        } catch (e) { /* ignore */ }
    }

    // ========== save-file 参数修正 ==========
    if (toolName === 'save-file') {
        if (input.content !== undefined && input.file_content === undefined) { input.file_content = input.content; delete input.content; }
        if (input.file !== undefined && input.file_content === undefined) { input.file_content = input.file; delete input.file; }
    }

    // ========== str-replace-editor 参数修正 ==========
    if (toolName === 'str-replace-editor') {
        if (!input.command) {
            if (input.old_str_1 !== undefined || input.old_str !== undefined) input.command = 'str_replace';
            else if (input.insert_line_1 !== undefined || input.insert_line !== undefined) input.command = 'insert';
        }
        if (!input.instruction_reminder) {
            input.instruction_reminder = 'ALWAYS BREAK DOWN EDITS INTO SMALLER CHUNKS OF AT MOST 150 LINES EACH.';
        }
        if (input.old_str !== undefined && input.old_str_1 === undefined) { input.old_str_1 = input.old_str; delete input.old_str; }
        if (input.new_str !== undefined && input.new_str_1 === undefined) { input.new_str_1 = input.new_str; delete input.new_str; }
    }

    return input;
}

// 兼容旧的 applyPathFixes 调用（Google 路径使用）
export function applyPathFixes(toolUse: any, workspaceInfo: any) {
    try {
        const input = JSON.parse(toolUse.input_json);
        const fixed = fixToolCallInput(toolUse.tool_name, input, workspaceInfo);
        toolUse.input_json = JSON.stringify(fixed);
    } catch (e) {
        // 忽略解析错误
    }
}

// ========== 转换 Augment tool_definitions 到 Anthropic tools 格式 ==========
export function convertToolDefinitions(toolDefs: any[]): any[] | undefined {
    if (!toolDefs || toolDefs.length === 0)
        return undefined;
    const tools: any[] = [];
    for (const def of toolDefs) {
        if (def.name && def.input_schema_json) {
            try {
                const inputSchema = typeof def.input_schema_json === 'string'
                    ? JSON.parse(def.input_schema_json)
                    : def.input_schema_json;
                tools.push({
                    name: def.name,
                    description: def.description || '',
                    input_schema: inputSchema
                });
            } catch (e) {
                log(`[DEBUG] Failed to parse input_schema_json for ${def.name}`);
            }
        }
        else if (def.name && def.input_schema) {
            tools.push({
                name: def.name,
                description: def.description || '',
                input_schema: def.input_schema
            });
        }
        else if (def.function) {
            tools.push({
                name: def.function.name,
                description: def.function.description || '',
                input_schema: def.function.parameters || { type: 'object', properties: {} }
            });
        }
    }
    return tools.length > 0 ? tools : undefined;
}

// ========== 转换 Augment tool_definitions 到 OpenAI tools 格式 ==========
export function convertToolDefinitionsToOpenAI(toolDefs: any[]): any[] | undefined {
    if (!toolDefs || toolDefs.length === 0)
        return undefined;
    const tools: any[] = [];

    // 添加 codebase_search 工具（使用本地 RAG 索引）
    if (state.ragIndex) {
        tools.push({
            type: 'function',
            function: {
                name: 'codebase_search',
                description: '搜索项目代码库和文档，查找相关代码片段。在需要了解项目结构、查找特定功能实现、或查阅文档时使用此工具。优先使用此工具而不是盲目浏览文件。',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: '搜索查询，描述你要找的代码、功能或文档内容。例如："精灵图片区域参数"、"用户登录验证逻辑"、"ListView API 文档"'
                        }
                    },
                    required: ['query'],
                    additionalProperties: false
                }
            }
        });
        log(`[RAG] Added codebase_search tool to available tools`);
    }

    for (const def of toolDefs) {
        if (def.name) {
            if (def.name === 'save-file') {
                log(`[DEBUG] save-file tool schema: ${JSON.stringify(def.input_json_schema)}`);
            }
            let parameters = def.input_json_schema;
            if (typeof parameters === 'string') {
                try {
                    parameters = JSON.parse(parameters);
                } catch (e) {
                    log(`[WARN] Failed to parse input_json_schema for ${def.name}: ${e}`);
                    parameters = { type: 'object', properties: {} };
                }
            }
            tools.push({
                type: 'function',
                function: {
                    name: def.name,
                    description: def.description || '',
                    parameters: parameters || { type: 'object', properties: {} }
                }
            });
        }
    }
    return tools.length > 0 ? tools : undefined;
}

// ========== 转换工具定义到 Gemini 格式 ==========
export function convertToolDefinitionsToGemini(toolDefs: any[]): any[] {
    if (!toolDefs || toolDefs.length === 0) return [];
    const tools: any[] = [];
    for (const def of toolDefs) {
        if (!def.name) continue;
        let parameters = def.input_json_schema || def.input_schema;
        if (typeof parameters === 'string') {
            try {
                parameters = JSON.parse(parameters);
            } catch (e) {
                parameters = { type: 'object', properties: {} };
            }
        }
        tools.push({
            name: def.name,
            description: def.description || '',
            parameters: parameters || { type: 'object', properties: {} }
        });
    }
    return tools;
}

// ========== 处理工具调用并转换为 Augment 格式 ==========
// 🔧 重构：使用 fixToolCallInput() 替代重复的内联逻辑
export function processToolCallForAugment(
    tc: { id: string; name: string; arguments: string },
    workspaceInfo: any,
    finishReason: string | null
): any {
    log(`[TOOL] Processing: ${tc.name}, id=${tc.id}`);

    if (!tc.arguments || tc.arguments === '' || tc.arguments === '{}') {
        log(`[WARN] Tool ${tc.name} has empty arguments!`);
    }

    let inputJson = tc.arguments || '{}';

    try {
        const parsed = JSON.parse(tc.arguments);
        const fixed = fixToolCallInput(tc.name, parsed, workspaceInfo);
        inputJson = JSON.stringify(fixed);
    } catch (e) {
        log(`[TOOL] Arguments parse error: ${e}`);
        if (finishReason === 'length') {
            log(`[TOOL] Skipping truncated tool call`);
            return null;
        }
    }

    return {
        type: 5, // TOOL_USE
        tool_use: {
            tool_use_id: tc.id,
            tool_name: tc.name,
            input_json: inputJson
        }
    };
}

