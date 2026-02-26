// ===== Anthropic 格式 API 转发（Anthropic / MiniMax / DeepSeek）=====

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { state, log } from '../globals';
import { augmentToAnthropicMessages, buildSystemPrompt, extractWorkspaceInfo } from '../messages';
import { convertToolDefinitions, fixToolCallInput, convertOrInterceptFileEdit, renderDiffText } from '../tools';
import { applyContextCompression } from '../context-compression';

interface AnthropicToolCall { id: string; name: string; input: any; }
interface AnthropicResult { text: string; toolCalls: AnthropicToolCall[]; stopReason: string; }

// ========== 执行单次 Anthropic API 请求 ==========
function executeAnthropicRequest(
    messages: any[], systemContent: any, tools: any[],
    onTextDelta: (delta: string) => void,
    additionalParams?: any
): Promise<AnthropicResult> {
    return new Promise((resolve, reject) => {
        const requestBody: any = {
            model: state.currentConfig.model, max_tokens: 115000,
            system: systemContent, messages, stream: true
        };
        if (tools && tools.length > 0) { requestBody.tools = tools; }

        // ========== 支持所有 Claude API 高级参数 ==========
        if (additionalParams) {
            // Extended/Adaptive Thinking
            if (additionalParams.thinking) {
                requestBody.thinking = additionalParams.thinking;
            }

            // Output Config (effort, fast_mode, format, schema, strict)
            if (additionalParams.output_config) {
                requestBody.output_config = additionalParams.output_config;
            }

            // Tool Choice
            if (additionalParams.tool_choice) {
                requestBody.tool_choice = additionalParams.tool_choice;
            }

            // Metadata
            if (additionalParams.metadata) {
                requestBody.metadata = additionalParams.metadata;
            }

            // Stop Sequences
            if (additionalParams.stop_sequences) {
                requestBody.stop_sequences = additionalParams.stop_sequences;
            }

            // Temperature
            if (additionalParams.temperature !== undefined) {
                requestBody.temperature = additionalParams.temperature;
            }

            // Top P
            if (additionalParams.top_p !== undefined) {
                requestBody.top_p = additionalParams.top_p;
            }

            // Top K
            if (additionalParams.top_k !== undefined) {
                requestBody.top_k = additionalParams.top_k;
            }
        }
        const apiBody = JSON.stringify(requestBody);

        // 记录请求体大小
        const bodySizeKB = (Buffer.byteLength(apiBody) / 1024).toFixed(2);
        log(`[API] Request body size: ${bodySizeKB} KB, messages: ${messages.length}`);

        const url = new URL(state.currentConfig.baseUrl);
        const headers: any = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(apiBody),
            'x-api-key': state.currentConfig.apiKey,
            'anthropic-version': '2023-06-01'
        };
        if (state.currentConfig.provider === 'kimi-anthropic') {
            headers['User-Agent'] = 'KimiCLI/0.77';
        }
        const isHttps = url.protocol === 'https:';
        // 构建完整的 path（包含 pathname 和 search）
        const fullPath = url.pathname + (url.search || '');
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: fullPath,
            method: 'POST',
            headers
        };
        log(`[API] Sending to ${state.currentConfig.baseUrl} with ${messages.length} messages`);

        const result: AnthropicResult = { text: '', toolCalls: [], stopReason: '' };
        let buffer = '';
        let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
        let isInThinkingBlock = false;
        let currentThinkingBlock: { thinking: string; signature?: string } | null = null;
        let currentRedactedThinking: { data: string } | null = null;
        const shouldShowThinking = (state.currentConfig.provider === 'minimax' && state.currentConfig.enableInterleavedThinking) ||
            (state.currentConfig.provider === 'deepseek' && state.currentConfig.enableThinking) ||
            (additionalParams?.thinking); // 如果启用了 thinking,也显示

        const httpModule = isHttps ? https : http;
        const apiReq = httpModule.request(options, (apiRes) => {
            if (apiRes.statusCode !== 200) {
                let errorBody = '';
                apiRes.on('data', (c: any) => errorBody += c);
                apiRes.on('end', () => {
                    log(`[API] Error response: ${apiRes.statusCode} ${errorBody.slice(0, 500)}`);
                    reject(new Error(`API Error ${apiRes.statusCode}: ${errorBody.slice(0, 200)}`));
                });
                return;
            }
            apiRes.on('data', (chunk: any) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) continue;

                    // 支持标准 SSE 格式（event: xxx 和 data: xxx）
                    if (trimmedLine.startsWith('event:')) continue;
                    if (!trimmedLine.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                        const event = JSON.parse(data);

                        // 处理 message_start 事件
                        if (event.type === 'message_start') continue;

                        // 处理 ping 事件
                        if (event.type === 'ping') continue;

                        // 处理 message_stop 事件
                        if (event.type === 'message_stop') continue;

                        // 处理 content_block_start 事件
                        if (event.type === 'content_block_start') {
                            // Thinking block
                            if (event.content_block?.type === 'thinking' && shouldShowThinking) {
                                isInThinkingBlock = true;
                                currentThinkingBlock = { thinking: '' };
                                onTextDelta('<think>\n');
                            }
                            // Redacted thinking block
                            if (event.content_block?.type === 'redacted_thinking') {
                                currentRedactedThinking = { data: event.content_block.data || '' };
                                if (shouldShowThinking) {
                                    onTextDelta('<redacted_thinking>\n[Encrypted thinking content]\n</redacted_thinking>\n\n');
                                }
                            }
                            // Tool use
                            if (event.content_block?.type === 'tool_use') {
                                currentToolUse = { id: event.content_block.id, name: event.content_block.name, inputJson: '' };
                            }
                        }

                        // 处理 content_block_delta 事件
                        if (event.type === 'content_block_delta') {
                            // Thinking delta
                            if (event.delta?.type === 'thinking_delta' && isInThinkingBlock && currentThinkingBlock) {
                                const thinkingText = event.delta.thinking || '';
                                currentThinkingBlock.thinking += thinkingText;
                                onTextDelta(thinkingText);
                            }
                            // Signature delta (thinking block signature)
                            if (event.delta?.type === 'signature_delta' && currentThinkingBlock) {
                                currentThinkingBlock.signature = (currentThinkingBlock.signature || '') + (event.delta.signature || '');
                            }
                            // Text delta
                            if (event.delta?.type === 'text_delta') {
                                result.text += event.delta.text;
                                onTextDelta(event.delta.text);
                            }
                            // Tool input delta
                            if (event.delta?.type === 'input_json_delta' && currentToolUse) {
                                currentToolUse.inputJson += event.delta.partial_json;
                            }
                        }

                        // 处理 content_block_stop 事件
                        if (event.type === 'content_block_stop') {
                            if (isInThinkingBlock) {
                                onTextDelta('\n</think>\n\n');
                                isInThinkingBlock = false;
                                currentThinkingBlock = null;
                            }
                            if (currentRedactedThinking) {
                                currentRedactedThinking = null;
                            }
                            if (currentToolUse) {
                                try {
                                    result.toolCalls.push({ id: currentToolUse.id, name: currentToolUse.name, input: JSON.parse(currentToolUse.inputJson || '{}') });
                                } catch (e) { log(`[TOOL] Parse error: ${e}`); }
                                currentToolUse = null;
                            }
                        }
                        if (event.type === 'message_delta' && event.delta?.stop_reason) {
                            result.stopReason = event.delta.stop_reason;
                        }
                    } catch (e) {
                        log(`[SSE] JSON parse error: ${e}`);
                    }
                }
            });
            apiRes.on('end', () => {
                log(`[API] Complete: text=${result.text.length}, tools=${result.toolCalls.length}, stop=${result.stopReason}`);
                resolve(result);
            });
            apiRes.on('error', (err: any) => {
                log(`[API] Response stream error: ${err.message}`);
                reject(err);
            });
        });
        apiReq.on('error', (err: any) => {
            log(`[API] Request error: ${err.message}, code: ${err.code}`);
            reject(err);
        });
        apiReq.on('abort', () => {
            log(`[API] Request aborted by client or server`);
            reject(new Error('Request aborted'));
        });
        apiReq.setTimeout(90000, () => {
            log(`[API] Request timeout after 90s`);
            apiReq.destroy();
            reject(new Error('Request timeout after 90s'));
        });
        apiReq.write(apiBody);
        apiReq.end();
    });
}

// ========== 转发到 Anthropic 格式 API (流式，支持拦截工具循环) ==========
export async function forwardToAnthropicStream(augmentReq: any, res: any) {
    await applyContextCompression(augmentReq, 'Anthropic/MiniMax/DeepSeek/GLM');

    const system = buildSystemPrompt(augmentReq);
    const workspaceInfo = extractWorkspaceInfo(augmentReq);
    const rawTools = augmentReq.tool_definitions || [];
    const tools = convertToolDefinitions(rawTools);

    // ========== 提取所有 Claude API 高级参数 ==========
    const additionalParams: any = {};

    // Extended/Adaptive Thinking
    if (augmentReq.thinking) {
        additionalParams.thinking = augmentReq.thinking;
    }

    // Output Config (effort, fast_mode, format, schema, strict)
    if (augmentReq.output_config) {
        additionalParams.output_config = augmentReq.output_config;
    }

    // Tool Choice
    if (augmentReq.tool_choice) {
        additionalParams.tool_choice = augmentReq.tool_choice;
    }

    // Metadata
    if (augmentReq.metadata) {
        additionalParams.metadata = augmentReq.metadata;
    }

    // Stop Sequences
    if (augmentReq.stop_sequences) {
        additionalParams.stop_sequences = augmentReq.stop_sequences;
    }

    // Temperature
    if (augmentReq.temperature !== undefined) {
        additionalParams.temperature = augmentReq.temperature;
    }

    // Top P
    if (augmentReq.top_p !== undefined) {
        additionalParams.top_p = augmentReq.top_p;
    }

    // Top K
    if (augmentReq.top_k !== undefined) {
        additionalParams.top_k = augmentReq.top_k;
    }

    log(`[API] Additional params: ${JSON.stringify(Object.keys(additionalParams))}`);

    let systemContent: any = undefined;
    if (system) {
        if (state.currentConfig.provider === 'minimax' && state.currentConfig.enableCache) {
            systemContent = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
        } else {
            systemContent = system;
        }
    }
    let cachedTools = tools;
    if (state.currentConfig.provider === 'minimax' && state.currentConfig.enableCache && tools && tools.length > 0) {
        cachedTools = tools.map((tool: any, index: number) =>
            index === tools.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool
        );
    }

    const initialMessages = augmentToAnthropicMessages(augmentReq);
    let currentMessages = [...initialMessages];
    const MAX_ITERATIONS = 25;
    const TOOL_RESULT_SIZE_LIMIT = 50000; // 50KB 工具结果大小限制

    // 禁用缓冲，立即刷新响应
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    // 心跳保活机制
    const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
            try {
                res.write('\n'); // 发送空行保持连接
            } catch {}
        }
    }, 30000);

    res.on('close', () => clearInterval(heartbeat));

    const onTextDelta = (delta: string) => {
        try {
            res.write(JSON.stringify({ text: delta, nodes: [], stop_reason: 0 }) + '\n');
            // 立即刷新缓冲区
            if ((res as any).flush) (res as any).flush();
        } catch {}
    };

    try {
        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
            log(`[LOOP] Anthropic iteration ${iteration + 1}/${MAX_ITERATIONS}`);
            const result = await executeAnthropicRequest(currentMessages, systemContent, cachedTools, onTextDelta, additionalParams);

            // 检查是否有工具调用 —— 只看 toolCalls，不看 stopReason
            // Claude API 返回 tool_use 时 stopReason 可能是 'end_turn' 也可能是 'tool_use'
            // 之前用 || stopReason === 'end_turn' 会导致有工具调用时被错误判定为结束
            if (result.toolCalls.length === 0) {
                // 没有工具调用，正常结束
                res.write(JSON.stringify({ text: '', nodes: [], stop_reason: 1 }) + '\n');
                clearInterval(heartbeat);
                res.end();
                return;
            }

            // 分离拦截和非拦截的工具
            const interceptedTools: Array<{ tc: AnthropicToolCall; interceptResult: any }> = [];
            const nonInterceptedTools: Array<{ tc: AnthropicToolCall; toolNode: any }> = [];

            for (const tc of result.toolCalls) {
                let input = fixToolCallInput(tc.name, tc.input, workspaceInfo);
                const interceptResult = convertOrInterceptFileEdit(tc.name, input, workspaceInfo);

                if (interceptResult && interceptResult.intercepted) {
                    // 截断过大的工具结果
                    let resultContent = JSON.stringify(interceptResult.result);
                    if (resultContent.length > TOOL_RESULT_SIZE_LIMIT) {
                        log(`[LOOP] Tool result truncated: ${resultContent.length} -> ${TOOL_RESULT_SIZE_LIMIT} bytes`);
                        resultContent = resultContent.slice(0, TOOL_RESULT_SIZE_LIMIT) + '\n[...内容过长已截断]';
                        try {
                            interceptResult.result = JSON.parse(resultContent.startsWith('{') ? resultContent : '{"content":"' + resultContent + '"}');
                        } catch {
                            interceptResult.result = { content: resultContent };
                        }
                    }
                    interceptedTools.push({ tc, interceptResult: interceptResult.result });
                    log(`[LOOP] Tool ${tc.name} intercepted locally`);
                } else {
                    nonInterceptedTools.push({ tc, toolNode: {
                        type: 5, tool_use: {
                            tool_use_id: tc.id,
                            tool_name: interceptResult ? interceptResult.toolName : tc.name,
                            input_json: JSON.stringify(interceptResult ? interceptResult.input : input)
                        }
                    }});
                }
            }

            if (nonInterceptedTools.length > 0) {
                // 有非拦截的工具 → 发给 Augment
                for (const { toolNode } of nonInterceptedTools) {
                    res.write(JSON.stringify({ text: '', nodes: [toolNode], stop_reason: 0 }) + '\n');
                }
                for (const { tc, interceptResult } of interceptedTools) {
                    res.write(JSON.stringify({ text: '', nodes: [{
                        type: 1, tool_result_node: { tool_use_id: tc.id, content: JSON.stringify(interceptResult) }
                    }], stop_reason: 0 }) + '\n');
                }
                // 立即刷新
                if ((res as any).flush) (res as any).flush();
                res.write(JSON.stringify({ text: '', nodes: [], stop_reason: 3 }) + '\n');
                clearInterval(heartbeat);
                res.end();
                return;
            }

            // ✅ 所有工具都被拦截 → 构建 Anthropic 格式消息，送回 AI 继续
            const assistantContent: any[] = [];
            if (result.text) { assistantContent.push({ type: 'text', text: result.text }); }
            for (const tc of result.toolCalls) {
                assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
            }
            currentMessages.push({ role: 'assistant', content: assistantContent });

            const toolResults: any[] = [];
            for (const { tc, interceptResult } of interceptedTools) {
                toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: JSON.stringify(interceptResult) });
                try {
                    const diffText = renderDiffText(interceptResult, tc.name);
                    res.write(JSON.stringify({ text: diffText, nodes: [], stop_reason: 0 }) + '\n');
                } catch {}
            }
            currentMessages.push({ role: 'user', content: toolResults });

            log(`[LOOP] All ${interceptedTools.length} tools intercepted, feeding results back to AI`);
        }

        res.write(JSON.stringify({ text: '\n\n⚠️ 已达到最大工具调用次数限制。\n', nodes: [], stop_reason: 1 }) + '\n');
        res.end();
    } catch (error: any) {
        log(`[LOOP ERROR] ${error.message}`);
        try {
            if (!res.writableEnded) {
                res.write(JSON.stringify({ text: `\n\nError: ${error.message}`, nodes: [], stop_reason: 1 }) + '\n');
                res.end();
            }
        } catch {}
    }
}
