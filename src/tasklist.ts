// ===== 任务列表系统 (基于 Augment 逆向工程) =====
// 实现与 Augment 兼容的任务列表功能

import * as crypto from 'crypto';
import { log } from './globals';

// ========== 任务状态枚举 ==========
export enum TaskState {
    NOT_STARTED = '[ ]',
    IN_PROGRESS = '[/]',
    COMPLETE = '[x]',
    CANCELLED = '[-]'
}

// ========== 任务数据结构 ==========
export interface Task {
    uuid: string;
    name: string;
    description: string;
    state: keyof typeof TaskState;
    level: number;
    subTasks?: string[];        // 子任务的 UUID 列表
    subTasksData?: Task[];      // 子任务的完整数据
}

// ========== 任务列表管理器 ==========
export class TaskListManager {
    private rootTask: Task | null = null;
    private taskMap: Map<string, Task> = new Map();

    constructor() {}

    // 生成短 UUID (8字符)
    private generateShortUUID(): string {
        return crypto.randomBytes(4).toString('hex');
    }

    // 格式化 UUID (显示前8位)
    private formatUUID(uuid: string): string {
        return uuid.slice(0, 8);
    }

    // 解析 Markdown 格式的任务列表
    parseMarkdownTaskList(markdown: string): Task | null {
        const lines = markdown.split('\n').filter(line => line.trim());
        if (lines.length === 0) return null;

        const taskStack: Array<{ task: Task; level: number }> = [];
        let root: Task | null = null;

        for (const line of lines) {
            const task = this.parseTaskLine(line);
            if (!task) continue;

            // 清理栈：移除所有 level >= 当前 level 的任务
            while (taskStack.length > 0 && taskStack[taskStack.length - 1].level >= task.level) {
                taskStack.pop();
            }

            // 如果是根任务 (level 0)
            if (task.level === 0) {
                root = task;
                taskStack.push({ task, level: 0 });
            } else {
                // 添加到父任务
                if (taskStack.length > 0) {
                    const parent = taskStack[taskStack.length - 1].task;
                    if (!parent.subTasks) parent.subTasks = [];
                    if (!parent.subTasksData) parent.subTasksData = [];
                    parent.subTasks.push(task.uuid);
                    parent.subTasksData.push(task);
                }
                taskStack.push({ task, level: task.level });
            }

            this.taskMap.set(task.uuid, task);
        }

        this.rootTask = root;
        return root;
    }

    // 解析单行任务
    private parseTaskLine(line: string): Task | null {
        // 计算缩进级别 (每个 '-' 代表一级)
        let level = 0;
        let idx = 0;
        while (idx < line.length && line[idx] === '-') {
            level++;
            idx++;
        }

        // 提取状态标记
        const stateMatch = line.match(/\[([ \/x\-])\]/);
        if (!stateMatch) return null;

        const stateChar = stateMatch[1];
        let state: keyof typeof TaskState;
        switch (stateChar) {
            case ' ': state = 'NOT_STARTED'; break;
            case '/': state = 'IN_PROGRESS'; break;
            case 'x': state = 'COMPLETE'; break;
            case '-': state = 'CANCELLED'; break;
            default: return null;
        }

        // 提取 UUID, NAME, DESCRIPTION
        const uuidMatch = line.match(/UUID:([a-zA-Z0-9_]+)/);
        const nameMatch = line.match(/NAME:([^D]+?)(?=\s+DESCRIPTION:|$)/);
        const descMatch = line.match(/DESCRIPTION:(.+?)$/);

        if (!uuidMatch || !nameMatch || !descMatch) return null;

        const uuid = uuidMatch[1] === 'NEW_UUID' ? this.generateShortUUID() : uuidMatch[1];
        const name = nameMatch[1].trim();
        const description = descMatch[1].trim();

        return { uuid, name, description, state, level };
    }

    // 将任务树转换为 Markdown 格式
    formatTaskTree(task: Task | null = this.rootTask, includeSubtasks: boolean = true): string {
        if (!task) return '';

        const lines: string[] = [];
        this.formatTaskRecursive(task, lines, includeSubtasks);
        return lines.join('\n');
    }

    private formatTaskRecursive(task: Task, lines: string[], includeSubtasks: boolean) {
        const indent = '-'.repeat(task.level);
        const state = TaskState[task.state];
        const uuid = this.formatUUID(task.uuid);
        lines.push(`${indent}${state} UUID:${uuid} NAME:${task.name} DESCRIPTION:${task.description}`);

        if (includeSubtasks && task.subTasksData) {
            for (const subtask of task.subTasksData) {
                this.formatTaskRecursive(subtask, lines, includeSubtasks);
            }
        }
    }

    // 查找任务
    findTask(uuid: string): Task | null {
        return this.taskMap.get(uuid) || null;
    }

    // 更新任务状态
    updateTaskState(uuid: string, newState: keyof typeof TaskState): boolean {
        const task = this.findTask(uuid);
        if (!task) return false;
        task.state = newState;
        return true;
    }

    // 添加新任务
    addTask(parentUuid: string | null, name: string, description: string): Task | null {
        const uuid = this.generateShortUUID();
        const level = parentUuid ? (this.findTask(parentUuid)?.level || 0) + 1 : 0;
        const task: Task = {
            uuid,
            name,
            description,
            state: 'NOT_STARTED',
            level
        };

        if (parentUuid) {
            const parent = this.findTask(parentUuid);
            if (!parent) return null;
            if (!parent.subTasks) parent.subTasks = [];
            if (!parent.subTasksData) parent.subTasksData = [];
            parent.subTasks.push(uuid);
            parent.subTasksData.push(task);
        } else {
            this.rootTask = task;
        }

        this.taskMap.set(uuid, task);
        return task;
    }

    // 删除任务
    deleteTask(uuid: string): boolean {
        const task = this.findTask(uuid);
        if (!task) return false;

        // 递归删除子任务
        if (task.subTasksData) {
            for (const subtask of task.subTasksData) {
                this.deleteTask(subtask.uuid);
            }
        }

        this.taskMap.delete(uuid);
        return true;
    }

    // 获取所有任务的扁平列表
    getAllTasks(): Task[] {
        return Array.from(this.taskMap.values());
    }

    // 获取任务统计
    getTaskStats(): { total: number; notStarted: number; inProgress: number; complete: number; cancelled: number } {
        const tasks = this.getAllTasks();
        return {
            total: tasks.length,
            notStarted: tasks.filter(t => t.state === 'NOT_STARTED').length,
            inProgress: tasks.filter(t => t.state === 'IN_PROGRESS').length,
            complete: tasks.filter(t => t.state === 'COMPLETE').length,
            cancelled: tasks.filter(t => t.state === 'CANCELLED').length
        };
    }

    // 获取下一个待执行的任务
    getNextTask(): Task | null {
        const tasks = this.getAllTasks();
        // 优先返回 IN_PROGRESS 的任务
        const inProgress = tasks.find(t => t.state === 'IN_PROGRESS');
        if (inProgress) return inProgress;
        // 否则返回第一个 NOT_STARTED 的任务
        return tasks.find(t => t.state === 'NOT_STARTED') || null;
    }

    // 生成任务列表指令文本
    static getTaskListInstructions(): string {
        return `# 任务列表使用说明

## 任务状态标记
- ${TaskState.NOT_STARTED} = 未开始 (尚未开始的任务)
- ${TaskState.IN_PROGRESS} = 进行中 (正在执行的任务)
- ${TaskState.COMPLETE} = 已完成 (已完成的任务)
- ${TaskState.CANCELLED} = 已取消 (不再需要的任务)

## 任务层级结构
- 根任务 (无缩进): [ ] UUID:xxx NAME:yyy DESCRIPTION:zzz
- 一级子任务 (一个'-'): -[ ] UUID:xxx NAME:yyy DESCRIPTION:zzz
- 二级子任务 (两个'-'): --[ ] UUID:xxx NAME:yyy DESCRIPTION:zzz
- 每个子任务必须有一个上一级的父任务

## 工作流程
1. 开始任务时，将状态改为 [/] (进行中)
2. 完成任务后，将状态改为 [x] (已完成)
3. 如果任务不再需要，将状态改为 [-] (已取消)
4. 新任务使用 UUID:NEW_UUID，系统会自动生成真实 UUID

## 重要规则
- 必须按顺序完成任务，不要跳过
- 每次只专注于一个任务 (状态为 [/])
- 完成当前任务后，自动开始下一个未开始的任务
- 保持任务列表的层级结构正确`;
    }
}

// ========== 会话级任务列表存储 ==========
export class SessionTaskListStore {
    private taskLists: Map<string, TaskListManager> = new Map();

    getOrCreate(conversationId: string): TaskListManager {
        if (!this.taskLists.has(conversationId)) {
            this.taskLists.set(conversationId, new TaskListManager());
        }
        return this.taskLists.get(conversationId)!;
    }

    delete(conversationId: string): void {
        this.taskLists.delete(conversationId);
    }

    clear(): void {
        this.taskLists.clear();
    }
}

// 全局任务列表存储
export const globalTaskListStore = new SessionTaskListStore();
