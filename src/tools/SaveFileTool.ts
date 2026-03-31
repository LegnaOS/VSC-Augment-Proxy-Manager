// ===== SaveFileTool =====
// 从 tools.ts convertOrInterceptFileEdit 的 save-file 分支提取

import { buildTool, ToolResult, ToolContext } from './Tool';
import { log } from '../globals';

export const SaveFileTool = buildTool({
    name: 'save-file',
    aliases: ['save_file'],
    description: '创建新文件。仅用于创建不存在的文件，已有文件必须使用 str-replace-editor 编辑',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string' },
            file_content: { type: 'string' },
        },
        required: ['path', 'file_content']
    },

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const fs = require('fs');
        const path = require('path');

        const filePath = (input.path || input.file_path) as string;
        const fileContent = (input.file_content || input.content) as string;

        if (!filePath || fileContent === undefined) {
            return { success: false, content: '', error: 'Missing path or file_content' };
        }

        const repoRoot = context.repositoryRoot || context.workspacePath;
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);

        if (fs.existsSync(fullPath)) {
            log(`[INTERCEPT] ❌ save-file REJECTED on existing file: ${filePath}`);
            return {
                success: false, content: '',
                error: `REJECTED: File "${filePath}" already exists. You MUST use str-replace-editor (command: str_replace) or apply_patch to make targeted edits to existing files. save-file is ONLY for creating NEW files that do not exist yet. Re-read the file with the view tool, then use str-replace-editor with old_str/new_str to make precise changes.`
            };
        }

        try {
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, fileContent, 'utf-8');
            log(`[INTERCEPT] ✅ save-file: created new file ${filePath}`);
            return {
                success: true,
                content: `Created new file ${filePath}`,
                diffs: [{ file: filePath, oldStr: '', newStr: fileContent }]
            };
        } catch (e: any) {
            return { success: false, content: '', error: e.message };
        }
    }
});
