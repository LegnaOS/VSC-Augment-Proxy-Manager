// ===== TaskListTool =====
// 从 tools.ts convertOrInterceptFileEdit 的任务列表分支提取

import { buildTool, ToolResult, ToolContext } from './Tool';
import { log } from '../globals';

export const TaskListTool = buildTool({
    name: 'view_tasklist',
    aliases: ['reorganize_tasklist', 'update_tasks', 'add_tasks'],
    description: '任务列表管理工具，支持查看/重组/更新/添加任务',
    inputSchema: { type: 'object', properties: {} },

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const { globalTaskListStore, TaskListManager } = require('../tasklist');
        const conversationId = context.conversationId || 'default';
        const taskList = globalTaskListStore.getOrCreate(conversationId);
        // 通过 _toolName 传入实际调用的工具名
        const toolName = (input._toolName || 'view_tasklist') as string;

        if (toolName === 'view_tasklist') {
            const formatted = taskList.formatTaskTree();
            const stats = taskList.getTaskStats();
            const result = formatted || '# 当前任务列表为空\n\n使用 add_tasks 工具创建新任务。';
            const statsText = `\n\n📊 任务统计: 总计 ${stats.total} | 未开始 ${stats.notStarted} | 进行中 ${stats.inProgress} | 已完成 ${stats.complete} | 已取消 ${stats.cancelled}`;
            return { success: true, content: result + statsText + '\n\n' + TaskListManager.getTaskListInstructions() };
        }

        if (toolName === 'reorganize_tasklist') {
            const markdown = (input.tasklist || input.task_list || input.markdown || '') as string;
            if (!markdown) return { success: false, content: '', error: '缺少任务列表内容' };
            try {
                const parsed = taskList.parseMarkdownTaskList(markdown);
                if (!parsed) return { success: false, content: '', error: '任务列表解析失败' };
                const stats = taskList.getTaskStats();
                return { success: true, content: `✅ 任务列表已更新\n\n📊 统计: 总计 ${stats.total} | 未开始 ${stats.notStarted} | 进行中 ${stats.inProgress} | 已完成 ${stats.complete} | 已取消 ${stats.cancelled}` };
            } catch (e: any) {
                return { success: false, content: '', error: `任务列表解析失败: ${e.message}` };
            }
        }

        if (toolName === 'update_tasks') {
            const updates = (input.updates || input.tasks || []) as any[];
            if (!Array.isArray(updates) || updates.length === 0) return { success: false, content: '', error: '缺少更新内容' };
            const results: string[] = [];
            for (const update of updates) {
                const uuid = update.uuid || update.id;
                const newState = update.state || update.status;
                if (!uuid || !newState) { results.push(`❌ 缺少 UUID 或状态`); continue; }
                const success = taskList.updateTaskState(uuid, newState);
                results.push(success ? `✅ 任务 ${uuid.slice(0, 8)} 状态已更新为 ${newState}` : `❌ 任务 ${uuid.slice(0, 8)} 未找到`);
            }
            return { success: true, content: results.join('\n') };
        }

        if (toolName === 'add_tasks') {
            const tasks = (input.tasks || input.new_tasks || []) as any[];
            if (!Array.isArray(tasks) || tasks.length === 0) return { success: false, content: '', error: '缺少任务内容' };
            const results: string[] = [];
            for (const taskData of tasks) {
                const parentUuid = taskData.parent_uuid || taskData.parent || null;
                const name = taskData.name || taskData.title || '未命名任务';
                const description = taskData.description || taskData.desc || '';
                const newTask = taskList.addTask(parentUuid, name, description);
                results.push(newTask ? `✅ 已创建任务 ${newTask.uuid.slice(0, 8)}: ${name}` : `❌ 创建任务失败: ${name}`);
            }
            return { success: true, content: results.join('\n') };
        }

        return { success: false, content: '', error: `Unknown tasklist operation: ${toolName}` };
    }
});
