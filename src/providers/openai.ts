// ===== OpenAI 格式 API 转发（OpenAI / GLM）=====

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { state, log } from '../globals';
import { OpenAIRequestResult, OpenAIWireApi } from '../types';
import { augmentToOpenAIMessages, buildSystemPrompt, extractWorkspaceInfo, sendAugmentError, splitReasoningContentFromText } from '../messages';
import { convertToolDefinitionsToOpenAI, isCodebaseSearchTool, filterCodebaseSearchCalls, processToolCallForAugment, renderDiffText } from '../tools';
import { applyContextCompression } from '../context-compression';

function isKimiProvider(): boolean {
    return state.currentConfig.provider === 'kimi';
}

function sanitizeKimiToolName(name?: string): string {
    const sanitized = (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_');
    return sanitized || 'tool';
}

function parseKimiToolCallId(id?: string): number | null {
    if (!id) return null;
    const match = id.match(/^functions\.[A-Za-z0-9_-]+:([0-9]+)$/);
    if (!match) return null;
    return Number.parseInt(match[1], 10);
}

function normalizeKimiMessages(messages: any[]): any[] {
    if (!isKimiProvider()) {
        return messages;
    }

    let nextToolIndex = 0;
    let normalizedCount = 0;
    const pendingToolCalls: Array<{ originalId?: string; normalizedId: string; name: string }> = [];

    const normalizedMessages = messages.map((message: any) => {
        if (!message || typeof message !== 'object') {
            return message;
        }

        const normalizedMessage = { ...message };

        if (normalizedMessage.role === 'assistant' && Array.isArray(normalizedMessage.tool_calls)) {
            normalizedMessage.tool_calls = normalizedMessage.tool_calls.map((toolCall: any) => {
                const toolName = toolCall?.function?.name || 'tool';
                const parsedIndex = parseKimiToolCallId(toolCall?.id);
                const normalizedId = parsedIndex !== null
                    ? toolCall.id
                    : `functions.${sanitizeKimiToolName(toolName)}:${nextToolIndex}`;

                if (parsedIndex !== null) {
                    nextToolIndex = Math.max(nextToolIndex, parsedIndex + 1);
                } else {
                    nextToolIndex += 1;
                }

                if (toolCall?.id !== normalizedId) {
                    normalizedCount += 1;
                }

                pendingToolCalls.push({
                    originalId: toolCall?.id,
                    normalizedId,
                    name: toolName
                });

                return {
                    ...toolCall,
                    id: normalizedId,
                    function: {
                        ...toolCall.function,
                        name: toolName,
                        arguments: typeof toolCall?.function?.arguments === 'string'
                            ? toolCall.function.arguments
                            : JSON.stringify(toolCall?.function?.arguments || {})
                    }
                };
            });
            return normalizedMessage;
        }

        if (normalizedMessage.role === 'tool') {
            const matchedIndex = pendingToolCalls.findIndex((toolCall) =>
                toolCall.originalId === normalizedMessage.tool_call_id ||
                toolCall.normalizedId === normalizedMessage.tool_call_id ||
                (!!normalizedMessage.name && toolCall.name === normalizedMessage.name)
            );
            const matched = matchedIndex >= 0 ? pendingToolCalls.splice(matchedIndex, 1)[0] : null;

            if (matched) {
                if (normalizedMessage.tool_call_id !== matched.normalizedId) {
                    normalizedCount += 1;
                }
                normalizedMessage.tool_call_id = matched.normalizedId;
                normalizedMessage.name = normalizedMessage.name || matched.name;
            } else {
                normalizedMessage.name = normalizedMessage.name || 'tool';
            }

            if (normalizedMessage.content === undefined || normalizedMessage.content === null) {
                normalizedMessage.content = '';
            }
        }

        return normalizedMessage;
    });

    if (normalizedCount > 0) {
        log(`[KIMI] Normalized ${normalizedCount} tool_call id/message field(s) before request`);
    }

    return normalizedMessages;
}

function getOpenAIWireApi(): OpenAIWireApi {
    if (state.currentConfig.provider === 'custom') {
        return state.currentConfig.wireApi || 'chat.completions';
    }
    return 'chat.completions';
}

function resolveOpenAIEndpoint(baseUrl: string, wireApi: OpenAIWireApi): string {
    const trimmedBaseUrl = (baseUrl || '').trim();
    if (!trimmedBaseUrl) {
        return trimmedBaseUrl;
    }

    const targetSuffix = wireApi === 'responses' ? '/responses' : '/chat/completions';
    const url = new URL(trimmedBaseUrl);
    const pathname = url.pathname.replace(/\/+$/, '');

    if (pathname.endsWith('/chat/completions') || pathname.endsWith('/responses')) {
        return url.toString();
    }

    if (!pathname || pathname === '/') {
        url.pathname = `/v1${targetSuffix}`;
        return url.toString();
    }

    if (pathname.endsWith('/v1')) {
        url.pathname = `${pathname}${targetSuffix}`;
        return url.toString();
    }

    return url.toString();
}

function convertOpenAIToolsForResponses(tools?: any[]): any[] | undefined {
    if (!tools || tools.length === 0) {
        return undefined;
    }

    return tools.map((tool: any) => {
        if (tool?.type === 'function' && tool.function) {
            return {
                type: 'function',
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters
            };
        }
        return tool;
    });
}

function buildResponsesMessageText(message: any): string {
    const content = typeof message?.content === 'string' ? message.content : '';
    const reasoningContent = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';

    if (reasoningContent && content) {
        return `<think>\n${reasoningContent}\n</think>\n\n${content}`;
    }
    if (reasoningContent) {
        return `<think>\n${reasoningContent}\n</think>`;
    }
    return content;
}

function convertOpenAIMessagesToResponsesInput(messages: any[]): any[] {
    const input: any[] = [];

    for (const message of messages) {
        if (!message || typeof message !== 'object' || message.role === 'system') {
            continue;
        }

        if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            const assistantText = buildResponsesMessageText(message);
            if (assistantText) {
                input.push({
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'input_text', text: assistantText }]
                });
            }
            for (const toolCall of message.tool_calls) {
                input.push({
                    type: 'function_call',
                    call_id: toolCall?.id,
                    name: toolCall?.function?.name || 'tool',
                    arguments: typeof toolCall?.function?.arguments === 'string'
                        ? toolCall.function.arguments
                        : JSON.stringify(toolCall?.function?.arguments || {})
                });
            }
            continue;
        }

        if (message.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: message.tool_call_id,
                output: typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content || '')
            });
            continue;
        }

        input.push({
            type: 'message',
            role: message.role,
            content: [{ type: 'input_text', text: buildResponsesMessageText(message) }]
        });
    }

    if (input.length === 0) {
        return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] }];
    }

    return input;
}

function buildOpenAIRequestBody(
    messages: any[],
    tools: any[] | undefined,
    model: string,
    responseFormat: any,
    wireApi: OpenAIWireApi,
    continuation?: { previousResponseId?: string; responseInputs?: any[] }
): any {
    if (wireApi === 'responses') {
        const instructions = messages
            .filter((message) => message?.role === 'system' && typeof message?.content === 'string' && message.content.trim())
            .map((message) => message.content.trim())
            .join('\n\n');

        const requestBody: any = {
            model,
            stream: true,
            input: continuation?.responseInputs?.length
                ? continuation.responseInputs
                : convertOpenAIMessagesToResponsesInput(messages),
            max_output_tokens: 115000
        };

        if (instructions && !continuation?.previousResponseId) {
            requestBody.instructions = instructions;
        }
        if (continuation?.previousResponseId) {
            requestBody.previous_response_id = continuation.previousResponseId;
        }

        const responseTools = convertOpenAIToolsForResponses(tools);
        if (responseTools && responseTools.length > 0) {
            requestBody.tools = responseTools;
            requestBody.parallel_tool_calls = true;
        }

        if (responseFormat) {
            log('[JSON-MODE] response_format ignored for responses wire API');
        }

        return requestBody;
    }

    const requestBody: any = {
        model: model,
        max_tokens: 115000,
        messages: messages,
        stream: true
    };

    if (tools && tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = 'auto';
    }

    if (responseFormat) {
        requestBody.response_format = responseFormat;
        log(`[JSON-MODE] Enabled with format: ${JSON.stringify(responseFormat)}`);
    }

    return requestBody;
}

function consumeSSEMessages(buffer: string): { messages: Array<{ event?: string; data: string }>; rest: string } {
    const normalizedBuffer = buffer.replace(/\r\n/g, '\n');
    const blocks = normalizedBuffer.split('\n\n');
    const rest = blocks.pop() || '';

    const messages = blocks.map((block) => {
        let eventName: string | undefined;
        const dataLines: string[] = [];

        for (const rawLine of block.split('\n')) {
            const line = rawLine.trimEnd();
            if (!line || line.startsWith(':')) {
                continue;
            }
            if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
                continue;
            }
            if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
            }
        }

        return { event: eventName, data: dataLines.join('\n').trim() };
    }).filter((message) => !!message.data);

    return { messages, rest };
}

function openThinking(result: OpenAIRequestResult, onTextDelta: ((delta: string) => void) | undefined, stateRef: { inThinking: boolean }) {
    if (stateRef.inThinking) {
        return;
    }
    stateRef.inThinking = true;
    result.text += '<think>\n';
    if (onTextDelta) onTextDelta('<think>\n');
}

function closeThinking(result: OpenAIRequestResult, onTextDelta: ((delta: string) => void) | undefined, stateRef: { inThinking: boolean }) {
    if (!stateRef.inThinking) {
        return;
    }
    stateRef.inThinking = false;
    result.text += '\n</think>\n\n';
    if (onTextDelta) onTextDelta('\n</think>\n\n');
}

function extractTextFromCompletedResponse(response: any): string {
    if (typeof response?.output_text === 'string' && response.output_text) {
        return response.output_text;
    }

    const textParts: string[] = [];
    for (const item of response?.output || []) {
        if (item?.type !== 'message' || !Array.isArray(item.content)) {
            continue;
        }
        for (const contentItem of item.content) {
            if ((contentItem?.type === 'output_text' || contentItem?.type === 'text') && typeof contentItem?.text === 'string') {
                textParts.push(contentItem.text);
            }
        }
    }
    return textParts.join('');
}

function mergeResponsesToolCalls(
    response: any,
    partialToolCalls: Map<string, { id: string; name: string; arguments: string }>
): Array<{ id: string; name: string; arguments: string }> {
    const toolCalls = new Map(partialToolCalls);

    for (const item of response?.output || []) {
        if (item?.type !== 'function_call') {
            continue;
        }
        const key = item.call_id || item.id || `${item.name || 'tool'}_${toolCalls.size}`;
        toolCalls.set(key, {
            id: item.call_id || item.id || key,
            name: item.name || 'tool',
            arguments: typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments || {})
        });
    }

    return Array.from(toolCalls.values());
}

// ========== 执行单次 OpenAI API 请求（真流式） ==========
// onTextDelta: 文本增量到达时立即回调，实现真正的流式输出
export async function executeOpenAIRequest(
    messages: any[],
    tools: any[],
    apiEndpoint: string,
    apiKey: string,
    model: string,
    onTextDelta?: (delta: string) => void,
    responseFormat?: any,
    continuation?: { previousResponseId?: string; responseInputs?: any[] }
): Promise<OpenAIRequestResult> {
    return new Promise((resolve, reject) => {
        const wireApi = getOpenAIWireApi();
        const resolvedEndpoint = resolveOpenAIEndpoint(apiEndpoint, wireApi);
        const requestBody = buildOpenAIRequestBody(messages, tools, model, responseFormat, wireApi, continuation);

        if (state.currentConfig.provider === 'kimi-coding') {
            requestBody.prompt_cache_key = `session-${Date.now()}`;
            log(`[KIMI-CODING] Added prompt_cache_key: ${requestBody.prompt_cache_key}`);
        }

        const apiBody = JSON.stringify(requestBody);
        const url = new URL(resolvedEndpoint);
        const headers: any = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(apiBody)
        };

        if (state.currentConfig.provider === 'kimi-coding') {
            headers['User-Agent'] = 'KimiCLI/0.77';
        }

        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers
        };

        log(`[API-EXEC] Sending request to ${resolvedEndpoint}, wireApi=${wireApi}, messages=${messages.length}`);
        const result: OpenAIRequestResult = { text: '', toolCalls: [], finishReason: null, thinkingContent: '' };
        let buffer = '';
        const thinkingState = { inThinking: false };
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
        const responsesToolCallsMap = new Map<string, { id: string; name: string; arguments: string }>();

        const httpModule = url.protocol === 'https:' ? https : http;
        const apiReq = httpModule.request(options, (apiRes: any) => {
            if (apiRes.statusCode !== 200) {
                let errorBody = '';
                apiRes.on('data', (c: any) => errorBody += c);
                apiRes.on('end', () => {
                    log(`[API-EXEC ERROR] Status ${apiRes.statusCode}: ${errorBody.slice(0, 300)}`);
                    reject(new Error(`API Error ${apiRes.statusCode}: ${errorBody.slice(0, 100)}`));
                });
                return;
            }
            apiRes.on('data', (chunk: any) => {
                const chunkStr = chunk.toString();
                if (state.currentConfig.provider === 'kimi-coding') {
                    log(`[KIMI-CODING-RAW] Chunk: ${chunkStr.slice(0, 200)}`);
                }

                buffer += chunkStr;
                const consumed = consumeSSEMessages(buffer);
                buffer = consumed.rest;

                for (const message of consumed.messages) {
                    const data = message.data;
                    if (!data || data === '[DONE]') continue;

                    try {
                        const event = JSON.parse(data);
                        const eventType = message.event || event.type;

                        if (state.currentConfig.provider === 'kimi-coding') {
                            log(`[KIMI-CODING-DEBUG] Event: ${JSON.stringify(event).slice(0, 500)}`);
                        }

                        if (wireApi === 'responses') {
                            if (event.response?.id && !result.responseId) {
                                result.responseId = event.response.id;
                            }

                            if (typeof eventType === 'string' && eventType.includes('reasoning') && typeof event.delta === 'string' && event.delta) {
                                openThinking(result, onTextDelta, thinkingState);
                                result.text += event.delta;
                                result.thinkingContent += event.delta;
                                if (onTextDelta) onTextDelta(event.delta);
                                continue;
                            }

                            if (eventType === 'response.output_text.delta') {
                                closeThinking(result, onTextDelta, thinkingState);
                                if (typeof event.delta === 'string' && event.delta) {
                                    result.text += event.delta;
                                    if (onTextDelta) onTextDelta(event.delta);
                                }
                                continue;
                            }

                            if ((eventType === 'response.output_item.added' || eventType === 'response.output_item.done') && event.item?.type === 'function_call') {
                                const key = event.item.call_id || event.item.id || `${responsesToolCallsMap.size}`;
                                responsesToolCallsMap.set(key, {
                                    id: event.item.call_id || event.item.id || key,
                                    name: event.item.name || responsesToolCallsMap.get(key)?.name || 'tool',
                                    arguments: typeof event.item.arguments === 'string'
                                        ? event.item.arguments
                                        : responsesToolCallsMap.get(key)?.arguments || ''
                                });
                                continue;
                            }

                            if (eventType === 'response.function_call_arguments.delta') {
                                closeThinking(result, onTextDelta, thinkingState);
                                const key = event.call_id || event.item_id || `${event.output_index ?? responsesToolCallsMap.size}`;
                                const existing = responsesToolCallsMap.get(key) || {
                                    id: event.call_id || key,
                                    name: event.name || 'tool',
                                    arguments: ''
                                };
                                existing.id = event.call_id || existing.id;
                                if (event.name) existing.name = event.name;
                                if (typeof event.delta === 'string') existing.arguments += event.delta;
                                responsesToolCallsMap.set(key, existing);
                                continue;
                            }

                            if (eventType === 'response.function_call_arguments.done') {
                                const key = event.call_id || event.item_id || `${event.output_index ?? responsesToolCallsMap.size}`;
                                const existing = responsesToolCallsMap.get(key) || {
                                    id: event.call_id || key,
                                    name: event.name || 'tool',
                                    arguments: ''
                                };
                                existing.id = event.call_id || existing.id;
                                if (event.name) existing.name = event.name;
                                if (typeof event.arguments === 'string') existing.arguments = event.arguments;
                                responsesToolCallsMap.set(key, existing);
                                continue;
                            }

                            if (eventType === 'response.completed') {
                                closeThinking(result, onTextDelta, thinkingState);
                                result.responseId = event.response?.id || result.responseId;
                                result.finishReason = event.response?.status || 'completed';
                                const fallbackText = extractTextFromCompletedResponse(event.response);
                                if (fallbackText && !result.text) {
                                    result.text = fallbackText;
                                    if (onTextDelta) onTextDelta(fallbackText);
                                }
                                result.toolCalls = mergeResponsesToolCalls(event.response, responsesToolCallsMap);
                                continue;
                            }

                            if (eventType === 'error' || event.error) {
                                reject(new Error(event.error?.message || event.message || 'Responses API stream error'));
                                return;
                            }

                            continue;
                        }

                        const choice = event.choices?.[0];
                        const delta = choice?.delta?.content || '';
                        const reasoningDelta = choice?.delta?.reasoning_content || '';
                        const toolCallsDelta = choice?.delta?.tool_calls;

                        if (choice?.finish_reason) { result.finishReason = choice.finish_reason; }

                        if (reasoningDelta) {
                            openThinking(result, onTextDelta, thinkingState);
                            result.text += reasoningDelta;
                            result.thinkingContent += reasoningDelta;
                            if (onTextDelta) onTextDelta(reasoningDelta);
                        }

                        if ('content' in (choice?.delta || {})) {
                            closeThinking(result, onTextDelta, thinkingState);
                            if (delta) {
                                result.text += delta;
                                if (onTextDelta) onTextDelta(delta);
                            }
                        }

                        if (toolCallsDelta && Array.isArray(toolCallsDelta)) {
                            closeThinking(result, onTextDelta, thinkingState);
                            if (state.currentConfig.provider === 'kimi-coding') {
                                log(`[KIMI-CODING-TOOLS] Received ${toolCallsDelta.length} tool calls`);
                            }
                            for (const tc of toolCallsDelta) {
                                const idx = tc.index ?? 0;
                                if (!toolCallsMap.has(idx)) {
                                    toolCallsMap.set(idx, { id: tc.id || `tool_${idx}_${Date.now()}`, name: tc.function?.name || '', arguments: '' });
                                }
                                const st = toolCallsMap.get(idx)!;
                                if (tc.id) st.id = tc.id;
                                if (tc.function?.name) st.name = tc.function.name;
                                const argsValue = tc.function?.arguments || tc.function?.parameters || tc.arguments || tc.parameters;
                                if (argsValue !== undefined && argsValue !== null) {
                                    st.arguments += typeof argsValue === 'object' ? JSON.stringify(argsValue) : argsValue;
                                }
                                if (state.currentConfig.provider === 'kimi-coding') {
                                    log(`[KIMI-CODING-TOOLS] Tool ${idx}: id=${st.id}, name=${st.name}, args=${st.arguments.length} chars`);
                                }
                            }
                        }
                    } catch (e) { }
                }
            });

            apiRes.on('end', () => {
                closeThinking(result, onTextDelta, thinkingState);

                if (state.currentConfig.provider === 'kimi-coding') {
                    log(`[KIMI-CODING-MAP] toolCallsMap size: ${toolCallsMap.size}`);
                }

                if (wireApi === 'responses') {
                    if (result.toolCalls.length === 0 && responsesToolCallsMap.size > 0) {
                        result.toolCalls = Array.from(responsesToolCallsMap.values());
                    }
                } else {
                    for (const [_, tc] of toolCallsMap) { result.toolCalls.push(tc); }
                }

                if (state.currentConfig.provider === 'kimi-coding') {
                    log(`[KIMI-CODING-RESULT] text=${result.text.length}, tools=${result.toolCalls.length}, finish=${result.finishReason}, thinking=${result.thinkingContent.length}`);
                }

                log(`[API-EXEC] Complete: text=${result.text.length}, tools=${result.toolCalls.length}, finish=${result.finishReason}`);
                resolve(result);
            });
            apiRes.on('error', (err: any) => { reject(err); });
        });
        apiReq.on('error', (err: any) => { log(`[API-EXEC ERROR] ${err.message}`); reject(err); });
        apiReq.on('timeout', () => { apiReq.destroy(); reject(new Error('Request timeout')); });
        apiReq.write(apiBody);
        apiReq.end();
    });
}

// ========== 执行本地 RAG 搜索并格式化结果 ==========
export async function executeRAGSearch(query: string): Promise<string> {
    if (!state.ragIndex) { return '⚠️ RAG 索引未初始化'; }
    const startTime = Date.now();
    const results = await state.ragIndex.searchAsync(query, 8);
    const searchTime = Date.now() - startTime;
    log(`[RAG] Search "${query.substring(0, 50)}..." completed in ${searchTime}ms, found ${results.length} results`);
    if (results.length === 0) {
        return `未找到与 "${query}" 相关的代码。请尝试其他关键词。`;
    }
    let output = `## 🔍 代码库搜索\n\n`;
    output += `> 查询: \`${query}\` | 找到 ${results.length} 个结果 | 耗时 ${searchTime}ms\n\n`;
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const score = (r.score * 100).toFixed(1);
        const fileName = r.path.split('/').pop() || r.path;
        output += `<details${i === 0 ? ' open' : ''}>\n`;
        output += `<summary><strong>📄 ${fileName}</strong> <code>${score}%</code> - ${r.path}</summary>\n\n`;
        if (r.matchedTerms && r.matchedTerms.length > 0) {
            output += `**匹配词:** ${r.matchedTerms.slice(0, 5).map((t: string) => `\`${t}\``).join(' ')}\n\n`;
        }
        const lines = r.content.split('\n');
        const preview = lines.slice(0, 20).join('\n');
        const ext = r.path.split('.').pop() || '';
        const langMap: Record<string, string> = {
            'ts': 'typescript', 'js': 'javascript', 'py': 'python', 'md': 'markdown',
            'json': 'json', 'html': 'html', 'css': 'css', 'rs': 'rust', 'go': 'go',
            'java': 'java', 'c': 'c', 'cpp': 'cpp'
        };
        output += `\`\`\`${langMap[ext] || ''}\n${preview}`;
        if (lines.length > 20) { output += `\n// ... 还有 ${lines.length - 20} 行`; }
        output += `\n\`\`\`\n\n</details>\n\n`;
    }
    return output;
}

// ========== 转发到 OpenAI 格式 API (流式) ==========
// 支持 codebase_search 工具循环调用
export async function forwardToOpenAIStream(augmentReq: any, res: any) {
    await applyContextCompression(augmentReq, 'OpenAI');

    const system = buildSystemPrompt(augmentReq);
    const workspaceInfo = extractWorkspaceInfo(augmentReq);
    const rawTools = augmentReq.tool_definitions || [];
    const tools = convertToolDefinitionsToOpenAI(rawTools);

    // ✅ 新增：提取 response_format 参数（支持 JSON Mode）
    const responseFormat = augmentReq.response_format || undefined;

    const openaiMessages: any[] = [];
    if (system) {
        openaiMessages.push({ role: 'system', content: system });
    }
    const convertedMessages = augmentToOpenAIMessages(augmentReq);
    openaiMessages.push(...convertedMessages);

    const wireApi = getOpenAIWireApi();
    const apiEndpoint = state.currentConfig.baseUrl;
    const apiKey = state.currentConfig.apiKey;
    const model = state.currentConfig.model;

    const MAX_ITERATIONS = 25;
    let iteration = 0;
    let currentMessages = [...openaiMessages];
    let accumulatedText = '';
    let previousResponseId: string | undefined;
    let pendingResponseInputs: any[] | undefined;

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

    // 真流式回调：每个文本增量立即写入 NDJSON 响应
    const onTextDelta = (delta: string) => {
        try {
            res.write(JSON.stringify({ text: delta, nodes: [], stop_reason: 0 }) + '\n');
        } catch (e) { /* 连接可能已关闭 */ }
    };

    try {
        while (iteration < MAX_ITERATIONS) {
            iteration++;
            log(`[LOOP] Iteration ${iteration}/${MAX_ITERATIONS}`);
            const requestMessages = wireApi === 'chat.completions'
                ? normalizeKimiMessages(currentMessages)
                : currentMessages;

            const result = await executeOpenAIRequest(
                requestMessages,
                tools,
                apiEndpoint,
                apiKey,
                model,
                onTextDelta,
                responseFormat,
                wireApi === 'responses' ? { previousResponseId, responseInputs: pendingResponseInputs } : undefined
            );

            pendingResponseInputs = undefined;
            accumulatedText += result.text;

            // 只检查 toolCalls 是否为空，不检查 finishReason
            // 某些兼容 API 返回 tool_calls 时 finish_reason 可能仍为 'stop'
            if (result.toolCalls.length === 0) {
                log(`[LOOP] No tool calls, ending loop`);
                res.write(JSON.stringify({ text: '', nodes: [], stop_reason: 1 }) + '\n');
                res.end();
                return;
            }

            const codebaseSearchCalls = filterCodebaseSearchCalls(result.toolCalls);
            const otherToolCalls = result.toolCalls.filter(tc => !isCodebaseSearchTool(tc.name));

            log(`[LOOP] Tool calls: codebase_search=${codebaseSearchCalls.length}, other=${otherToolCalls.length}`);

            if (otherToolCalls.length > 0) {
                log(`[LOOP] Has other tool calls, processing...`);

                // 分离拦截的和非拦截的工具调用
                const interceptedTools: Array<{ tc: any; toolNode: any }> = [];
                const nonInterceptedTools: Array<{ tc: any; toolNode: any }> = [];

                for (const tc of otherToolCalls) {
                    const toolNode = await processToolCallForAugment(tc, workspaceInfo, result.finishReason);
                    if (!toolNode) continue;

                    if (toolNode.type === 1) {
                        interceptedTools.push({ tc, toolNode });
                        log(`[LOOP] Tool ${tc.name} intercepted locally`);
                    } else {
                        nonInterceptedTools.push({ tc, toolNode });
                    }
                }

                if (nonInterceptedTools.length > 0) {
                    // 有非拦截的工具 → 发给 Augment 执行
                    for (const { toolNode } of nonInterceptedTools) {
                        res.write(JSON.stringify({ text: '', nodes: [toolNode], stop_reason: 0 }) + '\n');
                    }
                    // 拦截的工具结果也作为 tool_result 发给 Augment
                    for (const { toolNode } of interceptedTools) {
                        res.write(JSON.stringify({ text: '', nodes: [toolNode], stop_reason: 0 }) + '\n');
                    }
                    res.write(JSON.stringify({ text: '', nodes: [], stop_reason: 3 }) + '\n');
                    res.end();
                    return;
                }

                if (wireApi === 'responses') {
                    if (!result.responseId) {
                        throw new Error('Responses API returned tool calls without response id');
                    }

                    const nextResponseInputs: any[] = [];

                    for (const { tc, toolNode } of interceptedTools) {
                        nextResponseInputs.push({
                            type: 'function_call_output',
                            call_id: tc.id,
                            output: toolNode.tool_result_node.content
                        });

                        try {
                            const resultObj = JSON.parse(toolNode.tool_result_node.content);
                            const diffText = renderDiffText(resultObj, tc.name);
                            res.write(JSON.stringify({ text: diffText, nodes: [], stop_reason: 0 }) + '\n');
                        } catch {
                            res.write(JSON.stringify({
                                text: `\n✅ ${tc.name} executed\n`,
                                nodes: [], stop_reason: 0
                            }) + '\n');
                        }
                    }

                    for (const cs of codebaseSearchCalls) {
                        const searchResult = await executeRAGSearch(cs.query);
                        nextResponseInputs.push({
                            type: 'function_call_output',
                            call_id: cs.id,
                            output: searchResult
                        });
                        res.write(JSON.stringify({
                            text: `\n📚 **代码库搜索** ("${cs.query.substring(0, 30)}...")\n`,
                            nodes: [], stop_reason: 0
                        }) + '\n');
                    }

                    previousResponseId = result.responseId;
                    pendingResponseInputs = nextResponseInputs;
                    log(`[LOOP] All ${interceptedTools.length} tools intercepted, feeding ${nextResponseInputs.length} outputs back via responses continuation`);
                    continue;
                }

                // ✅ 所有工具都被拦截了 → 把结果送回 AI 继续生成
                // 1. 构建 assistant message（包含 tool_calls）
                const allToolCalls = [...otherToolCalls, ...codebaseSearchCalls.map((cs: any) => ({
                    id: cs.id, name: 'codebase_search', arguments: JSON.stringify({ query: cs.query })
                }))];
                const assistantToolCallsMsg = allToolCalls.map((tc: any) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                        name: tc.name,
                        arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {})
                    }
                }));
                const assistantReplay = splitReasoningContentFromText(result.text);
                const assistantReplayMessage: any = {
                    role: 'assistant',
                    content: assistantReplay.content || null,
                    tool_calls: assistantToolCallsMsg
                };
                if (assistantReplay.reasoningContent) {
                    assistantReplayMessage.reasoning_content = assistantReplay.reasoningContent;
                }
                currentMessages.push(assistantReplayMessage);

                // 2. 添加拦截工具的执行结果作为 tool message
                for (const { tc, toolNode } of interceptedTools) {
                    currentMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        name: tc.name,
                        content: toolNode.tool_result_node.content
                    });
                    // 流式显示执行状态和 diff 给用户
                    try {
                        const resultObj = JSON.parse(toolNode.tool_result_node.content);
                        const diffText = renderDiffText(resultObj, tc.name);
                        res.write(JSON.stringify({ text: diffText, nodes: [], stop_reason: 0 }) + '\n');
                    } catch {
                        res.write(JSON.stringify({
                            text: `\n✅ ${tc.name} executed\n`,
                            nodes: [], stop_reason: 0
                        }) + '\n');
                    }
                }

                // 3. 同时处理 codebase_search（如果有）
                for (const cs of codebaseSearchCalls) {
                    const searchResult = await executeRAGSearch(cs.query);
                    currentMessages.push({ role: 'tool', tool_call_id: cs.id, name: 'codebase_search', content: searchResult });
                    res.write(JSON.stringify({
                        text: `\n📚 **代码库搜索** ("${cs.query.substring(0, 30)}...")\n`,
                        nodes: [], stop_reason: 0
                    }) + '\n');
                }

                log(`[LOOP] All ${interceptedTools.length} tools intercepted, feeding results back to AI`);
                continue; // ← 关键：继续循环，AI 看到工具结果后继续生成
            }

            if (codebaseSearchCalls.length > 0) {
                log(`[LOOP] Processing ${codebaseSearchCalls.length} codebase_search calls`);

                if (wireApi === 'responses') {
                    if (!result.responseId) {
                        throw new Error('Responses API returned codebase_search calls without response id');
                    }

                    const nextResponseInputs: any[] = [];
                    for (const cs of codebaseSearchCalls) {
                        const searchResult = await executeRAGSearch(cs.query);
                        nextResponseInputs.push({
                            type: 'function_call_output',
                            call_id: cs.id,
                            output: searchResult
                        });
                        res.write(JSON.stringify({
                            text: `\n\n🔍 **代码库搜索** (查询: "${cs.query}")\n${searchResult.split('\n').slice(0, 5).join('\n')}...\n\n`,
                            nodes: [], stop_reason: 0
                        }) + '\n');
                    }

                    previousResponseId = result.responseId;
                    pendingResponseInputs = nextResponseInputs;
                    log(`[LOOP] Added ${nextResponseInputs.length} responses tool outputs, continuing to next iteration`);
                    continue;
                }

                const toolCallsForMsg = codebaseSearchCalls.map((cs: any) => ({
                    id: cs.id, type: 'function',
                    function: { name: 'codebase_search', arguments: JSON.stringify({ query: cs.query }) }
                }));
                const assistantReplay = splitReasoningContentFromText(result.text);
                const assistantReplayMessage: any = {
                    role: 'assistant',
                    content: assistantReplay.content || null,
                    tool_calls: toolCallsForMsg
                };
                if (assistantReplay.reasoningContent) {
                    assistantReplayMessage.reasoning_content = assistantReplay.reasoningContent;
                }
                currentMessages.push(assistantReplayMessage);

                for (const cs of codebaseSearchCalls) {
                    const searchResult = await executeRAGSearch(cs.query);
                    currentMessages.push({ role: 'tool', tool_call_id: cs.id, name: 'codebase_search', content: searchResult });
                    res.write(JSON.stringify({
                        text: `\n\n🔍 **代码库搜索** (查询: "${cs.query}")\n${searchResult.split('\n').slice(0, 5).join('\n')}...\n\n`,
                        nodes: [], stop_reason: 0
                    }) + '\n');
                }
                log(`[LOOP] Added tool results, continuing to next iteration`);
                continue;
            }
        }

        log(`[LOOP] Max iterations reached`);
        res.write(JSON.stringify({ text: '\n\n⚠️ 已达到最大工具调用次数限制。\n', nodes: [], stop_reason: 1 }) + '\n');
        res.end();

    } catch (error: any) {
        log(`[LOOP ERROR] ${error.message}`);
        try {
            if (res.headersSent && !res.writableEnded) {
                res.write(JSON.stringify({ text: `\n\nError: ${error.message}`, nodes: [], stop_reason: 1 }) + '\n');
                res.end();
            } else {
                sendAugmentError(res, error.message);
            }
        } catch (e) { /* 连接可能已关闭 */ }
    }
}