// ===== Google Gemini API 转发 =====

import { state, log } from '../globals';
import { augmentToGeminiMessages, buildSystemPrompt, extractWorkspaceInfo, sendAugmentError } from '../messages';
import { convertToolDefinitionsToGemini, applyPathFixes, fixToolCallInput, convertOrInterceptFileEdit } from '../tools';
import { applyContextCompression } from '../context-compression';

// ========== Google Gemini API 转发函数 ==========
// 🔧 修复: 消除原来 config 对象双重创建的 bug，只保留 requestParams
export async function forwardToGoogleStream(augmentReq: any, res: any) {
    const { GoogleGenAI } = require('@google/genai');

    const system = buildSystemPrompt(augmentReq);
    const workspaceInfo = extractWorkspaceInfo(augmentReq);

    await applyContextCompression(augmentReq, 'Google Gemini');

    const rawTools = augmentReq.tool_definitions || [];
    const tools = convertToolDefinitionsToGemini(rawTools);
    const geminiMessages = augmentToGeminiMessages(augmentReq);

    log(`[GOOGLE] Sending to Gemini API with ${geminiMessages.length} messages`);

    try {
        const apiKey = state.currentConfig.apiKey;
        if (!apiKey || apiKey.trim() === '') {
            throw new Error('Google API Key is not configured');
        }

        log(`[GOOGLE] API Key: ${apiKey.slice(0, 10)}...${apiKey.slice(-4)} (length: ${apiKey.length})`);
        log(`[GOOGLE] Model: ${state.currentConfig.model}`);
        log(`[GOOGLE] Base URL: ${state.currentConfig.baseUrl || 'default'}`);

        const ai = new GoogleGenAI({ apiKey: apiKey });

        // 🔧 修复: 只构建一次请求参数（原来 config + requestParams 重复创建）
        const requestParams: any = {
            model: state.currentConfig.model,
            contents: geminiMessages
        };
        if (system) {
            requestParams.systemInstruction = system;
            log(`[GOOGLE] System prompt length: ${system.length} chars`);
            if (system.includes('CRITICAL: Response Requirements')) {
                log(`[GOOGLE] ✓ Gemini-specific behavior guidelines included`);
            }
        }
        if (tools && tools.length > 0) {
            requestParams.tools = [{ functionDeclarations: tools }];
            log(`[GOOGLE] Added ${tools.length} tool definitions`);
        }
        requestParams.generationConfig = {
            temperature: 0.7,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 8192
        };

        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

        log(`[GOOGLE] Calling API: generateContentStream`);
        log(`[GOOGLE] Messages count: ${geminiMessages.length}`);
        log(`[GOOGLE] Tools count: ${tools.length}`);
        log(`[GOOGLE] Request params: ${JSON.stringify({
            model: requestParams.model,
            contentsCount: requestParams.contents.length,
            hasSystemInstruction: !!requestParams.systemInstruction,
            toolsCount: requestParams.tools ? requestParams.tools[0].functionDeclarations.length : 0
        })}`);

        const response = await ai.models.generateContentStream(requestParams);

        log(`[GOOGLE] API call successful, processing stream...`);

        let hasToolCalls = false;
        let accumulatedText = '';

        try {
            for await (const chunk of response) {
                const candidates = chunk.candidates;
                if (!candidates || candidates.length === 0) continue;

                const candidate = candidates[0];
                const content = candidate.content;
                if (!content || !content.parts) continue;

                let sharedThoughtSignature: string | undefined;

                for (const part of content.parts) {
                    if (part.thoughtSignature) {
                        sharedThoughtSignature = part.thoughtSignature;
                    }

                    if (part.text) {
                        accumulatedText += part.text;
                        res.write(JSON.stringify({ text: part.text, nodes: [], stop_reason: 0 }) + '\n');
                    }

                    if (part.functionCall) {
                        hasToolCalls = true;
                        const toolUseId = `gemini_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                        let input = part.functionCall.args || {};

                        // 应用参数修复
                        input = fixToolCallInput(part.functionCall.name, input, workspaceInfo);

                        // 尝试拦截文件编辑工具
                        const interceptResult = convertOrInterceptFileEdit(part.functionCall.name, input, workspaceInfo);

                        if (interceptResult && interceptResult.intercepted) {
                            // 工具被拦截并直接执行，返回 tool_result 给 AI
                            log(`[INTERCEPT] Tool ${part.functionCall.name} intercepted, sending result back to AI`);
                            const toolResultNode = {
                                type: 1,
                                tool_result_node: {
                                    tool_use_id: toolUseId,
                                    content: JSON.stringify(interceptResult.result)
                                }
                            };
                            res.write(JSON.stringify({ text: '', nodes: [toolResultNode], stop_reason: 0 }) + '\n');
                        } else {
                            // 正常工具调用，发送 tool_use 给 Augment
                            const toolNode = {
                                type: 5,
                                tool_use: {
                                    tool_use_id: toolUseId,
                                    tool_name: interceptResult ? interceptResult.toolName : part.functionCall.name,
                                    input_json: JSON.stringify(interceptResult ? interceptResult.input : input),
                                    thought_signature: part.thoughtSignature || part.functionCall.thoughtSignature || sharedThoughtSignature
                                }
                            };
                            res.write(JSON.stringify({ text: '', nodes: [toolNode], stop_reason: 0 }) + '\n');
                            log(`[GOOGLE] Tool call: ${part.functionCall.name}`);
                        }
                    }
                }
            }
        } catch (streamError: any) {
            log(`[GOOGLE STREAM ERROR] ${streamError.message}`);
            log(`[GOOGLE STREAM ERROR] Stack: ${streamError.stack}`);
            throw streamError;
        }

        const stopReason = hasToolCalls ? 3 : 1;

        if (hasToolCalls && accumulatedText.trim().length === 0) {
            log(`[GOOGLE] ⚠️ WARNING: Model called tools but provided no text explanation`);
            const reminderText = "\n[Note: The model called tools but didn't provide an explanation. This is a known Gemini behavior issue.]";
            res.write(JSON.stringify({ text: reminderText, nodes: [], stop_reason: 0 }) + '\n');
        }

        res.write(JSON.stringify({ text: '', nodes: [], stop_reason: stopReason }) + '\n');
        res.end();

        log(`[GOOGLE] Stream complete, stop_reason=${stopReason}, text_length=${accumulatedText.length}`);

    } catch (error: any) {
        log(`[GOOGLE ERROR] ${error.message}`);
        log(`[GOOGLE ERROR] Stack: ${error.stack}`);

        if (error.message && error.message.includes('fetch failed')) {
            log(`[GOOGLE ERROR] Network error detected. Possible causes:`);
            log(`  1. Invalid API Key - check your Google API key`);
            log(`  2. Network connectivity - check internet connection`);
            log(`  3. Firewall/Proxy - check if blocking Google API`);
            log(`  4. API endpoint - verify model name is correct`);

            const apiKey = state.currentConfig.apiKey || '';
            if (apiKey.length === 0) {
                log(`  ❌ API Key is empty!`);
            } else if (apiKey.length < 30) {
                log(`  ⚠️ API Key seems too short (${apiKey.length} chars)`);
            } else {
                log(`  ✓ API Key format looks OK (${apiKey.length} chars)`);
            }

            const model = state.currentConfig.model || '';
            if (!model.startsWith('gemini-')) {
                log(`  ⚠️ Model name doesn't start with 'gemini-': ${model}`);
            } else {
                log(`  ✓ Model name looks OK: ${model}`);
            }
        }

        if (!res.headersSent) {
            sendAugmentError(res, error.message);
        }
    }
}

