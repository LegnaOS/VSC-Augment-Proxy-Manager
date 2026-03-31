// ===== ApplyPatchTool =====
// 从 tools.ts convertOrInterceptFileEdit 的 apply_patch 分支提取

import { buildTool, ToolResult, ToolContext } from './Tool';
import { parsePatchInput } from './shared/patch-parser';
import { StrReplaceEditorTool } from './StrReplaceEditorTool';
import { SaveFileTool } from './SaveFileTool';
import { log } from '../globals';

export const ApplyPatchTool = buildTool({
    name: 'apply_patch',
    aliases: ['apply-patch'],
    description: '应用 diff/patch 格式的文件修改，支持 Augment V4A 和标准 Unified Diff 格式',
    inputSchema: {
        type: 'object',
        properties: {
            input: { type: 'string' },
            patch: { type: 'string' },
        }
    },

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const patchInput = (input.input || input.patch || '') as string;
        if (!patchInput) {
            return { success: false, content: '', error: 'Missing patch input' };
        }

        try {
            log(`[DEBUG] apply_patch raw input (first 500 chars):\n${patchInput.substring(0, 500)}`);
            const parsedPatches = parsePatchInput(patchInput);

            if (parsedPatches.length === 0) {
                return { success: false, content: '', error: 'No valid patches found in input' };
            }

            log(`[INTERCEPT] apply_patch: parsed ${parsedPatches.length} patch(es)`);

            const results: string[] = [];
            const allDiffs: Array<{ file: string; oldStr: string; newStr: string }> = [];

            for (const patch of parsedPatches) {
                let result: ToolResult;

                if (patch.oldContent === '') {
                    // 完整文件替换 → save-file
                    result = await SaveFileTool.call({
                        path: patch.filePath,
                        file_content: patch.newContent,
                        add_last_line_newline: true
                    }, context);
                } else {
                    // 部分替换 → str-replace-editor
                    result = await StrReplaceEditorTool.call({
                        path: patch.filePath,
                        command: 'str_replace',
                        old_str: patch.oldContent,
                        new_str: patch.newContent,
                        old_str_start_line_number: patch.startLine,
                        old_str_end_line_number: patch.endLine,
                    }, context);
                }

                if (result.success) {
                    results.push(`✅ ${patch.filePath}: ${result.content || 'success'}`);
                    if (result.diffs) allDiffs.push(...result.diffs);
                } else {
                    results.push(`❌ ${patch.filePath}: ${result.error || 'failed'}`);
                }
            }

            const allSuccess = results.every(r => r.startsWith('✅'));
            return {
                success: allSuccess,
                content: results.join('\n'),
                diffs: allDiffs
            };
        } catch (e: any) {
            return { success: false, content: '', error: `Patch parsing failed: ${e.message}` };
        }
    }
});
