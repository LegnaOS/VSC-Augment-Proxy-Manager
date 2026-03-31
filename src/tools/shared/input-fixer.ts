// ===== 通用参数修正 =====
// 从 fixToolCallInput 提取非路径相关的参数修正逻辑

import { log } from '../../globals';

export function fixGenericInput(toolName: string, input: any): any {
    // Playwright 参数修正
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

    // view 参数修正
    if (toolName === 'view') {
        if (input.view_range !== undefined && typeof input.view_range === 'string') {
            try {
                const parsed = JSON.parse(input.view_range);
                if (Array.isArray(parsed) && parsed.length === 2) {
                    input.view_range = parsed.map((n: any) => typeof n === 'string' ? parseInt(n, 10) : n);
                }
            } catch (e) { /* ignore */ }
        }
        if (Array.isArray(input.view_range)) {
            input.view_range = input.view_range.map((n: number) => (typeof n === 'number' && n < 1) ? 1 : n);
        }
    }

    // remove-files 参数修正
    if (toolName === 'remove-files') {
        if (!Array.isArray(input.file_paths)) {
            if (typeof input.file_paths === 'string') { input.file_paths = [input.file_paths]; }
            else if (input.paths && Array.isArray(input.paths)) { input.file_paths = input.paths; delete input.paths; }
            else if (input.path && typeof input.path === 'string') { input.file_paths = [input.path]; }
            else { input.file_paths = []; }
        }
    }

    // save-file 参数修正
    if (toolName === 'save-file') {
        if (input.content !== undefined && input.file_content === undefined) { input.file_content = input.content; delete input.content; }
        if (input.file !== undefined && input.file_content === undefined) { input.file_content = input.file; delete input.file; }
        if (!input.instructions_reminder) {
            input.instructions_reminder = 'LIMIT THE FILE CONTENT TO AT MOST 150 LINES. IF MORE CONTENT NEEDS TO BE ADDED USE THE str-replace-editor TOOL TO EDIT THE FILE AFTER IT HAS BEEN CREATED.';
        }
    }

    // str-replace-editor 参数修正
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

    // read-file 参数修正
    if (toolName === 'read-file') {
        if (input.path !== undefined && input.file_path === undefined) { input.file_path = input.path; delete input.path; }
    }

    // grep-search 参数修正
    if (toolName === 'grep-search') {
        if (input.directory !== undefined && input.directory_absolute_path === undefined) { input.directory_absolute_path = input.directory; delete input.directory; }
        if (input.dir !== undefined && input.directory_absolute_path === undefined) { input.directory_absolute_path = input.dir; delete input.dir; }
        if (input.pattern !== undefined && input.query === undefined) { input.query = input.pattern; delete input.pattern; }
        if (input.search !== undefined && input.query === undefined) { input.query = input.search; delete input.search; }
    }

    // launch-process 参数修正
    if (toolName === 'launch-process') {
        if (typeof input.wait === 'string') { input.wait = input.wait === 'true'; }
        if (typeof input.max_wait_seconds === 'string') { input.max_wait_seconds = parseInt(input.max_wait_seconds, 10); }
    }

    // 通用布尔字符串修正
    const boolFields = ['wait', 'case_sensitive', 'only_selected', 'keep_stdin_open', 'add_last_line_newline'];
    for (const field of boolFields) {
        if (typeof input[field] === 'string') {
            input[field] = input[field] === 'true';
        }
    }

    return input;
}
