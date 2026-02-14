// ===== Google Gemini API 转发 =====

import { state, log } from '../globals';
import { augmentToGeminiMessages, buildSystemPrompt, extractWorkspaceInfo, sendAugmentError } from '../messages';
import { convertToolDefinitionsToGemini, fixToolCallInput, convertOrInterceptFileEdit, renderDiffText } from '../tools';
import { applyContextCompression } from '../context-compression';

interface GeminiToolCall { name: string; args: any; id: string; thoughtSignature?: string; }
interface GeminiResult { text: string; toolCalls: GeminiToolCall[]; }

// ========== 执行单次 Gemini API 请求 ==========
async function executeGeminiRequest(
    ai: any, requestParams: any, onTextDelta: (delta: string) => void
): Promise<GeminiResult> {
    const result: GeminiResult = { text: '', toolCalls: [] };
    const response = await ai.models.generateContentStream(requestParams);

    for await (const chunk of response) {
        const candidates = chunk.candidates;
        if (!candidates || candidates.length === 0) continue;
        const content = candidates[0].content;
        if (!content || !content.parts) continue;

        let sharedThoughtSignature: string | undefined;
        for (const part of content.parts) {
            if (part.thoughtSignature) sharedThoughtSignature = part.thoughtSignature;
            if (part.text) {
                result.text += part.text;
                onTextDelta(part.text);
            }
            if (part.functionCall) {
                result.toolCalls.push({
                    name: part.functionCall.name,
                    args: part.functionCall.args || {},
                    id: `gemini_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    thoughtSignature: part.thoughtSignature || part.functionCall.thoughtSignature || sharedThoughtSignature
                });
            }
        }
    }
    return result;
}

// ========== Google Gemini API 转发函数（支持拦截工具循环）==========
export async function forwardToGoogleStream(augmentReq: any, res: any) {
    const { GoogleGenAI } = require('@google/genai');

    const system = buildSystemPrompt(augmentReq);
    const workspaceInfo = extractWorkspaceInfo(augmentReq);
    await applyContextCompression(augmentReq, 'Google Gemini');

    const rawTools = augmentReq.tool_definitions || [];
    const tools = convertToolDefinitionsToGemini(rawTools);
    const geminiMessages = augmentToGeminiMessages(augmentReq);

    const apiKey = state.currentConfig.apiKey;
    if (!apiKey || apiKey.trim() === '') {
        sendAugmentError(res, 'Google API Key is not configured');
        return;
    }

    const ai = new GoogleGenAI({ apiKey });
    const baseParams: any = { model: state.currentConfig.model };
    if (system) { baseParams.systemInstruction = system; }
    if (tools && tools.length > 0) { baseParams.tools = [{ functionDeclarations: tools }]; }
    baseParams.generationConfig = { temperature: 0.7, topP: 0.95, topK: 40, maxOutputTokens: 8192 };

    let currentContents = [...geminiMessages];
    const MAX_ITERATIONS = 25;

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const onTextDelta = (delta: string) => {
        try { res.write(JSON.stringify({ text: delta, nodes: [], stop_reason: 0 }) + '\n'); } catch {}
    };

    try {
        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
            log(`[GOOGLE] Iteration ${iteration + 1}/${MAX_ITERATIONS}, contents=${currentContents.length}`);
            const requestParams = { ...baseParams, contents: currentContents };
            const result = await executeGeminiRequest(ai, requestParams, onTextDelta);

            if (result.toolCalls.length === 0) {
                res.write(JSON.stringify({ text: '', nodes: [], stop_reason: 1 }) + '\n');
                res.end();
                return;
            }

            // 分离拦截和非拦截的工具
            const interceptedTools: Array<{ tc: GeminiToolCall; interceptResult: any }> = [];
            const nonInterceptedTools: Array<{ tc: GeminiToolCall; toolNode: any }> = [];

            for (const tc of result.toolCalls) {
                let input = fixToolCallInput(tc.name, tc.args, workspaceInfo);
                const interceptResult = convertOrInterceptFileEdit(tc.name, input, workspaceInfo);

                if (interceptResult && interceptResult.intercepted) {
                    interceptedTools.push({ tc, interceptResult: interceptResult.result });
                    log(`[GOOGLE] Tool ${tc.name} intercepted locally`);
                } else {
                    nonInterceptedTools.push({ tc, toolNode: {
                        type: 5, tool_use: {
                            tool_use_id: tc.id,
                            tool_name: interceptResult ? interceptResult.toolName : tc.name,
                            input_json: JSON.stringify(interceptResult ? interceptResult.input : input),
                            thought_signature: tc.thoughtSignature
                        }
                    }});
                }
            }

            if (nonInterceptedTools.length > 0) {
                for (const { toolNode } of nonInterceptedTools) {
                    res.write(JSON.stringify({ text: '', nodes: [toolNode], stop_reason: 0 }) + '\n');
                }
                for (const { tc, interceptResult } of interceptedTools) {
                    res.write(JSON.stringify({ text: '', nodes: [{
                        type: 1, tool_result_node: { tool_use_id: tc.id, content: JSON.stringify(interceptResult) }
                    }], stop_reason: 0 }) + '\n');
                }
                res.write(JSON.stringify({ text: '', nodes: [], stop_reason: 3 }) + '\n');
                res.end();
                return;
            }

            // ✅ 所有工具都被拦截 → 构建 Gemini 格式消息，送回 AI 继续
            const modelParts: any[] = [];
            if (result.text) { modelParts.push({ text: result.text }); }
            for (const tc of result.toolCalls) {
                modelParts.push({ functionCall: { name: tc.name, args: tc.args } });
            }
            currentContents.push({ role: 'model', parts: modelParts });

            const responseParts: any[] = [];
            for (const { tc, interceptResult } of interceptedTools) {
                responseParts.push({ functionResponse: { name: tc.name, response: interceptResult } });
                try {
                    const diffText = renderDiffText(interceptResult, tc.name);
                    res.write(JSON.stringify({ text: diffText, nodes: [], stop_reason: 0 }) + '\n');
                } catch {}
            }
            currentContents.push({ role: 'user', parts: responseParts });

            log(`[GOOGLE] All ${interceptedTools.length} tools intercepted, feeding results back to AI`);
        }

        res.write(JSON.stringify({ text: '\n\n⚠️ 已达到最大工具调用次数限制。\n', nodes: [], stop_reason: 1 }) + '\n');
        res.end();
    } catch (error: any) {
        log(`[GOOGLE ERROR] ${error.message}`);
        try {
            if (!res.writableEnded) {
                res.write(JSON.stringify({ text: `\n\nError: ${error.message}`, nodes: [], stop_reason: 1 }) + '\n');
                res.end();
            }
        } catch {}
    }
}

