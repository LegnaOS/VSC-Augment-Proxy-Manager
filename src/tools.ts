// ===== 工具参数修正和转换函数 =====

import { state, log } from './globals';
import { getExtraToolsAnthropic, getExtraToolsOpenAI, getExtraToolsGemini } from './tools/extra-tool-schemas';

// ========== Patch 解析器类型定义 ==========
interface ParsedPatch {
    filePath: string;
    oldContent: string;
    newContent: string;
    startLine?: number;
    endLine?: number;
}

interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}

// ========== 完整的 Unified Diff 解析器 ==========
function parsePatchInput(patchInput: string): ParsedPatch[] {
    const patches: ParsedPatch[] = [];
    const lines = patchInput.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // 检测 Augment 自定义格式：*** Update File: xxx
        if (line.startsWith('*** Update File:') || line.startsWith('*** Create File:')) {
            const filePath = line.split(':')[1]?.trim() || '';
            i++;

            const patch = parseAugmentPatch(lines, i, filePath);
            if (patch) {
                patches.push(patch);
                i = patch.nextIndex;
            }
            continue;
        }

        // 检测标准 unified diff 格式：--- a/file 或 diff --git
        if (line.startsWith('--- ') || line.startsWith('diff --git')) {
            const patch = parseUnifiedDiff(lines, i);
            if (patch) {
                patches.push(patch.patch);
                i = patch.nextIndex;
            } else {
                i++;
            }
            continue;
        }

        i++;
    }

    return patches;
}

// ========== 解析 Augment V4A diff 格式 ==========
// 格式 1（diff 格式）：
// *** Update File: path/to/file
// @@ class TerminalGame          ← 上下文定位符（跳过）
// @@     startAdventure() {      ← 上下文定位符（跳过）
//         this.gameState = {};   ← 上下文行（保留）
// -       old line               ← 删除行（- 后有空格）
// +       new line               ← 添加行（+ 后有空格）
//         context line           ← 上下文行（保留）
//
// 格式 2（完整文件替换）：
// *** Begin Patch
// *** Update File: path/to/file
// <完整的文件内容>
// *** End Patch
function parseAugmentPatch(lines: string[], startIndex: number, filePath: string): (ParsedPatch & { nextIndex: number }) | null {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let i = startIndex;
    let hasAnyDiffMarkers = false; // 检测是否有 diff 标记（@@, -, +）

    while (i < lines.length) {
        const line = lines[i];

        // 遇到下一个文件或 patch 结束
        if (line.startsWith('*** ') && (line.includes('File:') || line.includes('End Patch'))) {
            break;
        }

        // @@ 开头的是上下文定位符，跳过
        if (line.startsWith('@@')) {
            hasAnyDiffMarkers = true;
            i++;
            continue;
        }

        // - 开头：删除的行（只在 oldContent 中）
        // 支持 "- " 或 "-" (有无空格都支持)
        if (line.startsWith('-')) {
            hasAnyDiffMarkers = true;
            const content = line.startsWith('- ') ? line.substring(2) : line.substring(1);
            oldLines.push(content);
            i++;
            continue;
        }

        // + 开头：添加的行（只在 newContent 中）
        // 支持 "+ " 或 "+" (有无空格都支持)
        if (line.startsWith('+')) {
            hasAnyDiffMarkers = true;
            const content = line.startsWith('+ ') ? line.substring(2) : line.substring(1);
            newLines.push(content);
            i++;
            continue;
        }

        // 其他行：上下文行（在 oldContent 和 newContent 中都有）
        oldLines.push(line);
        newLines.push(line);

        i++;
    }

    if (oldLines.length === 0 && newLines.length === 0) {
        return null;
    }

    // 如果没有任何 diff 标记，说明是完整文件替换格式
    // 这种情况下，newContent 就是完整的新文件内容，oldContent 留空
    if (!hasAnyDiffMarkers && newLines.length > 0) {
        return {
            filePath,
            oldContent: '', // 完整替换时，不需要 oldContent
            newContent: newLines.join('\n'),
            nextIndex: i
        };
    }

    return {
        filePath,
        oldContent: oldLines.join('\n'),
        newContent: newLines.join('\n'),
        nextIndex: i
    };
}

// ========== 解析标准 Unified Diff 格式 ==========
function parseUnifiedDiff(lines: string[], startIndex: number): { patch: ParsedPatch; nextIndex: number } | null {
    let i = startIndex;
    let filePath = '';

    // 解析文件头
    if (lines[i].startsWith('diff --git')) {
        // diff --git a/file.js b/file.js
        const match = lines[i].match(/diff --git a\/(.+?) b\//);
        if (match) {
            filePath = match[1];
        }
        i++;
    }

    // 跳过 index, new file mode 等行
    while (i < lines.length && !lines[i].startsWith('---')) {
        i++;
    }

    // --- a/file.js
    if (i < lines.length && lines[i].startsWith('---')) {
        if (!filePath) {
            const match = lines[i].match(/^--- (?:a\/)?(.+?)$/);
            if (match) {
                filePath = match[1];
            }
        }
        i++;
    }

    // +++ b/file.js
    if (i < lines.length && lines[i].startsWith('+++')) {
        i++;
    }

    if (!filePath) {
        return null;
    }

    // 解析所有 hunks
    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
        const hunk = parseHunk(lines, i);
        if (hunk) {
            hunks.push(hunk.hunk);
            i = hunk.nextIndex;
        } else {
            break;
        }
    }

    if (hunks.length === 0) {
        return null;
    }

    // 合并所有 hunks 为一个 patch
    const { oldContent, newContent, startLine, endLine } = mergeHunks(hunks);

    return {
        patch: {
            filePath,
            oldContent,
            newContent,
            startLine,
            endLine
        },
        nextIndex: i
    };
}

// ========== 解析单个 Hunk ==========
function parseHunk(lines: string[], startIndex: number): { hunk: Hunk; nextIndex: number } | null {
    const line = lines[startIndex];

    // @@ -10,5 +10,7 @@ optional context
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) {
        return null;
    }

    const oldStart = parseInt(match[1], 10);
    const oldLines = match[2] ? parseInt(match[2], 10) : 1;
    const newStart = parseInt(match[3], 10);
    const newLines = match[4] ? parseInt(match[4], 10) : 1;

    const hunkLines: string[] = [];
    let i = startIndex + 1;

    // 读取 hunk 的所有行
    while (i < lines.length) {
        const l = lines[i];

        // 遇到下一个 hunk 或文件头，停止
        if (l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++') || l.startsWith('diff --git')) {
            break;
        }

        hunkLines.push(l);
        i++;
    }

    return {
        hunk: {
            oldStart,
            oldLines,
            newStart,
            newLines,
            lines: hunkLines
        },
        nextIndex: i
    };
}

// ========== 合并多个 Hunks ==========
function mergeHunks(hunks: Hunk[]): { oldContent: string; newContent: string; startLine: number; endLine: number } {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let minLine = Infinity;
    let maxLine = -Infinity;

    for (const hunk of hunks) {
        minLine = Math.min(minLine, hunk.oldStart);
        maxLine = Math.max(maxLine, hunk.oldStart + hunk.oldLines - 1);

        for (const line of hunk.lines) {
            if (line.startsWith(' ')) {
                // 上下文行（保持不变）
                oldLines.push(line.substring(1));
                newLines.push(line.substring(1));
            } else if (line.startsWith('-')) {
                // 删除的行
                oldLines.push(line.substring(1));
            } else if (line.startsWith('+')) {
                // 添加的行
                newLines.push(line.substring(1));
            } else if (line.trim() === '') {
                // 空行
                oldLines.push('');
                newLines.push('');
            }
        }
    }

    return {
        oldContent: oldLines.join('\n'),
        newContent: newLines.join('\n'),
        startLine: minLine !== Infinity ? minLine : 1,
        endLine: maxLine !== -Infinity ? maxLine : 1
    };
}

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
    if (toolName === 'view') {
        // view_range 字符串 → 数组
        if (input.view_range !== undefined && typeof input.view_range === 'string') {
            try {
                const parsed = JSON.parse(input.view_range);
                if (Array.isArray(parsed) && parsed.length === 2) {
                    input.view_range = parsed.map((n: any) => typeof n === 'string' ? parseInt(n, 10) : n);
                    log(`[FIX] view_range: string -> array`);
                }
            } catch (e) { /* ignore */ }
        }
        // view_range 负数修正 — 防止 "Invalid line range: startLine=-1, stopLine=-1"
        if (Array.isArray(input.view_range)) {
            input.view_range = input.view_range.map((n: number) => (typeof n === 'number' && n < 1) ? 1 : n);
            log(`[FIX] view_range: clamped negative values`);
        }
    }

    // ========== remove-files 参数修正 ==========
    if (toolName === 'remove-files') {
        // 确保 file_paths 存在且为数组 — 防止 "Cannot read properties of undefined (reading 'length')"
        if (!Array.isArray(input.file_paths)) {
            if (typeof input.file_paths === 'string') {
                input.file_paths = [input.file_paths];
                log(`[FIX] remove-files: file_paths string -> array`);
            } else if (input.paths && Array.isArray(input.paths)) {
                input.file_paths = input.paths;
                delete input.paths;
                log(`[FIX] remove-files: paths -> file_paths`);
            } else if (input.path && typeof input.path === 'string') {
                input.file_paths = [input.path];
                log(`[FIX] remove-files: path -> file_paths`);
            } else {
                input.file_paths = [];
                log(`[FIX] remove-files: file_paths was missing, set to empty array`);
            }
        }
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

    // ========== read-file 参数修正 ==========
    if (toolName === 'read-file') {
        // 扩展期望 file_path，但模型可能生成 path
        if (input.path !== undefined && input.file_path === undefined) {
            input.file_path = input.path; delete input.path;
            log(`[FIX] read-file: path -> file_path`);
        }
    }

    // ========== grep-search 参数修正 ==========
    if (toolName === 'grep-search') {
        // directory → directory_absolute_path
        if (input.directory !== undefined && input.directory_absolute_path === undefined) {
            input.directory_absolute_path = input.directory; delete input.directory;
            log(`[FIX] grep-search: directory -> directory_absolute_path`);
        }
        if (input.dir !== undefined && input.directory_absolute_path === undefined) {
            input.directory_absolute_path = input.dir; delete input.dir;
            log(`[FIX] grep-search: dir -> directory_absolute_path`);
        }
        // pattern → query
        if (input.pattern !== undefined && input.query === undefined) {
            input.query = input.pattern; delete input.pattern;
            log(`[FIX] grep-search: pattern -> query`);
        }
        if (input.search !== undefined && input.query === undefined) {
            input.query = input.search; delete input.search;
            log(`[FIX] grep-search: search -> query`);
        }
    }

    // ========== launch-process 参数修正 ==========
    if (toolName === 'launch-process') {
        // wait 字符串 → 布尔
        if (typeof input.wait === 'string') {
            input.wait = input.wait === 'true';
            log(`[FIX] launch-process: wait string -> boolean`);
        }
        // max_wait_seconds 字符串 → 数字
        if (typeof input.max_wait_seconds === 'string') {
            input.max_wait_seconds = parseInt(input.max_wait_seconds, 10);
            log(`[FIX] launch-process: max_wait_seconds string -> number`);
        }
    }

    // ========== save-file instructions_reminder 修正 ==========
    if (toolName === 'save-file') {
        if (!input.instructions_reminder) {
            input.instructions_reminder = 'LIMIT THE FILE CONTENT TO AT MOST 150 LINES. IF MORE CONTENT NEEDS TO BE ADDED USE THE str-replace-editor TOOL TO EDIT THE FILE AFTER IT HAS BEEN CREATED.';
        }
    }

    // ========== 通用布尔字符串修正 ==========
    const boolFields = ['wait', 'case_sensitive', 'only_selected', 'keep_stdin_open', 'add_last_line_newline'];
    for (const field of boolFields) {
        if (typeof input[field] === 'string') {
            input[field] = input[field] === 'true';
            log(`[FIX] ${toolName}: ${field} string -> boolean`);
        }
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

// ========== 任务列表工具定义（供三个 provider 共用） ==========
const TASKLIST_TOOL_DEFS = {
    view_tasklist: {
        description: '查看当前任务列表，返回所有任务的树形结构和状态统计',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false }
    },
    update_tasks: {
        description: '批量更新任务状态。state 可选值: NOT_STARTED, IN_PROGRESS, COMPLETE, CANCELLED',
        parameters: {
            type: 'object' as const,
            properties: {
                updates: {
                    type: 'array',
                    description: '要更新的任务数组',
                    items: {
                        type: 'object',
                        properties: {
                            uuid: { type: 'string', description: '任务 UUID（前8位即可）' },
                            state: { type: 'string', enum: ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED'] }
                        },
                        required: ['uuid', 'state']
                    }
                }
            },
            required: ['updates'],
            additionalProperties: false
        }
    },
    add_tasks: {
        description: '批量添加新任务到任务列表',
        parameters: {
            type: 'object' as const,
            properties: {
                tasks: {
                    type: 'array',
                    description: '要添加的任务数组',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: '任务名称' },
                            description: { type: 'string', description: '任务描述' },
                            parent_uuid: { type: 'string', description: '父任务 UUID（可选，用于创建子任务）' }
                        },
                        required: ['name']
                    }
                }
            },
            required: ['tasks'],
            additionalProperties: false
        }
    },
    reorganize_tasklist: {
        description: '使用 Markdown 格式重新组织整个任务列表。格式: [ ] UUID:xxx NAME:任务名 DESCRIPTION:描述',
        parameters: {
            type: 'object' as const,
            properties: {
                tasklist: { type: 'string', description: 'Markdown 格式的完整任务列表' }
            },
            required: ['tasklist'],
            additionalProperties: false
        }
    }
};

// ========== 转换 Augment tool_definitions 到 Anthropic tools 格式 ==========
export function convertToolDefinitions(toolDefs: any[]): any[] | undefined {
    if (!toolDefs || toolDefs.length === 0)
        return undefined;
    const tools: any[] = [];
    for (const def of toolDefs) {
        // 跳过 edit-file：proxy 模式下不支持服务端编辑
        if (def.name === 'edit-file') {
            continue;
        }
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
    // 任务列表工具通过 system prompt 文字描述 + convertOrInterceptFileEdit 拦截实现
    // 不注入到 tools schema，避免某些 API 不兼容
    // v3.4.0: 注入新增工具（bash/glob/grep/file_read/list_directory）
    if (state.toolRegistry) {
        tools.push(...getExtraToolsAnthropic());
    }
    return tools.length > 0 ? tools : undefined;
}
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
        // 跳过 edit-file：proxy 模式下不支持服务端编辑
        if (def.name === 'edit-file') {
            continue;
        }
        if (def.name) {
            // ✅ 新增：支持 builtin_function 类型（如 $web_search）
            const toolType = def.type || 'function';
            const isBuiltinFunction = toolType === 'builtin_function';

            // builtin_function 不需要 parameters 和 description
            if (isBuiltinFunction) {
                tools.push({
                    type: 'builtin_function',
                    function: {
                        name: def.name
                    }
                });
                log(`[BUILTIN] Added builtin_function: ${def.name}`);
                continue;
            }

            // 普通 function 需要 parameters
            // ⚠️ 关键修复：Augment 扩展发送的字段名是 input_schema_json（不是 input_json_schema）
            let parameters = def.input_schema_json || def.input_json_schema;
            if (typeof parameters === 'string') {
                try {
                    parameters = JSON.parse(parameters);
                } catch (e) {
                    log(`[WARN] Failed to parse input_schema_json for ${def.name}: ${e}`);
                    parameters = { type: 'object', properties: {} };
                }
            }
            if (def.name === 'save-file') {
                log(`[DEBUG] save-file tool schema: ${JSON.stringify(parameters)}`);
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
    // 任务列表工具通过 system prompt 文字描述 + convertOrInterceptFileEdit 拦截实现
    // 不注入到 tools schema，避免某些 API 不兼容
    // v3.4.0: 注入新增工具（bash/glob/grep/file_read/list_directory）
    if (state.toolRegistry) {
        tools.push(...getExtraToolsOpenAI());
    }
    return tools.length > 0 ? tools : undefined;
}

// ========== 转换工具定义到 Gemini 格式 ==========
export function convertToolDefinitionsToGemini(toolDefs: any[]): any[] {
    if (!toolDefs || toolDefs.length === 0) return [];
    const tools: any[] = [];
    for (const def of toolDefs) {
        if (!def.name) continue;
        // 跳过 edit-file：proxy 模式下不支持服务端编辑
        if (def.name === 'edit-file') {
            continue;
        }
        // ⚠️ 关键修复：Augment 扩展发送的字段名是 input_schema_json
        let parameters = def.input_schema_json || def.input_json_schema || def.input_schema;
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
    // 任务列表工具通过 system prompt 文字描述 + convertOrInterceptFileEdit 拦截实现
    // 不注入到 tools schema，避免某些 API 不兼容
    // v3.4.0: 注入新增工具（bash/glob/grep/file_read/list_directory）
    if (state.toolRegistry) {
        tools.push(...getExtraToolsGemini());
    }
    return tools;
}
// Augment 插件标记 str-replace-editor 为不支持的工具（unsupportedSidecarTools）
// 策略：拦截这些工具调用，直接在代理层执行文件编辑，然后返回成功结果
// ========== str-replace-editor 核心匹配逻辑（基于 Augment 逆向） ==========
function findMatchInContent(content: string, oldStr: string, startLine?: number, endLine?: number): { index: number; matchedStr: string } | null {
    const lines = content.split('\n');

    // 1. 逐字精确匹配
    let index = content.indexOf(oldStr);
    if (index !== -1) {
        return { index, matchedStr: oldStr };
    }

    // 2. 如果提供了行号，尝试在行号范围内匹配（带 20% 容差）
    if (startLine !== undefined && endLine !== undefined && startLine > 0 && endLine > 0) {
        const tolerance = 0.2;
        const rangeStart = Math.max(0, Math.floor(startLine - 1 - (endLine - startLine + 1) * tolerance));
        const rangeEnd = Math.min(lines.length - 1, Math.ceil(endLine - 1 + (endLine - startLine + 1) * tolerance));

        const rangeContent = lines.slice(rangeStart, rangeEnd + 1).join('\n');
        const rangeOffset = lines.slice(0, rangeStart).join('\n').length + (rangeStart > 0 ? 1 : 0);

        index = rangeContent.indexOf(oldStr);
        if (index !== -1) {
            return { index: rangeOffset + index, matchedStr: oldStr };
        }
    }

    // 3. 基础模糊匹配：trim 每行后再匹配
    const trimmedOld = oldStr.split('\n').map(l => l.trim()).join('\n');
    const trimmedContent = lines.map(l => l.trim()).join('\n');

    const trimmedIndex = trimmedContent.indexOf(trimmedOld);
    if (trimmedIndex !== -1) {
        // 找到 trimmed 匹配后，需要映射回原始内容的位置
        let charCount = 0;
        let trimmedCharCount = 0;
        for (let i = 0; i < lines.length; i++) {
            const originalLine = lines[i];
            const trimmedLine = originalLine.trim();

            if (trimmedCharCount === trimmedIndex) {
                return { index: charCount, matchedStr: oldStr };
            }

            if (trimmedCharCount > trimmedIndex) {
                break;
            }

            charCount += originalLine.length + 1; // +1 for \n
            trimmedCharCount += trimmedLine.length + 1;
        }
    }

    return null;
}

export function convertOrInterceptFileEdit(toolName: string, input: any, workspaceInfo: any): { toolName: string; input: any; intercepted?: boolean; result?: any } | null {
    const fs = require('fs');
    const path = require('path');

    // ========== 拦截任务列表工具 ==========
    if (toolName === 'view_tasklist' || toolName === 'reorganize_tasklist' ||
        toolName === 'update_tasks' || toolName === 'add_tasks') {
        const { globalTaskListStore, TaskListManager } = require('./tasklist');
        const conversationId = (workspaceInfo as any)?.conversationId || 'default';
        const taskList = globalTaskListStore.getOrCreate(conversationId);

        if (toolName === 'view_tasklist') {
            log(`[INTERCEPT] view_tasklist: returning current task list`);
            const formatted = taskList.formatTaskTree();
            const stats = taskList.getTaskStats();
            const result = formatted || '# 当前任务列表为空\n\n使用 add_tasks 工具创建新任务。';
            const statsText = `\n\n📊 任务统计: 总计 ${stats.total} | 未开始 ${stats.notStarted} | 进行中 ${stats.inProgress} | 已完成 ${stats.complete} | 已取消 ${stats.cancelled}`;

            return {
                toolName,
                input,
                intercepted: true,
                result: result + statsText + '\n\n' + TaskListManager.getTaskListInstructions()
            };
        }

        if (toolName === 'reorganize_tasklist') {
            log(`[INTERCEPT] reorganize_tasklist: parsing and updating task list`);
            const markdown = input.tasklist || input.task_list || input.markdown || '';

            if (!markdown) {
                return {
                    toolName,
                    input,
                    intercepted: true,
                    result: { success: false, error: '缺少任务列表内容' }
                };
            }

            try {
                const parsed = taskList.parseMarkdownTaskList(markdown);
                if (!parsed) {
                    return {
                        toolName,
                        input,
                        intercepted: true,
                        result: { success: false, error: '任务列表解析失败' }
                    };
                }

                const stats = taskList.getTaskStats();
                return {
                    toolName,
                    input,
                    intercepted: true,
                    result: {
                        success: true,
                        message: `✅ 任务列表已更新\n\n📊 统计: 总计 ${stats.total} | 未开始 ${stats.notStarted} | 进行中 ${stats.inProgress} | 已完成 ${stats.complete} | 已取消 ${stats.cancelled}`,
                        stats
                    }
                };
            } catch (e: any) {
                log(`[INTERCEPT] reorganize_tasklist error: ${e.message}`);
                return {
                    toolName,
                    input,
                    intercepted: true,
                    result: { success: false, error: `任务列表解析失败: ${e.message}` }
                };
            }
        }

        if (toolName === 'update_tasks') {
            log(`[INTERCEPT] update_tasks: updating task states`);
            const updates = input.updates || input.tasks || [];

            if (!Array.isArray(updates) || updates.length === 0) {
                return {
                    toolName,
                    input,
                    intercepted: true,
                    result: { success: false, error: '缺少更新内容' }
                };
            }

            const results: string[] = [];
            for (const update of updates) {
                const uuid = update.uuid || update.id;
                const newState = update.state || update.status;

                if (!uuid || !newState) {
                    results.push(`❌ 缺少 UUID 或状态`);
                    continue;
                }

                const success = taskList.updateTaskState(uuid, newState);
                if (success) {
                    results.push(`✅ 任务 ${uuid.slice(0, 8)} 状态已更新为 ${newState}`);
                } else {
                    results.push(`❌ 任务 ${uuid.slice(0, 8)} 未找到`);
                }
            }

            return {
                toolName,
                input,
                intercepted: true,
                result: {
                    success: true,
                    message: results.join('\n')
                }
            };
        }

        if (toolName === 'add_tasks') {
            log(`[INTERCEPT] add_tasks: adding new tasks`);
            const tasks = input.tasks || input.new_tasks || [];

            if (!Array.isArray(tasks) || tasks.length === 0) {
                return {
                    toolName,
                    input,
                    intercepted: true,
                    result: { success: false, error: '缺少任务内容' }
                };
            }

            const results: string[] = [];
            for (const taskData of tasks) {
                const parentUuid = taskData.parent_uuid || taskData.parent || null;
                const name = taskData.name || taskData.title || '未命名任务';
                const description = taskData.description || taskData.desc || '';

                const newTask = taskList.addTask(parentUuid, name, description);
                if (newTask) {
                    results.push(`✅ 已创建任务 ${newTask.uuid.slice(0, 8)}: ${name}`);
                } else {
                    results.push(`❌ 创建任务失败: ${name}`);
                }
            }

            return {
                toolName,
                input,
                intercepted: true,
                result: {
                    success: true,
                    message: results.join('\n')
                }
            };
        }
    }

    // ========== 拦截 $web_search：原封不动返回 arguments ==========
    // Kimi 内置的联网搜索工具，需要将 arguments 原封不动返回给 Kimi
    if (toolName === '$web_search') {
        log(`[INTERCEPT] $web_search: returning arguments as-is for Kimi to execute`);
        return {
            toolName,
            input,
            intercepted: true,
            result: input  // 原封不动返回 arguments
        };
    }

    // ========== 拦截 apply_patch：转换为 str-replace-editor ==========
    // apply_patch 使用 diff/patch 格式，我们将其转换为 str-replace-editor 格式
    if (toolName === 'apply_patch' || toolName === 'apply-patch') {
        log(`[INTERCEPT] apply_patch: parsing patch and converting to str-replace-editor`);

        const patchInput = input.input || input.patch || '';
        if (!patchInput) {
            return {
                toolName,
                input,
                intercepted: true,
                result: { success: false, error: 'Missing patch input' }
            };
        }

        try {
            // 先输出原始 patch 内容的前 500 字符用于调试
            log(`[DEBUG] apply_patch raw input (first 500 chars):\n${patchInput.substring(0, 500)}`);

            const parsedPatches = parsePatchInput(patchInput);

            if (parsedPatches.length === 0) {
                return {
                    toolName,
                    input,
                    intercepted: true,
                    result: { success: false, error: 'No valid patches found in input' }
                };
            }

            log(`[INTERCEPT] apply_patch: parsed ${parsedPatches.length} patch(es)`);

            // 应用所有 patches
            const results: string[] = [];
            const allDiffs: Array<{ file: string; oldStr: string; newStr: string }> = [];
            for (const patch of parsedPatches) {
                log(`[INTERCEPT] apply_patch: applying patch to ${patch.filePath}`);
                log(`[DEBUG] apply_patch oldContent (${patch.oldContent.length} chars):\n${patch.oldContent.substring(0, 200)}...`);
                log(`[DEBUG] apply_patch newContent (${patch.newContent.length} chars):\n${patch.newContent.substring(0, 200)}...`);
                log(`[DEBUG] apply_patch startLine=${patch.startLine}, endLine=${patch.endLine}`);

                let result: any;

                // 如果 oldContent 为空，说明是完整文件替换，使用 save-file
                if (patch.oldContent === '') {
                    log(`[INTERCEPT] apply_patch: using save-file for complete file replacement`);
                    const saveFileInput = {
                        path: patch.filePath,
                        file_content: patch.newContent,
                        add_last_line_newline: true
                    };
                    result = convertOrInterceptFileEdit('save-file', saveFileInput, workspaceInfo);
                } else {
                    // 否则使用 str-replace-editor 进行部分替换
                    log(`[INTERCEPT] apply_patch: using str-replace-editor for partial replacement`);
                    const strReplaceInput = {
                        path: patch.filePath,
                        command: 'str_replace',
                        old_str: patch.oldContent,
                        new_str: patch.newContent,
                        old_str_start_line_number: patch.startLine,
                        old_str_end_line_number: patch.endLine,
                        instruction_reminder: 'ALWAYS BREAK DOWN EDITS INTO SMALLER CHUNKS OF AT MOST 150 LINES EACH.'
                    };
                    result = convertOrInterceptFileEdit('str-replace-editor', strReplaceInput, workspaceInfo);
                }

                if (result?.intercepted && result.result) {
                    if (result.result.success) {
                        results.push(`✅ ${patch.filePath}: ${result.result.message || 'success'}`);
                        // 聚合子结果的 diffs
                        if (result.result.diffs) {
                            allDiffs.push(...result.result.diffs);
                        }
                    } else {
                        results.push(`❌ ${patch.filePath}: ${result.result.error || 'failed'}`);
                    }
                }
            }

            const allSuccess = results.every(r => r.startsWith('✅'));

            return {
                toolName,
                input,
                intercepted: true,
                result: {
                    success: allSuccess,
                    message: results.join('\n'),
                    diffs: allDiffs
                }
            };

        } catch (e: any) {
            log(`[INTERCEPT] apply_patch error: ${e.message}`);
            return {
                toolName,
                input,
                intercepted: true,
                result: { success: false, error: `Patch parsing failed: ${e.message}` }
            };
        }
    }

    // ========== 拦截 str-replace-editor：直接执行文件编辑 ==========
    if (toolName === 'str-replace-editor') {
        const filePath = input.path || input.file_path;
        const command = input.command || 'str_replace';

        if (!filePath) {
            log(`[INTERCEPT] str-replace-editor missing path`);
            return {
                toolName,
                input,
                intercepted: true,
                result: { success: false, error: 'Missing path parameter' }
            };
        }

        const repoRoot = workspaceInfo?.repositoryRoot || workspaceInfo?.workspacePath || '';
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);

        try {
            if (!fs.existsSync(fullPath)) {
                log(`[INTERCEPT] str-replace-editor: file not found: ${fullPath}`);
                return {
                    toolName,
                    input,
                    intercepted: true,
                    result: { success: false, error: `File not found: ${filePath}` }
                };
            }

            let content = fs.readFileSync(fullPath, 'utf-8');
            const originalLineEnding = content.includes('\r\n') ? '\r\n' : '\n';

            // 标准化行尾为 LF（匹配 Augment 的 OD() 函数）
            content = content.replace(/\r\n/g, '\n');

            // ========== 处理 insert 命令 ==========
            if (command === 'insert') {
                const insertLine = input.insert_line_1 || input.insert_line;
                const newStr = input.new_str_1 || input.new_str;

                if (insertLine === undefined || newStr === undefined) {
                    return {
                        toolName,
                        input,
                        intercepted: true,
                        result: { success: false, error: 'insert command requires insert_line and new_str' }
                    };
                }

                const lines = content.split('\n');
                const lineNum = parseInt(insertLine);

                if (lineNum < 0 || lineNum > lines.length) {
                    return {
                        toolName,
                        input,
                        intercepted: true,
                        result: { success: false, error: `insert_line ${lineNum} out of range (0-${lines.length})` }
                    };
                }

                lines.splice(lineNum, 0, newStr);
                content = lines.join('\n');

                // 恢复原始行尾
                if (originalLineEnding === '\r\n') {
                    content = content.replace(/\n/g, '\r\n');
                }

                fs.writeFileSync(fullPath, content, 'utf-8');
                log(`[INTERCEPT] ✅ str-replace-editor (insert): inserted at line ${lineNum} in ${filePath}`);

                return {
                    toolName,
                    input,
                    intercepted: true,
                    result: {
                        success: true,
                        message: `Successfully inserted at line ${lineNum} in ${filePath}`,
                        diffs: [{ file: filePath, oldStr: '', newStr }]
                    }
                };
            }

            // ========== 处理 str_replace 命令（支持多条目） ==========
            if (command === 'str_replace') {
                // 收集所有替换条目
                const replacements: Array<{ oldStr: string; newStr: string; startLine?: number; endLine?: number }> = [];

                for (let i = 1; i <= 20; i++) {
                    const oldStr = input[`old_str_${i}`];
                    if (!oldStr) {
                        if (i === 1) {
                            // 尝试无后缀的参数名
                            const fallbackOld = input.old_str;
                            const fallbackNew = input.new_str;
                            if (fallbackOld) {
                                replacements.push({
                                    oldStr: fallbackOld,
                                    newStr: fallbackNew || '',
                                    startLine: input.old_str_start_line_number,
                                    endLine: input.old_str_end_line_number
                                });
                            }
                        }
                        break;
                    }

                    replacements.push({
                        oldStr,
                        newStr: input[`new_str_${i}`] || '',
                        startLine: input[`old_str_start_line_number_${i}`],
                        endLine: input[`old_str_end_line_number_${i}`]
                    });
                }

                if (replacements.length === 0) {
                    return {
                        toolName,
                        input,
                        intercepted: true,
                        result: { success: false, error: 'No replacement entries found (missing old_str_1 or old_str)' }
                    };
                }

                log(`[INTERCEPT] str-replace-editor: processing ${replacements.length} replacement(s)`);

                // 按顺序执行所有替换
                const diffs: Array<{ file: string; oldStr: string; newStr: string }> = [];
                for (let i = 0; i < replacements.length; i++) {
                    const { oldStr, newStr, startLine, endLine } = replacements[i];

                    const match = findMatchInContent(content, oldStr, startLine, endLine);

                    if (!match) {
                        log(`[INTERCEPT] str-replace-editor: replacement ${i + 1} failed - old_str not found`);
                        return {
                            toolName,
                            input,
                            intercepted: true,
                            result: {
                                success: false,
                                error: `Replacement ${i + 1}/${replacements.length} failed: old_str not found in file${startLine ? ` (around lines ${startLine}-${endLine})` : ''}`
                            }
                        };
                    }

                    // 执行替换
                    content = content.substring(0, match.index) + newStr + content.substring(match.index + match.matchedStr.length);
                    diffs.push({ file: filePath, oldStr: match.matchedStr, newStr });
                    log(`[INTERCEPT] str-replace-editor: replacement ${i + 1}/${replacements.length} succeeded`);
                }

                // 恢复原始行尾
                if (originalLineEnding === '\r\n') {
                    content = content.replace(/\n/g, '\r\n');
                }

                fs.writeFileSync(fullPath, content, 'utf-8');
                log(`[INTERCEPT] ✅ str-replace-editor: successfully applied ${replacements.length} replacement(s) to ${filePath}`);

                return {
                    toolName,
                    input,
                    intercepted: true,
                    result: { success: true, message: `Successfully applied ${replacements.length} replacement(s) to ${filePath}`, diffs }
                };
            }

            // 未知命令
            return {
                toolName,
                input,
                intercepted: true,
                result: { success: false, error: `Unknown command: ${command}` }
            };

        } catch (e: any) {
            log(`[INTERCEPT] str-replace-editor error: ${e.message}`);
            return {
                toolName,
                input,
                intercepted: true,
                result: { success: false, error: e.message }
            };
        }
    }

    // ========== 拦截 edit-file：直接返回错误，提示使用 str-replace-editor ==========
    if (toolName === 'edit-file') {
        log(`[INTERCEPT] edit-file: not supported, returning error`);
        return {
            toolName,
            input,
            intercepted: true,
            result: {
                success: false,
                error: 'Server-side edit-file is not supported in proxy mode. Please use str-replace-editor tool instead to make precise edits.'
            }
        };
    }

    // ========== 拦截 save-file 覆盖已有文件：直接执行写入 ==========
    if (toolName === 'save-file') {
        const filePath = input.path || input.file_path;
        const fileContent = input.file_content || input.content;

        if (!filePath || fileContent === undefined) {
            log(`[INTERCEPT] save-file missing path or content`);
            return null;
        }

        const repoRoot = workspaceInfo?.repositoryRoot || workspaceInfo?.workspacePath || '';
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);

        if (fs.existsSync(fullPath)) {
            log(`[INTERCEPT] ❌ save-file REJECTED on existing file: ${filePath} — must use str-replace-editor or apply_patch`);
            return {
                toolName,
                input,
                intercepted: true,
                result: {
                    success: false,
                    error: `REJECTED: File "${filePath}" already exists. You MUST use str-replace-editor (command: str_replace) or apply_patch to make targeted edits to existing files. save-file is ONLY for creating NEW files that do not exist yet. Re-read the file with the view tool, then use str-replace-editor with old_str/new_str to make precise changes.`
                }
            };
        }

        // 文件不存在 → 新建文件，本地直接执行
        try {
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, fileContent, 'utf-8');
            log(`[INTERCEPT] ✅ save-file: created new file ${filePath}`);
            return {
                toolName,
                input,
                intercepted: true,
                result: {
                    success: true,
                    message: `Created new file ${filePath}`,
                    diffs: [{ file: filePath, oldStr: '', newStr: fileContent }]
                }
            };
        } catch (e: any) {
            log(`[INTERCEPT] save-file create error: ${e.message}`);
            return {
                toolName,
                input,
                intercepted: true,
                result: { success: false, error: e.message }
            };
        }
    }

    return null;
}

// ========== 处理工具调用并转换为 Augment 格式 ==========
// ========== 渲染 diff 文本供流式输出 ==========
export function renderDiffText(interceptResult: any, toolName: string): string {
    if (!interceptResult) return '';
    const diffs: Array<{ file: string; oldStr: string; newStr: string }> = interceptResult.diffs;
    if (!diffs || diffs.length === 0) {
        // 没有 diff 数据，只返回状态
        return interceptResult.success ? `\n✅ ${toolName}\n` : `\n❌ ${toolName} failed\n`;
    }

    const parts: string[] = [];
    for (const diff of diffs) {
        const fileName = diff.file;
        const oldLines = (diff.oldStr || '').split('\n');
        const newLines = (diff.newStr || '').split('\n');

        // 新建文件
        if (!diff.oldStr && diff.newStr) {
            const preview = newLines.slice(0, 15);
            parts.push(`\n✅ **${toolName}** → \`${fileName}\` (新建)\n\`\`\`\n${preview.join('\n')}${newLines.length > 15 ? '\n... (+' + (newLines.length - 15) + ' lines)' : ''}\n\`\`\`\n`);
            continue;
        }

        // 完整文件覆盖（太大则跳过详细diff）
        if (oldLines.length > 50 && newLines.length > 50) {
            parts.push(`\n✅ **${toolName}** → \`${fileName}\` (${oldLines.length} → ${newLines.length} lines)\n`);
            continue;
        }

        // 计算行级 diff
        const removed: string[] = [];
        const added: string[] = [];
        const maxShow = 12;

        for (const line of oldLines) {
            if (removed.length < maxShow) removed.push(`- ${line}`);
        }
        if (oldLines.length > maxShow) removed.push(`  ... (${oldLines.length - maxShow} more removed)`);
        for (const line of newLines) {
            if (added.length < maxShow) added.push(`+ ${line}`);
        }
        if (newLines.length > maxShow) added.push(`  ... (${newLines.length - maxShow} more added)`);

        parts.push(`\n✅ **${toolName}** → \`${fileName}\`\n\`\`\`diff\n${removed.join('\n')}\n${added.join('\n')}\n\`\`\`\n`);
    }
    return parts.join('') || (interceptResult.success ? `\n✅ ${toolName}\n` : `\n❌ ${toolName} failed\n`);
}

// 🔧 重构：使用 fixToolCallInput() 替代重复的内联逻辑
// 🔧 新增：智能工具转换和拦截（edit-file/save-file/str-replace-editor）
// 返回值：
//   - { type: 5, tool_use: {...} } - 正常工具调用，发送给 Augment
//   - { type: 1, tool_result_node: {...} } - 拦截工具，直接返回结果给 AI
//   - null - 跳过（如截断的工具调用）
export async function processToolCallForAugment(
    tc: { id: string; name: string; arguments: string },
    workspaceInfo: any,
    finishReason: string | null
): Promise<any> {
    log(`[TOOL] Processing: ${tc.name}, id=${tc.id}`);

    if (!tc.arguments || tc.arguments === '' || tc.arguments === '{}') {
        log(`[WARN] Tool ${tc.name} has empty arguments!`);
    }

    let inputJson = tc.arguments || '{}';
    let finalToolName = tc.name;

    try {
        let parsed = JSON.parse(tc.arguments);

        // 🔧 智能转换和拦截：edit-file/save-file/str-replace-editor
        const converted = convertOrInterceptFileEdit(tc.name, parsed, workspaceInfo);
        if (converted) {
            // 如果是拦截（直接执行），返回 tool_result 给 AI
            if (converted.intercepted) {
                log(`[INTERCEPT] ${tc.name} executed directly, result: ${JSON.stringify(converted.result)}`);
                return {
                    type: 1, // TOOL_RESULT
                    tool_result_node: {
                        tool_use_id: tc.id,
                        tool_name: tc.name,
                        content: JSON.stringify(converted.result)
                    }
                };
            }

            // 如果是转换，使用转换后的工具名和参数
            finalToolName = converted.toolName;
            parsed = converted.input;
            log(`[CONVERT] ${tc.name} → ${finalToolName}`);
        }

        // v3.4.0: 新工具通过 ToolRegistry 异步拦截
        if (!converted && state.toolRegistry?.isIntercepted(tc.name)) {
            try {
                const context = {
                    workspacePath: workspaceInfo?.workspacePath || '',
                    repositoryRoot: workspaceInfo?.repositoryRoot || workspaceInfo?.workspacePath || '',
                    cwd: workspaceInfo?.workspacePath || process.cwd(),
                    conversationId: workspaceInfo?.conversationId || 'default',
                };
                const toolResult = await state.toolRegistry.execute(tc.name, parsed, context);
                if (toolResult) {
                    log(`[INTERCEPT] ${tc.name} executed via ToolRegistry`);
                    return {
                        type: 1,
                        tool_result_node: {
                            tool_use_id: tc.id,
                            tool_name: tc.name,
                            content: JSON.stringify(toolResult)
                        }
                    };
                }
            } catch (e: any) {
                log(`[REGISTRY] Tool ${tc.name} error: ${e.message}`);
                return {
                    type: 1,
                    tool_result_node: {
                        tool_use_id: tc.id,
                        tool_name: tc.name,
                        content: JSON.stringify({ success: false, error: e.message })
                    }
                };
            }
        }

        const fixed = fixToolCallInput(finalToolName, parsed, workspaceInfo);
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
            tool_name: finalToolName,
            input_json: inputJson
        }
    };
}

