// ===== 消息格式转换函数 =====
// Augment ↔ Anthropic / OpenAI / Gemini 消息格式互转

import { state, log } from './globals';

// ===== 从请求中提取工作区信息 =====
export function extractWorkspaceInfo(req: any): { workspacePath?: string; repositoryRoot?: string; currentFile?: string; cwd?: string } {
    const result: { workspacePath?: string; repositoryRoot?: string; currentFile?: string; cwd?: string } = {};
    if (req.path) {
        result.currentFile = req.path;
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

// ===== 将 Augment 请求转换为 Anthropic messages 格式 =====
export function augmentToAnthropicMessages(req: any) {
    const messages: any[] = [];
    // Anthropic API 要求每个 tool_use 后必须紧跟对应的 tool_result
    // Augment 结构：exchange[i].response_nodes → tool_use, exchange[i+1].request_nodes → tool_result
    for (let i = 0; i < (req.chat_history || []).length; i++) {
        const exchange = req.chat_history[i];
        const nextExchange = req.chat_history[i + 1];
        if (i === 0) {
            log(`[DEBUG] chat_history[0] keys: ${Object.keys(exchange).join(',')}`);
        }
        // 1. 添加用户消息
        if (exchange.request_message && exchange.request_message.trim()) {
            messages.push({ role: 'user', content: exchange.request_message });
        }
        // 2. 处理 response_nodes
        const responseNodes = exchange.response_nodes || [];
        const toolUses: any[] = [];
        let textContent = '';
        for (const node of responseNodes) {
            if (node.type === 5 && node.tool_use) {
                const tu = node.tool_use;
                const input = tu.input_json ? JSON.parse(tu.input_json) : (tu.input || {});
                toolUses.push({
                    type: 'tool_use',
                    id: tu.tool_use_id || tu.id,
                    name: tu.tool_name || tu.name,
                    input: input
                });
                log(`[DEBUG] Parsed tool_use from history: ${tu.tool_name || tu.name}, id=${tu.tool_use_id || tu.id}`);
            } else if (node.type === 0 && node.text_node) {
                textContent += node.text_node.content || '';
            }
        }
        if (toolUses.length > 0) {
            const content: any[] = [];
            // 思考模式: 解析 <think>...</think> 标签
            const shouldParseThinking = (state.currentConfig.provider === 'minimax' && state.currentConfig.enableInterleavedThinking) ||
                (state.currentConfig.provider === 'deepseek' && state.currentConfig.enableThinking);
            if (shouldParseThinking && textContent) {
                const thinkMatch = textContent.match(/<think>([\s\S]*?)<\/think>/);
                if (thinkMatch) {
                    content.push({ type: 'thinking', thinking: thinkMatch[1].trim() });
                    log(`[DEBUG] Parsed thinking from history, length: ${thinkMatch[1].length}`);
                    textContent = textContent.replace(/<think>[\s\S]*?<\/think>\s*/, '').trim();
                }
            }
            if (textContent) {
                content.push({ type: 'text', text: textContent });
            }
            content.push(...toolUses);
            messages.push({ role: 'assistant', content: content });
            log(`[DEBUG] Added assistant message with ${toolUses.length} tool_use(s)`);
            // 3. 紧跟添加 tool_result
            const toolResultNodes = nextExchange?.request_nodes || [];
            for (const node of toolResultNodes) {
                if (node.type === 1 && node.tool_result_node) {
                    const toolResult = node.tool_result_node;
                    messages.push({
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: toolResult.tool_use_id || toolResult.id,
                            content: toolResult.content || ''
                        }]
                    });
                    log(`[DEBUG] Added tool_result for id: ${toolResult.tool_use_id || toolResult.id}`);
                }
            }
        } else {
            const response = exchange.response_text || exchange.response_message;
            if (response) {
                messages.push({ role: 'assistant', content: response });
            }
        }
    }
    // 处理 nodes（文件内容、工具结果、图片）
    const imageNodes: any[] = [];
    const currentMessage = req.message || '';
    const toolResults: any[] = [];
    for (const node of req.nodes || []) {
        const nodeType = node.type;
        if (nodeType === 0) {
            const textNode = node.text_node || {};
            const content = textNode.content || '';
            if (content && content !== currentMessage) {
                messages.push({ role: 'user', content: content });
            }
        } else if (nodeType === 1) {
            const toolResult = node.tool_result_node || {};
            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolResult.id || toolResult.tool_use_id,
                content: toolResult.content || ''
            });
            log(`[DEBUG] Current request has tool_result for id: ${toolResult.id || toolResult.tool_use_id}`);
        } else if (nodeType === 2) {
            const imageNode = node.image_node || {};
            const imageData = imageNode.image_data || '';
            const format = imageNode.format || 1;
            log(`[DEBUG] Image node: format=${format}, dataLen=${imageData.length}, keys=${Object.keys(imageNode).join(',')}`);
            if (imageData) {
                const formatMap: any = { 1: 'image/png', 2: 'image/jpeg', 3: 'image/gif', 4: 'image/webp' };
                imageNodes.push({ data: imageData, mediaType: formatMap[format] || 'image/png' });
                log(`[DEBUG] Image added: ${formatMap[format] || 'image/png'}, ${imageData.length} bytes`);
            } else {
                log(`[DEBUG] Image node has no image_data! Node keys: ${JSON.stringify(Object.keys(imageNode))}`);
            }
        }
    }
    if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
        log(`[DEBUG] Added ${toolResults.length} tool_result(s) to messages`);
    }
    // 构建最终用户消息
    log(`[DEBUG] Building final message: message="${currentMessage.slice(0, 50)}...", imageNodes=${imageNodes.length}`);
    if (currentMessage || imageNodes.length > 0) {
        const contextParts: string[] = [];
        if (req.path) contextParts.push(`File: ${req.path}`);
        if (req.lang) contextParts.push(`Language: ${req.lang}`);
        if (req.selected_code) contextParts.push(`Selected code:\n\`\`\`\n${req.selected_code}\n\`\`\``);
        // 处理 blobs
        const blobs = req.blobs;
        if (blobs) {
            if (Array.isArray(blobs)) {
                for (const blob of blobs.slice(0, 10)) {
                    if (typeof blob === 'object') {
                        const name = blob.path || blob.name || 'unknown';
                        const content = blob.content || '';
                        if (content) contextParts.push(`File: ${name}\n\`\`\`\n${String(content).slice(0, 1000)}\n\`\`\``);
                    }
                }
            } else if (typeof blobs === 'object') {
                let blobCount = 0;
                for (const [blobName, blobData] of Object.entries(blobs)) {
                    if (blobCount >= 10) break;
                    if (typeof blobData === 'object' && blobData !== null && (blobData as any).content) {
                        contextParts.push(`File: ${blobName}\n\`\`\`\n${String((blobData as any).content).slice(0, 1000)}\n\`\`\``);
                        blobCount++;
                    } else if (typeof blobData === 'string') {
                        contextParts.push(`File: ${blobName}\n\`\`\`\n${blobData.slice(0, 1000)}\n\`\`\``);
                        blobCount++;
                    }
                }
            }
        }
        // 处理 user_guided_blobs
        const userBlobs = req.user_guided_blobs;
        if (userBlobs) {
            if (Array.isArray(userBlobs)) {
                for (const blob of userBlobs.slice(0, 5)) {
                    if (typeof blob === 'object') {
                        const name = blob.path || blob.name || 'unknown';
                        const content = blob.content || '';
                        if (content) contextParts.push(`User file: ${name}\n\`\`\`\n${String(content).slice(0, 2000)}\n\`\`\``);
                    }
                }
            } else if (typeof userBlobs === 'object') {
                let count = 0;
                for (const [name, data] of Object.entries(userBlobs)) {
                    if (count >= 5) break;
                    const content = typeof data === 'object' && data !== null ? (data as any).content : String(data);
                    if (content) { contextParts.push(`User file: ${name}\n\`\`\`\n${String(content).slice(0, 2000)}\n\`\`\``); count++; }
                }
            }
        }
        if (req.prefix || req.suffix) {
            const prefix = (req.prefix || '').slice(-2000);
            const suffix = (req.suffix || '').slice(0, 2000);
            if (prefix || suffix) contextParts.push(`Current file context:\n\`\`\`\n${prefix}[CURSOR]${suffix}\n\`\`\``);
        }
        let finalMessage = currentMessage;
        if (contextParts.length > 0) {
            finalMessage = contextParts.join('\n\n') + '\n\n' + currentMessage;
        }
        if (imageNodes.length > 0) {
            const contentParts: any[] = [];
            for (const img of imageNodes) {
                contentParts.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
            }
            contentParts.push({ type: 'text', text: finalMessage });
            messages.push({ role: 'user', content: contentParts });
        } else {
            messages.push({ role: 'user', content: finalMessage });
        }
    }
    if (messages.length === 0) {
        messages.push({ role: 'user', content: 'Hello' });
    }
    return messages;
}



// ===== 将 Augment 请求转换为 OpenAI 格式消息 =====
export function augmentToOpenAIMessages(req: any) {
    const messages: any[] = [];
    const conversationId = req.conversation_id || '';
    const currentMessage = req.message || '';
    const historyLength = (req.chat_history || []).length;

    // 保存原始用户消息（仅当新对话开始时）
    if (historyLength === 0 && currentMessage && currentMessage !== '...') {
        state.conversationUserMessages.set(conversationId, currentMessage);
        log(`[DEBUG] OpenAI: Saved original user message for conversation ${conversationId}: "${currentMessage.substring(0, 50)}..."`);
    }
    const savedUserMessage = state.conversationUserMessages.get(conversationId) || '';

    // 构建 tool_use_id → tool_result 的映射
    const toolResultMap = new Map<string, any>();
    if (req.chat_history) {
        for (const exchange of req.chat_history) {
            for (const node of exchange.request_nodes || []) {
                if (node.type === 1 && node.tool_result_node) {
                    const tr = node.tool_result_node;
                    toolResultMap.set(tr.tool_use_id || tr.id, tr);
                }
            }
        }
    }
    for (const node of req.nodes || []) {
        if (node.type === 1 && node.tool_result_node) {
            const tr = node.tool_result_node;
            toolResultMap.set(tr.tool_use_id || tr.id, tr);
        }
    }
    log(`[DEBUG] OpenAI: Built tool result map with ${toolResultMap.size} entries`);

    // 处理聊天历史
    if (req.chat_history) {
        for (let i = 0; i < req.chat_history.length; i++) {
            const exchange = req.chat_history[i];
            let userContent = exchange.request_message || '';
            const responseNodes = exchange.response_nodes || [];
            const hasResponse = responseNodes.length > 0 || exchange.response_text || exchange.response_message;

            if (!userContent && hasResponse && messages.length === 0) {
                if (savedUserMessage) {
                    userContent = savedUserMessage;
                    log(`[DEBUG] OpenAI: Using cached user message for first exchange: "${savedUserMessage.substring(0, 50)}..."`);
                } else {
                    userContent = '...';
                    log(`[DEBUG] OpenAI: No cached message found, inserted placeholder for first exchange`);
                }
            }
            if (userContent) {
                messages.push({ role: 'user', content: userContent });
            }
            const toolCalls: any[] = [];
            let textContent = '';
            for (const node of responseNodes) {
                if (node.type === 5 && node.tool_use) {
                    const tu = node.tool_use;
                    toolCalls.push({
                        id: tu.tool_use_id || tu.id,
                        type: 'function',
                        function: { name: tu.tool_name || tu.name, arguments: tu.input_json || '{}' }
                    });
                } else if (node.type === 0 && node.text_node) {
                    textContent += node.text_node.content || '';
                }
            }
            if (toolCalls.length > 0) {
                const assistantMsg: any = { role: 'assistant', tool_calls: toolCalls };
                if (textContent) assistantMsg.content = textContent;
                messages.push(assistantMsg);
                for (const tc of toolCalls) {
                    const tr = toolResultMap.get(tc.id);
                    if (tr) {
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: tr.content || '' });
                        toolResultMap.delete(tc.id);
                    }
                }
            } else {
                const response = exchange.response_text || exchange.response_message || '';
                if (response) {
                    messages.push({ role: 'assistant', content: response });
                }
            }
        }
    }
    // 剩余未匹配的 tool_result
    for (const [id, tr] of toolResultMap) {
        messages.push({ role: 'tool', tool_call_id: id, content: tr.content || '' });
    }
    // 添加当前用户消息
    if (currentMessage && currentMessage !== '...') {
        messages.push({ role: 'user', content: currentMessage });
    }
    return messages;
}

// ===== 转换 Augment 消息到 Gemini 格式 =====
export function augmentToGeminiMessages(req: any): any[] {
    const messages: any[] = [];
    if (req.chat_history) {
        for (let i = 0; i < req.chat_history.length; i++) {
            const exchange = req.chat_history[i];
            const responseNodes = exchange.response_nodes || [];
            if (responseNodes.length === 0) {
                log(`[GOOGLE] Skipping empty exchange ${i} (no response_nodes)`);
                continue;
            }
            // 1. 用户消息
            if (exchange.request_message) {
                messages.push({ role: 'user', parts: [{ text: exchange.request_message }] });
            } else if (i === 0) {
                messages.push({ role: 'user', parts: [{ text: 'Continue with the previous request.' }] });
                log(`[GOOGLE] Exchange ${i} user: [placeholder for missing request_message]`);
            }
            // 2. 模型响应
            const modelParts: any[] = [];
            for (const node of responseNodes) {
                if (node.type === 0 && node.text_node) {
                    modelParts.push({ text: node.text_node.content });
                } else if (node.type === 5 && node.tool_use) {
                    const tu = node.tool_use;
                    const functionCall: any = { name: tu.tool_name || tu.name, args: JSON.parse(tu.input_json || '{}') };
                    const part: any = { functionCall };
                    if (tu.thought_signature) { part.thoughtSignature = tu.thought_signature; }
                    modelParts.push(part);
                }
            }
            if (modelParts.length > 0) {
                messages.push({ role: 'model', parts: modelParts });
            }
            // 3. 工具结果
            const requestNodes = exchange.request_nodes || [];
            const toolResults: any[] = [];
            for (const node of requestNodes) {
                if (node.type === 1 && node.tool_result_node) {
                    const tr = node.tool_result_node;
                    toolResults.push({ functionResponse: { name: tr.tool_name || 'unknown', response: { result: tr.content || '' } } });
                }
            }
            if (toolResults.length > 0) {
                let nextExchange = null;
                let skipCount = 0;
                for (let j = i + 1; j < req.chat_history.length; j++) {
                    const candidate = req.chat_history[j];
                    if (candidate.response_nodes && candidate.response_nodes.length > 0) {
                        nextExchange = candidate;
                        skipCount = j - i;
                        break;
                    }
                }
                const userParts: any[] = [...toolResults];
                if (nextExchange && nextExchange.request_message) {
                    userParts.push({ text: nextExchange.request_message });
                    messages.push({ role: 'user', parts: userParts });
                    const nextResponseNodes = nextExchange.response_nodes || [];
                    if (nextResponseNodes.length > 0) {
                        const nextModelParts: any[] = [];
                        for (const node of nextResponseNodes) {
                            if (node.type === 0 && node.text_node) {
                                nextModelParts.push({ text: node.text_node.content });
                            } else if (node.type === 5 && node.tool_use) {
                                const tu = node.tool_use;
                                const functionCall: any = { name: tu.tool_name || tu.name, args: JSON.parse(tu.input_json || '{}') };
                                const part: any = { functionCall };
                                if (tu.thought_signature) { part.thoughtSignature = tu.thought_signature; }
                                nextModelParts.push(part);
                            }
                        }
                        if (nextModelParts.length > 0) {
                            messages.push({ role: 'model', parts: nextModelParts });
                        }
                    }
                    i += skipCount;
                } else {
                    log(`[GOOGLE] Tool results without next exchange, will be added to current request`);
                }
            }
        }
    }
    // 当前请求的工具结果和消息
    const currentUserParts: any[] = [];
    for (const node of req.nodes || []) {
        if (node.type === 1 && node.tool_result_node) {
            const tr = node.tool_result_node;
            currentUserParts.push({ functionResponse: { name: tr.tool_name || 'unknown', response: { result: tr.content || '' } } });
        }
    }
    if (req.message && req.message !== '...') {
        currentUserParts.push({ text: req.message });
        for (const node of req.nodes || []) {
            if (node.type === 2 && node.image_node) {
                const imageNode = node.image_node;
                const formatMap: any = { 1: 'image/png', 2: 'image/jpeg', 3: 'image/gif', 4: 'image/webp' };
                currentUserParts.push({ inlineData: { mimeType: formatMap[imageNode.format] || 'image/png', data: imageNode.image_data } });
            }
        }
    }
    if (currentUserParts.length > 0) {
        messages.push({ role: 'user', parts: currentUserParts });
    }
    // 确保至少有一条消息，且必须以 user 开头
    if (messages.length === 0) {
        log(`[GOOGLE] WARNING: No messages generated, adding placeholder`);
        messages.push({ role: 'user', parts: [{ text: 'Please continue with the task.' }] });
    } else if (messages[0].role !== 'user') {
        log(`[GOOGLE] WARNING: First message is not user, prepending placeholder`);
        messages.unshift({ role: 'user', parts: [{ text: 'Continue with the previous request.' }] });
    }
    // 验证消息序列
    for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i].role === messages[i + 1].role) {
            log(`[GOOGLE] ERROR: Consecutive ${messages[i].role} messages at index ${i} and ${i + 1}`);
            if (messages[i].role === 'user') {
                messages[i].parts = [...messages[i].parts, ...messages[i + 1].parts];
                messages.splice(i + 1, 1);
                i--;
            }
        }
    }
    log(`[GOOGLE] Final message sequence: ${messages.map((m: any) => m.role).join(' → ')}`);
    return messages;
}