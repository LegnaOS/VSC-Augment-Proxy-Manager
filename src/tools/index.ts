// ===== 工具系统入口 =====
// 注册所有工具到全局 ToolRegistry

import { globalToolRegistry } from './ToolRegistry';

// 现有工具（从 tools.ts 提取）
import { StrReplaceEditorTool } from './StrReplaceEditorTool';
import { SaveFileTool } from './SaveFileTool';
import { ApplyPatchTool } from './ApplyPatchTool';
import { TaskListTool } from './TaskListTool';
import { EditFileTool } from './EditFileTool';
import { WebSearchTool } from './WebSearchTool';
import { CodebaseSearchTool } from './CodebaseSearchTool';

// 新增工具
import { BashTool } from './BashTool';
import { GlobTool } from './GlobTool';
import { GrepTool } from './GrepTool';
import { FileReadTool } from './FileReadTool';
import { ListDirectoryTool } from './ListDirectoryTool';

export function registerAllTools(): void {
    // 现有工具
    globalToolRegistry.register(StrReplaceEditorTool);
    globalToolRegistry.register(SaveFileTool);
    globalToolRegistry.register(ApplyPatchTool);
    globalToolRegistry.register(TaskListTool);
    globalToolRegistry.register(EditFileTool);
    globalToolRegistry.register(WebSearchTool);
    globalToolRegistry.register(CodebaseSearchTool);

    // 新增工具
    globalToolRegistry.register(BashTool);
    globalToolRegistry.register(GlobTool);
    globalToolRegistry.register(GrepTool);
    globalToolRegistry.register(FileReadTool);
    globalToolRegistry.register(ListDirectoryTool);
}

// 重新导出
export { globalToolRegistry } from './ToolRegistry';
export { renderDiffText, renderDiffTextCompat } from './ToolResultFormatter';
export type { Tool, ToolResult, ToolContext, ToolDef } from './Tool';
export { buildTool } from './Tool';
