// ===== EditFileTool =====
// 返回错误的桩工具，提示使用 str-replace-editor

import { buildTool, ToolResult } from './Tool';

export const EditFileTool = buildTool({
    name: 'edit-file',
    aliases: ['edit_file'],
    description: '服务端编辑文件（代理模式不支持）',
    inputSchema: { type: 'object', properties: {} },

    async call(): Promise<ToolResult> {
        return {
            success: false,
            content: '',
            error: 'Server-side edit-file is not supported in proxy mode. Please use str-replace-editor tool instead to make precise edits.'
        };
    }
});
