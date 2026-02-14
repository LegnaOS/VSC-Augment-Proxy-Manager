// ===== OpenAI 格式 API 转发（OpenAI / GLM）=====

import * as https from 'https';
import { URL } from 'url';
import { state, log } from '../globals';
import { OpenAIRequestResult } from '../types';
import { augmentToOpenAIMessages, buildSystemPrompt, extractWorkspaceInfo, sendAugmentError } from '../messages';
import { convertToolDefinitionsToOpenAI, isCodebaseSearchTool, filterCodebaseSearchCalls, processToolCallForAugment, renderDiffText } from '../tools';
import { applyContextCompression } from '../context-compression';

// ========== 执行单次 OpenAI API 请求（真流式） ==========
// onTextDelta: 文本增量到达时立即回调，实现真正的流式输出
export async function executeOpenAIRequest(
    messages: any[],
    tools: any[],
    apiEndpoint: string,
    apiKey: string,
    model: string,
    onTextDelta?: (delta: string) => void,
    responseFormat?: any  // ✅ 新增：支持 JSON Mode
): Promise<OpenAIRequestResult> {
    return new Promise((resolve, reject) => {
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
        // ✅ 新增：支持 JSON Mode
        if (responseFormat) {
            requestBody.response_format = responseFormat;
            log(`[JSON-MODE] Enabled with format: ${JSON.stringify(responseFormat)}`);
        }
        // ✅ Kimi Coding Plan 需要 prompt_cache_key
        if (state.currentConfig.provider === 'kimi-coding') {
            requestBody.prompt_cache_key = `session-${Date.now()}`;
            log(`[KIMI-CODING] Added prompt_cache_key: ${requestBody.prompt_cache_key}`);
        }
        const apiBody = JSON.stringify(requestBody);
        const url = new URL(apiEndpoint);
        const headers: any = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };

        // Kimi Coding Plan 需要伪装成 Kimi CLI
        if (state.currentConfig.provider === 'kimi-coding') {
            headers['User-Agent'] = 'KimiCLI/0.77';
        }

        const options = {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            method: 'POST',
            headers
        };
        log(`[API-EXEC] Sending request to ${apiEndpoint}, messages=${messages.length}`);
        const result: OpenAIRequestResult = { text: '', toolCalls: [], finishReason: null, thinkingContent: '' };
        let buffer = '';
        let inThinking = false;
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

        const apiReq = https.request(options, (apiRes: any) => {
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
                // 🔍 调试：打印原始 chunk
                if (state.currentConfig.provider === 'kimi-coding') {
                    log(`[KIMI-CODING-RAW] Chunk: ${chunkStr.slice(0, 200)}`);
                }
                buffer += chunkStr;
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (!data || data === '[DONE]') continue;
                        try {
                            const event = JSON.parse(data);
                            // 🔍 调试：打印原始事件
                            if (state.currentConfig.provider === 'kimi-coding') {
                                log(`[KIMI-CODING-DEBUG] Event: ${JSON.stringify(event).slice(0, 500)}`);
                            }
                            const choice = event.choices?.[0];
                            const delta = choice?.delta?.content || '';
                            const reasoningDelta = choice?.delta?.reasoning_content || '';
                            const toolCallsDelta = choice?.delta?.tool_calls;
                            if (choice?.finish_reason) { result.finishReason = choice.finish_reason; }
                            if (reasoningDelta) {
                                if (!inThinking) {
                                    inThinking = true;
                                    result.text += '<think>\n';
                                    if (onTextDelta) onTextDelta('<think>\n');
                                }
                                result.text += reasoningDelta;
                                result.thinkingContent += reasoningDelta;
                                if (onTextDelta) onTextDelta(reasoningDelta);
                            }
                            // 如果有 content（即使是空字符串），也要关闭 thinking
                            if ('content' in (choice?.delta || {})) {
                                if (inThinking) {
                                    inThinking = false;
                                    result.text += '\n</think>\n\n';
                                    if (onTextDelta) onTextDelta('\n</think>\n\n');
                                }
                                if (delta) {  // 只有非空才添加
                                    result.text += delta;
                                    if (onTextDelta) onTextDelta(delta);
                                }
                            }
                            if (toolCallsDelta && Array.isArray(toolCallsDelta)) {
                                // 如果有 tool calls，也要关闭 thinking
                                if (inThinking) {
                                    inThinking = false;
                                    result.text += '\n</think>\n\n';
                                    if (onTextDelta) onTextDelta('\n</think>\n\n');
                                }
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
                }
            });
            apiRes.on('end', () => {
                if (inThinking) {
                    result.text += '\n</think>\n\n';
                    if (onTextDelta) onTextDelta('\n</think>\n\n');
                }
                if (state.currentConfig.provider === 'kimi-coding') {
                    log(`[KIMI-CODING-MAP] toolCallsMap size: ${toolCallsMap.size}`);
                }
                for (const [_, tc] of toolCallsMap) { result.toolCalls.push(tc); }
                // 🔍 调试：打印最终结果
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

    const apiEndpoint = state.currentConfig.baseUrl;
    const apiKey = state.currentConfig.apiKey;
    const model = state.currentConfig.model;

    const MAX_ITERATIONS = 25;
    let iteration = 0;
    let currentMessages = [...openaiMessages];
    let accumulatedText = '';

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

            // 第一轮迭代使用流式回调，后续 RAG 循环也流式输出
            // ✅ 新增：传递 responseFormat 参数
            const result = await executeOpenAIRequest(currentMessages, tools, apiEndpoint, apiKey, model, onTextDelta, responseFormat);
            accumulatedText += result.text;

            if (result.toolCalls.length === 0 || result.finishReason === 'stop') {
                log(`[LOOP] No tool calls or stop, ending loop`);
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
                currentMessages.push({
                    role: 'assistant',
                    content: result.text || null,
                    tool_calls: assistantToolCallsMsg
                });

                // 2. 添加拦截工具的执行结果作为 tool message
                for (const { tc, toolNode } of interceptedTools) {
                    currentMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
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
                    currentMessages.push({ role: 'tool', tool_call_id: cs.id, content: searchResult });
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
                const toolCallsForMsg = codebaseSearchCalls.map((cs: any) => ({
                    id: cs.id, type: 'function',
                    function: { name: 'codebase_search', arguments: JSON.stringify({ query: cs.query }) }
                }));
                currentMessages.push({ role: 'assistant', content: result.text || null, tool_calls: toolCallsForMsg });

                for (const cs of codebaseSearchCalls) {
                    const searchResult = await executeRAGSearch(cs.query);
                    currentMessages.push({ role: 'tool', tool_call_id: cs.id, content: searchResult });
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