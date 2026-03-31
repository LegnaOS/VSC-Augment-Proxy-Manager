// ===== 消息格式转换函数 =====
// Augment ↔ Anthropic / OpenAI / Gemini 消息格式互转

import { state, log } from './globals';
import { getOMCSystemPrompt, processOMCMagicKeywords } from './omc';

// ===== 从请求中提取工作区信息 =====
export function extractWorkspaceInfo(req: any): { workspacePath?: string; repositoryRoot?: string; currentFile?: string; cwd?: string; conversationId?: string } {
    const result: { workspacePath?: string; repositoryRoot?: string; currentFile?: string; cwd?: string; conversationId?: string } = {};
    if (req.path) {
        result.currentFile = req.path;
    }
    if (req.conversation_id) {
        result.conversationId = req.conversation_id;
    }
    if (req.nodes) {
        for (const node of req.nodes) {
            if (node.type === 4 && node.ide_state_node) {
                const ideState = node.ide_state_node;
                if (ideState.workspace_folders && Array.isArray(ideState.workspace_folders) && ideState.workspace_folders.length > 0) {
                    const firstFolder = ideState.workspace_folders[0];
                    if (firstFolder.folder_root) {
                        result.workspacePath = firstFolder.folder_root;
                    }
                    if (firstFolder.repository_root) {
                        result.repositoryRoot = firstFolder.repository_root;
                    }
                }
                if (ideState.current_terminal?.current_working_directory) {
                    result.cwd = ideState.current_terminal.current_working_directory;
                }
            }
        }
    }
    return result;
}

// ===== 构建系统提示 =====
export function buildSystemPrompt(req: any) {
    const parts: string[] = [];

    // 合并 proxy.ts 注入的 system_prompt（如 Viking L0 上下文）
    if (req.system_prompt) {
        parts.push(req.system_prompt);
    }

    const workspaceInfo = extractWorkspaceInfo(req);
    if (workspaceInfo.workspacePath || workspaceInfo.cwd || workspaceInfo.repositoryRoot) {
        const wsInfo: string[] = [];
        const workspacePath = workspaceInfo.workspacePath || workspaceInfo.cwd || '';
        const repoRoot = workspaceInfo.repositoryRoot || '';
        let relativeWorkspace = '';
        if (repoRoot && workspacePath && workspacePath.startsWith(repoRoot)) {
            relativeWorkspace = workspacePath.substring(repoRoot.length).replace(/^\//, '');
        }
        wsInfo.push(`Workspace folder: ${workspacePath}`);
        if (repoRoot && repoRoot !== workspacePath) {
            wsInfo.push(`Repository root: ${repoRoot}`);
        }
        if (workspaceInfo.cwd && workspaceInfo.cwd !== workspacePath) {
            wsInfo.push(`Current working directory: ${workspaceInfo.cwd}`);
        }
        if (workspaceInfo.currentFile) {
            wsInfo.push(`Current file: ${workspaceInfo.currentFile}`);
        }
        let pathGuidance = '';
        if (relativeWorkspace) {
            pathGuidance = `
CRITICAL PATH INSTRUCTIONS:
- The repository root is: ${repoRoot}
- The user's workspace is: ${workspacePath}
- The workspace is located at "${relativeWorkspace}" relative to the repository root
- For file operations (save-file, view, remove-files), paths are relative to the REPOSITORY ROOT
- Therefore, to create a file in the workspace, you MUST prefix paths with "${relativeWorkspace}/"
- Example: To create "myfile.txt" in the workspace, use path="${relativeWorkspace}/myfile.txt"
- Example: To create "doc/readme.md" in the workspace, use path="${relativeWorkspace}/doc/readme.md"
- For launch-process, use absolute paths or set cwd to "${workspacePath}"`;
        } else {
            pathGuidance = `
IMPORTANT: All file paths for save-file, view, and other file tools should be relative to: ${workspacePath}`;
        }
        parts.push(`<workspace_context>
${wsInfo.join('\n')}
${pathGuidance}
</workspace_context>`);
    }
    // 文件编辑工具使用规则 — 强制精确编辑
    parts.push(`<file_editing_rules>
CRITICAL FILE EDITING RULES — VIOLATION WILL CAUSE ERRORS:
1. To MODIFY an existing file: ALWAYS use str-replace-editor (with command="str_replace", old_str, new_str) or apply_patch. These tools make precise, targeted edits.
2. To CREATE a new file that does not exist: Use save-file.
3. NEVER use save-file on a file that already exists — the operation WILL BE REJECTED with an error.
4. When editing, provide the SMALLEST possible old_str that uniquely identifies the location. Do NOT regenerate the entire file content.
5. If you need to make multiple changes to one file, use str-replace-editor with multiple replacement entries (old_str_1/new_str_1, old_str_2/new_str_2, etc.) in a single call.
6. Before editing, use the view tool to read the current file content so your old_str matches exactly.
</file_editing_rules>`);

    if (req.user_guidelines) {
        parts.push(`# User Guidelines\n${req.user_guidelines}`);
    }
    if (req.workspace_guidelines) {
        parts.push(`# Workspace Guidelines\n${req.workspace_guidelines}`);
    }
    if (req.agent_memories) {
        parts.push(`# Memories\nHere are the memories from previous interactions between the AI assistant (you) and the user:\n\`\`\`\n${req.agent_memories}\n\`\`\``);
    }
    if (req.rules && Array.isArray(req.rules) && req.rules.length > 0) {
        const rulesContent: string[] = [];
        for (const rule of req.rules) {
            if (typeof rule === 'object' && rule.content) {
                const ruleName = rule.path || rule.name || 'unnamed';
                const ruleDesc = rule.description ? ` - ${rule.description}` : '';
                rulesContent.push(`## Rule: ${ruleName}${ruleDesc}\n${rule.content}`);
            } else if (typeof rule === 'string') {
                rulesContent.push(rule);
            }
        }
        if (rulesContent.length > 0) {
            parts.push(`# Additional Rules\n${rulesContent.join('\n\n')}`);
        }
    }
    if (state.currentConfig.provider === 'google') {
        parts.push(`
# CRITICAL: Response Requirements for Google Gemini
- You MUST ALWAYS provide a detailed text response explaining your analysis and findings
- After using tools, you MUST summarize what you learned and what it means
- NEVER end the conversation with only tool calls - always follow up with explanations
- When encountering errors, explain what went wrong and what you'll try next
- Provide step-by-step reasoning about your approach
- If you gather information, you MUST analyze and present it to the user
- Think of yourself as having a conversation - tools are just for gathering data, but you must discuss the results

Example good behavior:
1. Call tools to gather information
2. Analyze the results
3. Provide a comprehensive text response explaining what you found
4. Suggest next steps or ask clarifying questions

Example bad behavior (DO NOT DO THIS):
1. Call tools
2. End conversation without any text response ❌`);
    }
    // OMC (oh-my-claudecode) 系统提示注入
    if (state.currentConfig.omcEnabled) {
        const omcPrompt = getOMCSystemPrompt();
        if (omcPrompt) {
            parts.push(omcPrompt);
            log(`[OMC] System prompt injected (mode: ${state.currentConfig.omcMode}, continuation: ${state.currentConfig.omcContinuationEnforcement})`);
        }
    }

    // 任务列表系统提示注入
    const { globalTaskListStore, TaskListManager } = require('./tasklist');
    const conversationId = req.conversation_id || 'default';
    const taskList = globalTaskListStore.getOrCreate(conversationId);
    const currentTaskTree = taskList.formatTaskTree();

    if (currentTaskTree) {
        // 如果有任务列表，注入当前任务列表和指令
        const stats = taskList.getTaskStats();
        const nextTask = taskList.getNextTask();

        parts.push(`# 当前任务列表

${currentTaskTree}

📊 任务统计: 总计 ${stats.total} | 未开始 ${stats.notStarted} | 进行中 ${stats.inProgress} | 已完成 ${stats.complete} | 已取消 ${stats.cancelled}

${nextTask ? `🎯 下一个待执行任务: ${nextTask.name} (UUID: ${nextTask.uuid.slice(0, 8)})` : '✅ 所有任务已完成'}

${TaskListManager.getTaskListInstructions()}

## 任务列表工具
- **view_tasklist**: 查看当前任务列表
- **reorganize_tasklist**: 重新组织任务列表 (参数: tasklist - Markdown 格式的任务列表)
- **update_tasks**: 更新任务状态 (参数: updates - 包含 uuid 和 state 的数组)
- **add_tasks**: 添加新任务 (参数: tasks - 包含 name, description, parent_uuid 的数组)

## 工作流程
1. 开始执行任务前，使用 update_tasks 将任务状态改为 IN_PROGRESS ([/])
2. 完成任务后，使用 update_tasks 将任务状态改为 COMPLETE ([x])
3. 如果发现需要新的子任务，使用 add_tasks 添加
4. 定期使用 view_tasklist 查看任务进度
5. 按顺序完成任务，不要跳过`);
    } else {
        // 如果没有任务列表，只注入工具说明
        parts.push(`# 任务列表功能

你可以使用任务列表工具来组织和跟踪复杂的多步骤任务：

## 可用工具
- **view_tasklist**: 查看当前任务列表
- **reorganize_tasklist**: 创建或重新组织任务列表
- **update_tasks**: 更新任务状态
- **add_tasks**: 添加新任务

${TaskListManager.getTaskListInstructions()}

## 何时使用任务列表
- 用户要求执行复杂的多步骤任务时
- 需要跟踪多个相关任务的进度时
- 任务之间有依赖关系需要管理时

使用 reorganize_tasklist 创建任务列表，然后使用 update_tasks 跟踪进度。`);
    }

    // v2.0.0: Viking Session Memory 注入 — 从历史对话中学习到的用户偏好和 Agent 经验
    if (state.sessionMemory) {
        const memoryPrompt = state.sessionMemory.buildMemoryPrompt(500);
        if (memoryPrompt) {
            parts.push(`# Session Memory\n${memoryPrompt}`);
        }
    }

    return parts.join('\n\n');
}

// ===== 发送 Augment 格式错误响应 =====
export function sendAugmentError(res: any, message: string) {
    try {
        if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        }
        if (!res.writableEnded) {
            res.end(JSON.stringify({
                text: `Error: ${message}`,
                nodes: [],
                stop_reason: 1
            }) + '\n');
        }
    } catch (e) { /* 连接可能已关闭 */ }
}

interface NormalizedToolUse {
    id: string;
    name: string;
    input: any;
    inputJson: string;
    thoughtSignature?: string;
}

interface NormalizedToolResult {
    id: string;
    name: string;
    content: string;
}

interface NormalizedTurn {
    role: 'user' | 'assistant';
    text?: string;
    toolUses?: NormalizedToolUse[];
    toolResults?: NormalizedToolResult[];
    images?: Array<{ mimeType: string; data: string }>;
}

function getEffectiveChatHistory(req: any): any[] {
    return Array.isArray(req.compressed_chat_history) ? req.compressed_chat_history : (req.chat_history || []);
}

function isContinuationSignal(message?: string): boolean {
    return typeof message === 'string' && message.trim() === '...';
}

function getCurrentMessageText(req: any): string {
    const rawMessage = req.message || '';
    if (!rawMessage || isContinuationSignal(rawMessage)) {
        return '';
    }
    return state.currentConfig.omcEnabled ? processOMCMagicKeywords(rawMessage) : rawMessage;
}

function extractToolUses(nodes: any[] = []): NormalizedToolUse[] {
    const toolUses: NormalizedToolUse[] = [];
    for (const node of nodes) {
        if (node.type !== 5 || !node.tool_use) continue;
        const toolUse = node.tool_use;
        const inputJson = toolUse.input_json || '{}';
        let input: any = toolUse.input || {};
        if (toolUse.input_json) {
            try {
                input = JSON.parse(toolUse.input_json);
            } catch {
                input = toolUse.input || {};
            }
        }
        toolUses.push({
            id: toolUse.tool_use_id || toolUse.id,
            name: toolUse.tool_name || toolUse.name,
            input,
            inputJson,
            thoughtSignature: toolUse.thought_signature
        });
    }
    return toolUses;
}

function extractToolResults(nodes: any[] = []): NormalizedToolResult[] {
    const toolResults: NormalizedToolResult[] = [];
    for (const node of nodes) {
        if (node.type !== 1 || !node.tool_result_node) continue;
        const toolResult = node.tool_result_node;
        toolResults.push({
            id: toolResult.tool_call_id || toolResult.tool_use_id || toolResult.id || '',
            name: toolResult.tool_name || toolResult.name || 'unknown',
            content: toolResult.content || ''
        });
    }
    return toolResults;
}

function extractTextNodes(nodes: any[] = []): string[] {
    return nodes
        .filter((node: any) => node.type === 0 && node.text_node?.content)
        .map((node: any) => node.text_node.content);
}

function extractImageParts(nodes: any[] = []): Array<{ mimeType: string; data: string }> {
    const formatMap: Record<number, string> = { 1: 'image/png', 2: 'image/jpeg', 3: 'image/gif', 4: 'image/webp' };
    return nodes
        .filter((node: any) => node.type === 2 && node.image_node?.image_data)
        .map((node: any) => ({
            mimeType: formatMap[node.image_node.format] || 'image/png',
            data: node.image_node.image_data
        }));
}

function pushNormalizedTurn(turns: NormalizedTurn[], turn: NormalizedTurn | null) {
    if (!turn) return;
    const hasText = !!turn.text?.trim();
    const hasToolUses = !!turn.toolUses?.length;
    const hasToolResults = !!turn.toolResults?.length;
    const hasImages = !!turn.images?.length;
    if (!hasText && !hasToolUses && !hasToolResults && !hasImages) return;
    turns.push({
        ...turn,
        text: hasText ? turn.text!.trim() : undefined
    });
}

function buildNormalizedTurns(chatHistory: any[], req: any): NormalizedTurn[] {
    const turns: NormalizedTurn[] = [];

    for (const exchange of chatHistory) {
        pushNormalizedTurn(turns, {
            role: 'user',
            text: exchange.request_message || '',
            toolResults: extractToolResults(exchange.request_nodes || [])
        });

        const responseText = [
            extractTextNodes(exchange.response_nodes || []).join(''),
            exchange.response_text || exchange.response_message || ''
        ].find((content) => !!content) || '';

        pushNormalizedTurn(turns, {
            role: 'assistant',
            text: responseText,
            toolUses: extractToolUses(exchange.response_nodes || [])
        });
    }

    const currentMessage = getCurrentMessageText(req);
    const currentTextNodes = extractTextNodes(req.nodes || []).filter((content) => content !== currentMessage);
    pushNormalizedTurn(turns, {
        role: 'user',
        text: [...currentTextNodes, currentMessage].filter(Boolean).join('\n\n'),
        toolResults: extractToolResults(req.nodes || []),
        images: extractImageParts(req.nodes || [])
    });

    return turns;
}

function mergeNormalizedTurns(turns: NormalizedTurn[]): NormalizedTurn[] {
    const merged: NormalizedTurn[] = [];

    for (const turn of turns) {
        const previous = merged[merged.length - 1];
        if (!previous || previous.role !== turn.role) {
            merged.push({
                ...turn,
                toolUses: turn.toolUses ? [...turn.toolUses] : undefined,
                toolResults: turn.toolResults ? [...turn.toolResults] : undefined,
                images: turn.images ? [...turn.images] : undefined
            });
            continue;
        }

        previous.text = [previous.text, turn.text].filter(Boolean).join('\n\n') || undefined;
        if (turn.toolUses?.length) {
            previous.toolUses = [...(previous.toolUses || []), ...turn.toolUses];
        }
        if (turn.toolResults?.length) {
            previous.toolResults = [...(previous.toolResults || []), ...turn.toolResults];
        }
        if (turn.images?.length) {
            previous.images = [...(previous.images || []), ...turn.images];
        }
    }

    return merged;
}

function stabilizeToolTurnAdjacency(turns: NormalizedTurn[]): NormalizedTurn[] {
    const stabilized: NormalizedTurn[] = [];
    let pendingToolUses = 0;

    for (let i = 0; i < turns.length; i += 1) {
        const turn = turns[i];
        const toolResultCount = turn.role === 'user' ? (turn.toolResults?.length || 0) : 0;
        const nextTurn = turns[i + 1];
        const nextToolUseCount = nextTurn?.role === 'assistant' ? (nextTurn.toolUses?.length || 0) : 0;

        if (
            turn.role === 'user' &&
            toolResultCount > 0 &&
            pendingToolUses === 0 &&
            nextTurn?.role === 'assistant' &&
            nextToolUseCount > 0
        ) {
            stabilized.push(nextTurn, turn);
            pendingToolUses = Math.max(0, nextToolUseCount - toolResultCount);
            i += 1;
            continue;
        }

        stabilized.push(turn);

        if (turn.role === 'assistant' && (turn.toolUses?.length || 0) > 0) {
            pendingToolUses += turn.toolUses!.length;
            continue;
        }

        if (turn.role === 'user' && toolResultCount > 0 && pendingToolUses > 0) {
            pendingToolUses = Math.max(0, pendingToolUses - toolResultCount);
        }
    }

    return mergeNormalizedTurns(stabilized);
}

function scoreNormalizedTurns(turns: NormalizedTurn[]): number {
    let score = 0;
    let pendingToolUses = 0;

    for (const turn of turns) {
        if (turn.role === 'assistant') {
            if (turn.toolUses && turn.toolUses.length > 0) {
                if (pendingToolUses > 0) {
                    score -= pendingToolUses * 3;
                }
                pendingToolUses = turn.toolUses.length;
                score += turn.toolUses.length;
            }
            continue;
        }

        const toolResultCount = turn.toolResults?.length || 0;
        if (toolResultCount === 0) {
            continue;
        }

        if (pendingToolUses > 0) {
            const matchedCount = Math.min(toolResultCount, pendingToolUses);
            score += matchedCount * 4;
            score -= Math.abs(toolResultCount - pendingToolUses) * 2;
            pendingToolUses = Math.max(0, pendingToolUses - toolResultCount);
        } else {
            score -= toolResultCount * 4;
        }
    }

    if (pendingToolUses > 0) {
        score -= pendingToolUses * 3;
    }

    return score;
}

export function normalizeAugmentTimeline(req: any): NormalizedTurn[] {
    const chatHistory = getEffectiveChatHistory(req);
    const forwardTurns = stabilizeToolTurnAdjacency(buildNormalizedTurns(chatHistory, req));

    if (chatHistory.length <= 1) {
        return forwardTurns;
    }

    const reversedTurns = stabilizeToolTurnAdjacency(buildNormalizedTurns([...chatHistory].reverse(), req));
    const forwardScore = scoreNormalizedTurns(forwardTurns);
    const reversedScore = scoreNormalizedTurns(reversedTurns);

    if (reversedScore > forwardScore) {
        log(`[DEBUG] normalizeAugmentTimeline selected reversed chat_history order (forward=${forwardScore}, reversed=${reversedScore})`);
        return reversedTurns;
    }

    if (reversedScore < forwardScore) {
        log(`[DEBUG] normalizeAugmentTimeline kept forward chat_history order (forward=${forwardScore}, reversed=${reversedScore})`);
    }

    return forwardTurns;
}

function sanitizeKimiAnthropicToolName(name?: string): string {
    const sanitized = (name || 'tool')
        .replace(/[^A-Za-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return sanitized || 'tool';
}

function normalizeKimiAnthropicMessages(messages: any[]): any[] {
    if (state.currentConfig.provider !== 'kimi-anthropic') {
        return messages;
    }

    const counters = new Map<string, number>();
    const pendingToolUses: Array<{ originalId?: string; normalizedId: string }> = [];
    let rewrittenToolUses = 0;
    let rewrittenToolResults = 0;

    const normalizedMessages = messages.map((message: any) => {
        if (!message || typeof message !== 'object' || !Array.isArray(message.content)) {
            return message;
        }

        if (message.role === 'assistant') {
            const normalizedContent = message.content.map((part: any) => {
                if (part?.type !== 'tool_use') {
                    return part;
                }

                const toolName = sanitizeKimiAnthropicToolName(part.name);
                const currentIndex = counters.get(toolName) || 0;
                counters.set(toolName, currentIndex + 1);

                const normalizedId = `${toolName}:${currentIndex}`;
                pendingToolUses.push({ originalId: part.id, normalizedId });

                if (part.id !== normalizedId || part.name !== toolName) {
                    rewrittenToolUses += 1;
                }

                return {
                    ...part,
                    id: normalizedId,
                    name: toolName
                };
            });

            return { ...message, content: normalizedContent };
        }

        if (message.role === 'user') {
            const normalizedContent = message.content.map((part: any) => {
                if (part?.type !== 'tool_result') {
                    return part;
                }

                const matchedIndex = pendingToolUses.findIndex((toolUse) =>
                    toolUse.originalId === part.tool_use_id || toolUse.normalizedId === part.tool_use_id
                );
                const matched = matchedIndex >= 0
                    ? pendingToolUses.splice(matchedIndex, 1)[0]
                    : pendingToolUses.shift();

                if (!matched) {
                    return part;
                }

                if (part.tool_use_id !== matched.normalizedId) {
                    rewrittenToolResults += 1;
                }

                return {
                    ...part,
                    tool_use_id: matched.normalizedId
                };
            });

            return { ...message, content: normalizedContent };
        }

        return message;
    });

    if (rewrittenToolUses > 0 || rewrittenToolResults > 0) {
        log(`[KIMI-ANTHROPIC] Normalized ${rewrittenToolUses} tool_use id(s), ${rewrittenToolResults} tool_result id(s)`);
    }
    if (pendingToolUses.length > 0) {
        log(`[KIMI-ANTHROPIC] WARNING: ${pendingToolUses.length} tool_use(s) still have no matching tool_result after normalization`);
    }

    return normalizedMessages;
}

function buildAnthropicAssistantContent(turn: NormalizedTurn): any[] {
    const content: any[] = [];
    let textContent = turn.text || '';
    const shouldParseThinking = (state.currentConfig.provider === 'minimax' && state.currentConfig.enableInterleavedThinking) ||
        (state.currentConfig.provider === 'deepseek' && state.currentConfig.enableThinking) ||
        state.currentConfig.provider === 'kimi-anthropic';

    if (shouldParseThinking && textContent) {
        const thinkMatch = textContent.match(/<think>([\s\S]*?)<\/think>/);
        if (thinkMatch) {
            const thinkingPart: any = { type: 'thinking', thinking: thinkMatch[1].trim() };
            const thoughtSignature = (turn.toolUses || []).find((toolUse) => !!toolUse.thoughtSignature)?.thoughtSignature;
            if (thoughtSignature) {
                thinkingPart.signature = thoughtSignature;
            }
            content.push(thinkingPart);
            log(`[DEBUG] Parsed thinking from history, length: ${thinkMatch[1].length}`);
            textContent = textContent.replace(/<think>[\s\S]*?<\/think>\s*/, '').trim();
        }
    }

    if (textContent) {
        content.push({ type: 'text', text: textContent });
    }

    for (const toolUse of turn.toolUses || []) {
        content.push({
            type: 'tool_use',
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input
        });
    }

    return content;
}

function buildAnthropicUserContent(turn: NormalizedTurn): any[] {
    const content: any[] = [];

    for (const toolResult of turn.toolResults || []) {
        content.push({
            type: 'tool_result',
            tool_use_id: toolResult.id,
            content: toolResult.content || ''
        });
    }

    for (const image of turn.images || []) {
        content.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: image.mimeType,
                data: image.data
            }
        });
    }

    if (turn.text) {
        content.push({ type: 'text', text: turn.text });
    }

    return content;
}

// ===== 将 Augment 请求转换为 Anthropic messages 格式 =====
export function augmentToAnthropicMessages(req: any) {
    const messages: any[] = [];
    for (const turn of normalizeAugmentTimeline(req)) {
        if (turn.role === 'assistant') {
            if (turn.toolUses && turn.toolUses.length > 0) {
                const content = buildAnthropicAssistantContent(turn);
                messages.push({ role: 'assistant', content });
                log(`[DEBUG] Added assistant message with ${turn.toolUses.length} tool_use(s)`);
            } else if (turn.text) {
                messages.push({ role: 'assistant', content: turn.text });
            }
            continue;
        }

        const content = buildAnthropicUserContent(turn);
        if (content.length === 1 && content[0].type === 'text') {
            messages.push({ role: 'user', content: content[0].text });
        } else if (content.length > 0) {
            messages.push({ role: 'user', content });
            const toolResultCount = (turn.toolResults || []).length;
            if (toolResultCount > 0) {
                log(`[DEBUG] Added ${toolResultCount} tool_result(s) to messages`);
            }
        }
    }

    if (messages.length === 0) {
        messages.push({ role: 'user', content: 'Hello' });
    }

    return normalizeKimiAnthropicMessages(messages);
}


export function splitReasoningContentFromText(text?: string): { content?: string; reasoningContent?: string } {
    if (!text) {
        return {};
    }

    const reasoningParts: string[] = [];
    const content = text
        .replace(/<think>([\s\S]*?)<\/think>/g, (_, reasoningPart: string) => {
            const trimmedReasoning = reasoningPart.trim();
            if (trimmedReasoning) {
                reasoningParts.push(trimmedReasoning);
            }
            return '';
        })
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return {
        content: content || undefined,
        reasoningContent: reasoningParts.join('\n\n') || undefined
    };
}



// ===== 将 Augment 请求转换为 OpenAI 格式消息 =====
export function augmentToOpenAIMessages(req: any) {
    const messages: any[] = [];
    for (const turn of normalizeAugmentTimeline(req)) {
        if (turn.role === 'assistant') {
            if (turn.toolUses && turn.toolUses.length > 0) {
                const { content, reasoningContent } = splitReasoningContentFromText(turn.text);
                const assistantMessage: any = {
                    role: 'assistant',
                    tool_calls: turn.toolUses.map((toolUse) => ({
                        id: toolUse.id,
                        type: 'function',
                        function: { name: toolUse.name, arguments: toolUse.inputJson }
                    }))
                };
                if (content) {
                    assistantMessage.content = content;
                } else {
                    assistantMessage.content = '';
                }
                // reasoning_content 只有部分 provider 支持回传（DeepSeek/Kimi）
                // GLM 不支持，会导致 "messages 参数非法" 400 错误
                const supportsReasoningReplay = ['deepseek', 'kimi'].includes(state.currentConfig.provider);
                if (reasoningContent && supportsReasoningReplay) {
                    assistantMessage.reasoning_content = reasoningContent;
                }
                messages.push(assistantMessage);
                continue;
            }

            if (turn.text) {
                messages.push({ role: 'assistant', content: turn.text });
            }
            continue;
        }

        for (const toolResult of turn.toolResults || []) {
            const toolMsg: any = {
                role: 'tool',
                tool_call_id: toolResult.id,
                content: toolResult.content || ''
            };
            // GLM 不支持 tool 消息中的 name 字段，会导致 "messages 参数非法"
            if (state.currentConfig.provider !== 'glm') {
                toolMsg.name = toolResult.name || 'unknown';
            }
            messages.push(toolMsg);
        }

        if (turn.text) {
            messages.push({ role: 'user', content: turn.text });
        }
    }

    if (messages.length === 0) {
        messages.push({ role: 'user', content: 'Hello' });
    }

    return messages;
}

// ===== 转换 Augment 消息到 Gemini 格式 =====
export function augmentToGeminiMessages(req: any): any[] {
    const messages: any[] = [];
    const pushGeminiMessage = (role: 'user' | 'model', parts: any[]) => {
        if (parts.length === 0) return;
        if (role === 'model' && messages.length === 0) {
            log(`[GOOGLE] Skipping leading model turn without a preceding user turn`);
            return;
        }
        const previous = messages[messages.length - 1];
        if (previous && previous.role === role) {
            previous.parts.push(...parts);
            return;
        }
        messages.push({ role, parts });
    };

    for (const turn of normalizeAugmentTimeline(req)) {
        if (turn.role === 'assistant') {
            const modelParts: any[] = [];
            if (turn.text) {
                modelParts.push({ text: turn.text });
            }
            for (const toolUse of turn.toolUses || []) {
                const part: any = { functionCall: { name: toolUse.name, args: toolUse.input } };
                if (toolUse.thoughtSignature) {
                    part.thoughtSignature = toolUse.thoughtSignature;
                }
                modelParts.push(part);
            }
            pushGeminiMessage('model', modelParts);
            continue;
        }

        const userParts: any[] = [];
        for (const toolResult of turn.toolResults || []) {
            userParts.push({
                functionResponse: {
                    name: toolResult.name || 'unknown',
                    response: { result: toolResult.content || '' }
                }
            });
        }
        if (turn.text) {
            userParts.push({ text: turn.text });
        }
        for (const image of turn.images || []) {
            userParts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
        }
        pushGeminiMessage('user', userParts);
    }

    if (messages.length === 0) {
        log(`[GOOGLE] WARNING: No messages generated, adding placeholder`);
        messages.push({ role: 'user', parts: [{ text: 'Hello' }] });
    } else if (messages[0].role !== 'user') {
        log(`[GOOGLE] WARNING: First compiled turn is not user, dropping it to satisfy Gemini ordering`);
        while (messages.length > 0 && messages[0].role !== 'user') {
            messages.shift();
        }
        if (messages.length === 0) {
            messages.push({ role: 'user', parts: [{ text: 'Hello' }] });
        }
    }

    log(`[GOOGLE] Final message sequence: ${messages.map((m: any) => m.role).join(' → ')}`);
    return messages;
}