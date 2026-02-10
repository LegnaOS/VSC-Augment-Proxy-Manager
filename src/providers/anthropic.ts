// ===== Anthropic 格式 API 转发（Anthropic / MiniMax / DeepSeek）=====

import * as https from 'https';
import { URL } from 'url';
import { state, log } from '../globals';
import { augmentToAnthropicMessages, buildSystemPrompt, extractWorkspaceInfo, sendAugmentError } from '../messages';
import { convertToolDefinitions, fixToolCallInput, convertOrInterceptFileEdit } from '../tools';
import { applyContextCompression } from '../context-compression';

// 转发到 Anthropic 格式 API (流式，发送增量)
export async function forwardToAnthropicStream(augmentReq: any, res: any) {
    await applyContextCompression(augmentReq, 'Anthropic/MiniMax/DeepSeek/GLM');

    const messages = augmentToAnthropicMessages(augmentReq);
    const system = buildSystemPrompt(augmentReq);
    const workspaceInfo = extractWorkspaceInfo(augmentReq);
    const rawTools = augmentReq.tool_definitions || [];
    const tools = convertToolDefinitions(rawTools);

    // MiniMax Prompt 缓存
    let systemContent: any = undefined;
    if (system) {
        if (state.currentConfig.provider === 'minimax' && state.currentConfig.enableCache) {
            systemContent = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
            log(`[DEBUG] MiniMax 缓存: 已在 system 添加 cache_control`);
        } else {
            systemContent = system;
        }
    }

    let cachedTools = tools;
    if (state.currentConfig.provider === 'minimax' && state.currentConfig.enableCache && tools && tools.length > 0) {
        cachedTools = tools.map((tool: any, index: number) => {
            if (index === tools.length - 1) {
                return { ...tool, cache_control: { type: 'ephemeral' } };
            }
            return tool;
        });
        log(`[DEBUG] MiniMax 缓存: 已在最后一个 tool 添加 cache_control`);
    }

    const requestBody: any = {
        model: state.currentConfig.model,
        max_tokens: 115000,
        system: systemContent,
        messages: messages,
        stream: true
    };
    if (cachedTools && cachedTools.length > 0) {
        requestBody.tools = cachedTools;
    }
    const apiBody = JSON.stringify(requestBody);
    log(`[API] Sending to ${state.currentConfig.baseUrl} with ${messages.length} messages, ${cachedTools?.length || 0} tools`);

    const url = new URL(state.currentConfig.baseUrl);
    const headers: any = {
        'Content-Type': 'application/json',
        'x-api-key': state.currentConfig.apiKey,
        'anthropic-version': '2023-06-01'
    };

    // Kimi Coding Plan 需要伪装成 Kimi CLI
    if (state.currentConfig.provider === 'kimi-anthropic') {
        headers['User-Agent'] = 'KimiCLI/0.77';
        log(`[KIMI-ANTHROPIC] Added User-Agent: KimiCLI/0.77`);
    }

    const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers
    };

    const apiReq = https.request(options, (apiRes) => {
        if (apiRes.statusCode !== 200) {
            let errorBody = '';
            apiRes.on('data', (c: any) => errorBody += c);
            apiRes.on('end', () => {
                log(`[API ERROR] Status ${apiRes.statusCode}: ${errorBody.slice(0, 200)}`);
                sendAugmentError(res, `API Error ${apiRes.statusCode}`);
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        let buffer = '';
        let currentToolUse: any = null;
        let hasToolUse = false;
        let apiStopReason = '';
        let currentThinking: any = null;
        let isInThinkingBlock = false;

        apiRes.on('data', (chunk: any) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                        const event = JSON.parse(data);
                        const shouldShowThinking = (state.currentConfig.provider === 'minimax' && state.currentConfig.enableInterleavedThinking) ||
                            (state.currentConfig.provider === 'deepseek' && state.currentConfig.enableThinking);
                        // thinking 块开始
                        if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
                            if (shouldShowThinking) {
                                isInThinkingBlock = true;
                                currentThinking = { thinking: '' };
                                log(`[DEBUG] Thinking block start`);
                                res.write(JSON.stringify({ text: '<think>\n', nodes: [], stop_reason: 0 }) + '\n');
                            }
                        }
                        // thinking 增量
                        if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && isInThinkingBlock && currentThinking) {
                            const thinkingDelta = event.delta.thinking || '';
                            currentThinking.thinking += thinkingDelta;
                            res.write(JSON.stringify({ text: thinkingDelta, nodes: [], stop_reason: 0 }) + '\n');
                        }
                        // thinking 块结束
                        if (event.type === 'content_block_stop' && isInThinkingBlock && currentThinking) {
                            log(`[DEBUG] Thinking block end, length: ${currentThinking.thinking.length}`);
                            res.write(JSON.stringify({ text: '\n</think>\n\n', nodes: [], stop_reason: 0 }) + '\n');
                            isInThinkingBlock = false;
                            currentThinking = null;
                        }
                        // 处理文本增量
                        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                            const delta = event.delta.text;
                            res.write(JSON.stringify({ text: delta, nodes: [], stop_reason: 0 }) + '\n');
                        }
                        // 处理 tool_use 开始
                        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
                            currentToolUse = {
                                id: event.content_block.id,
                                name: event.content_block.name,
                                inputJson: ''
                            };
                            log(`[DEBUG] Tool use start: ${event.content_block.name}`);
                        }
                        // 处理 tool_use 参数增量
                        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && currentToolUse) {
                            currentToolUse.inputJson += event.delta.partial_json;
                        }
                        // 处理 tool_use 结束
                        if (event.type === 'content_block_stop' && currentToolUse) {
                            try {
                                let input = JSON.parse(currentToolUse.inputJson || '{}');
                                input = fixToolCallInput(currentToolUse.name, input, workspaceInfo);

                                // 尝试拦截文件编辑工具
                                const interceptResult = convertOrInterceptFileEdit(currentToolUse.name, input, workspaceInfo);

                                if (interceptResult && interceptResult.intercepted) {
                                    // 工具被拦截并直接执行，返回 tool_result 给 AI
                                    log(`[INTERCEPT] Tool ${currentToolUse.name} intercepted, sending result back to AI`);
                                    const toolResultNode = {
                                        type: 1,
                                        tool_result_node: {
                                            tool_use_id: currentToolUse.id,
                                            content: JSON.stringify(interceptResult.result)
                                        }
                                    };
                                    res.write(JSON.stringify({ text: '', nodes: [toolResultNode], stop_reason: 0 }) + '\n');
                                    hasToolUse = true;  // 标记有工具调用，确保 stop_reason=3
                                } else {
                                    // 正常工具调用，发送 tool_use 给 Augment
                                    const toolNode = {
                                        type: 5,
                                        tool_use: {
                                            tool_use_id: currentToolUse.id,
                                            tool_name: interceptResult ? interceptResult.toolName : currentToolUse.name,
                                            input_json: JSON.stringify(interceptResult ? interceptResult.input : input)
                                        }
                                    };
                                    const responseData = { text: '', nodes: [toolNode], stop_reason: 0 };
                                    const responseStr = JSON.stringify(responseData);
                                    res.write(responseStr + '\n');
                                    log(`[DEBUG] Tool use complete: ${currentToolUse.name}, id: ${currentToolUse.id}`);
                                    log(`[DEBUG] Sending tool_use response: ${responseStr.slice(0, 500)}`);
                                    hasToolUse = true;
                                }
                            } catch (e) {
                                log(`[DEBUG] Tool parse error: ${e}`);
                            }
                            currentToolUse = null;
                        }
                        // 跟踪 message_delta 中的 stop_reason
                        if (event.type === 'message_delta' && event.delta?.stop_reason) {
                            apiStopReason = event.delta.stop_reason;
                            log(`[DEBUG] API stop_reason: ${apiStopReason}`);
                        }
                    } catch { }
                }
            }
        });
        apiRes.on('end', () => {
            const stopReason = (hasToolUse || apiStopReason === 'tool_use') ? 3 : 1;
            res.write(JSON.stringify({ text: '', nodes: [], stop_reason: stopReason }) + '\n');
            res.end();
            log(`[API] Stream complete, stop_reason=${stopReason} (hasToolUse=${hasToolUse}, apiStopReason=${apiStopReason})`);
        });
        apiRes.on('error', (err: any) => {
            log(`[API RESPONSE ERROR] ${err.message}`);
            if (!res.headersSent) {
                sendAugmentError(res, `API response error: ${err.message}`);
            } else {
                try {
                    res.write(JSON.stringify({ text: '\n\n[Response error]', nodes: [], stop_reason: 1 }) + '\n');
                    res.end();
                } catch (e) {
                    log(`[API RESPONSE ERROR] Error sending error response: ${e}`);
                }
            }
        });
    });
    apiReq.on('error', (err: any) => {
        log(`[API ERROR] ${err.message}`);
        sendAugmentError(res, err.message);
    });
    apiReq.setTimeout(90000, () => {
        log(`[API TIMEOUT] Request to ${state.currentConfig.provider} timed out after 90s`);
        apiReq.destroy();
        if (!res.headersSent) {
            sendAugmentError(res, 'API request timeout after 90 seconds');
        } else {
            try {
                res.write(JSON.stringify({ text: '\n\n[Request timed out]', nodes: [], stop_reason: 1 }) + '\n');
                res.end();
            } catch (e) {
                log(`[API TIMEOUT] Error sending timeout response: ${e}`);
            }
        }
    });
    apiReq.write(apiBody);
    apiReq.end();
}
