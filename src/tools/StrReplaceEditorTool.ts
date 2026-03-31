// ===== StrReplaceEditorTool =====
// 从 tools.ts convertOrInterceptFileEdit 的 str-replace-editor 分支提取

import { buildTool, ToolResult, ToolContext } from './Tool';
import { log } from '../globals';

function findMatchInContent(content: string, oldStr: string, startLine?: number, endLine?: number): { index: number; matchedStr: string } | null {
    const lines = content.split('\n');

    // 1. 逐字精确匹配
    let index = content.indexOf(oldStr);
    if (index !== -1) return { index, matchedStr: oldStr };

    // 2. 行号范围匹配（20% 容差）
    if (startLine !== undefined && endLine !== undefined && startLine > 0 && endLine > 0) {
        const tolerance = 0.2;
        const rangeStart = Math.max(0, Math.floor(startLine - 1 - (endLine - startLine + 1) * tolerance));
        const rangeEnd = Math.min(lines.length - 1, Math.ceil(endLine - 1 + (endLine - startLine + 1) * tolerance));
        const rangeContent = lines.slice(rangeStart, rangeEnd + 1).join('\n');
        const rangeOffset = lines.slice(0, rangeStart).join('\n').length + (rangeStart > 0 ? 1 : 0);
        index = rangeContent.indexOf(oldStr);
        if (index !== -1) return { index: rangeOffset + index, matchedStr: oldStr };
    }

    // 3. trim 模糊匹配
    const trimmedOld = oldStr.split('\n').map(l => l.trim()).join('\n');
    const trimmedContent = lines.map(l => l.trim()).join('\n');
    const trimmedIndex = trimmedContent.indexOf(trimmedOld);
    if (trimmedIndex !== -1) {
        let charCount = 0;
        let trimmedCharCount = 0;
        for (let i = 0; i < lines.length; i++) {
            const originalLine = lines[i];
            const trimmedLine = originalLine.trim();
            if (trimmedCharCount === trimmedIndex) return { index: charCount, matchedStr: oldStr };
            if (trimmedCharCount > trimmedIndex) break;
            charCount += originalLine.length + 1;
            trimmedCharCount += trimmedLine.length + 1;
        }
    }

    return null;
}

export const StrReplaceEditorTool = buildTool({
    name: 'str-replace-editor',
    aliases: ['str_replace_editor'],
    description: '精确编辑文件内容，支持 insert（插入）和 str_replace（替换）两种命令',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string' },
            command: { type: 'string' },
            old_str_1: { type: 'string' },
            new_str_1: { type: 'string' },
            insert_line_1: { type: 'number' },
        },
        required: ['path']
    },

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const fs = require('fs');
        const path = require('path');

        const filePath = (input.path || input.file_path) as string;
        const command = (input.command || 'str_replace') as string;

        if (!filePath) {
            return { success: false, content: '', error: 'Missing path parameter' };
        }

        const repoRoot = context.repositoryRoot || context.workspacePath;
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);

        try {
            if (!fs.existsSync(fullPath)) {
                return { success: false, content: '', error: `File not found: ${filePath}` };
            }

            let content = fs.readFileSync(fullPath, 'utf-8');
            const originalLineEnding = content.includes('\r\n') ? '\r\n' : '\n';
            content = content.replace(/\r\n/g, '\n');

            // insert 命令
            if (command === 'insert') {
                const insertLine = (input.insert_line_1 || input.insert_line) as number;
                const newStr = (input.new_str_1 || input.new_str) as string;

                if (insertLine === undefined || newStr === undefined) {
                    return { success: false, content: '', error: 'insert command requires insert_line and new_str' };
                }

                const lines = content.split('\n');
                const lineNum = parseInt(String(insertLine));

                if (lineNum < 0 || lineNum > lines.length) {
                    return { success: false, content: '', error: `insert_line ${lineNum} out of range (0-${lines.length})` };
                }

                lines.splice(lineNum, 0, newStr);
                content = lines.join('\n');
                if (originalLineEnding === '\r\n') content = content.replace(/\n/g, '\r\n');
                fs.writeFileSync(fullPath, content, 'utf-8');
                log(`[INTERCEPT] ✅ str-replace-editor (insert): inserted at line ${lineNum} in ${filePath}`);

                return {
                    success: true,
                    content: `Successfully inserted at line ${lineNum} in ${filePath}`,
                    diffs: [{ file: filePath, oldStr: '', newStr }]
                };
            }

            // str_replace 命令（支持多条目）
            if (command === 'str_replace') {
                const replacements: Array<{ oldStr: string; newStr: string; startLine?: number; endLine?: number }> = [];

                for (let i = 1; i <= 20; i++) {
                    const oldStr = input[`old_str_${i}`] as string;
                    if (!oldStr) {
                        if (i === 1) {
                            const fallbackOld = input.old_str as string;
                            const fallbackNew = (input.new_str || '') as string;
                            if (fallbackOld) {
                                replacements.push({
                                    oldStr: fallbackOld,
                                    newStr: fallbackNew,
                                    startLine: input.old_str_start_line_number as number,
                                    endLine: input.old_str_end_line_number as number
                                });
                            }
                        }
                        break;
                    }
                    replacements.push({
                        oldStr,
                        newStr: (input[`new_str_${i}`] || '') as string,
                        startLine: input[`old_str_start_line_number_${i}`] as number,
                        endLine: input[`old_str_end_line_number_${i}`] as number
                    });
                }

                if (replacements.length === 0) {
                    return { success: false, content: '', error: 'No replacement entries found (missing old_str_1 or old_str)' };
                }

                const diffs: Array<{ file: string; oldStr: string; newStr: string }> = [];
                for (let i = 0; i < replacements.length; i++) {
                    const { oldStr, newStr, startLine, endLine } = replacements[i];
                    const match = findMatchInContent(content, oldStr, startLine, endLine);

                    if (!match) {
                        return {
                            success: false, content: '',
                            error: `Replacement ${i + 1}/${replacements.length} failed: old_str not found in file${startLine ? ` (around lines ${startLine}-${endLine})` : ''}`
                        };
                    }

                    content = content.substring(0, match.index) + newStr + content.substring(match.index + match.matchedStr.length);
                    diffs.push({ file: filePath, oldStr: match.matchedStr, newStr });
                }

                if (originalLineEnding === '\r\n') content = content.replace(/\n/g, '\r\n');
                fs.writeFileSync(fullPath, content, 'utf-8');
                log(`[INTERCEPT] ✅ str-replace-editor: applied ${replacements.length} replacement(s) to ${filePath}`);

                return {
                    success: true,
                    content: `Successfully applied ${replacements.length} replacement(s) to ${filePath}`,
                    diffs
                };
            }

            return { success: false, content: '', error: `Unknown command: ${command}` };
        } catch (e: any) {
            return { success: false, content: '', error: e.message };
        }
    }
});
