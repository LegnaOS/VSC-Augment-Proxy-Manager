/**
 * 上下文管理模块
 * 负责智能压缩对话历史，保持上下文在合理范围内
 */

interface Exchange {
    request_message?: string;
    response_nodes?: any[];
    request_nodes?: any[];
}

interface CompressionResult {
    compressed_exchanges: Exchange[];
    summary?: string;
    original_count: number;
    compressed_count: number;
    estimated_tokens_before: number;
    estimated_tokens_after: number;
    compression_ratio: number;
}

interface ContextStats {
    total_exchanges: number;
    estimated_tokens: number;
    token_limit: number;
    usage_percentage: number;
    needs_compression: boolean;
}

/**
 * 获取模型的上下文限制
 */
export function getModelContextLimit(modelName: string): number {
    const model = modelName.toLowerCase();

    // Gemini 系列
    if (model.includes('gemini-3')) {
        return 1048576; // 1M tokens (2^20)
    }
    if (model.includes('gemini-2.5')) {
        return 1048576; // 1M tokens
    }
    if (model.includes('gemini-2.0-flash-thinking')) {
        return 32768; // 32K tokens (thinking mode)
    }
    if (model.includes('gemini-2.0')) {
        return 1048576; // 1M tokens
    }
    if (model.includes('gemini-1.5-pro')) {
        return 2097152; // 2M tokens
    }
    if (model.includes('gemini-1.5-flash')) {
        return 1048576; // 1M tokens
    }
    if (model.includes('gemini-1.5')) {
        return 1048576; // 1M tokens
    }
    if (model.includes('gemini-exp')) {
        return 1048576; // 1M tokens
    }
    if (model.includes('gemini')) {
        return 200000; // 默认 200K
    }

    // Claude 系列
    // Claude 4.6
    if (model.includes('claude-opus-4-6') || model.includes('claude-sonnet-4-6')) {
        return 200000; // 200K tokens
    }
    // Claude 4.5
    if (model.includes('claude-sonnet-4-5') || model.includes('claude-haiku-4-5')) {
        return 200000; // 200K tokens
    }
    // Claude 4 (fallback)
    if (model.includes('claude-4') || model.includes('claude-opus-4') || model.includes('claude-sonnet-4') || model.includes('claude-haiku-4')) {
        return 200000; // 200K tokens
    }
    if (model.includes('claude-3-7') || model.includes('claude-3.7')) {
        return 200000; // 200K tokens
    }
    if (model.includes('claude-3-5') || model.includes('claude-3.5')) {
        return 200000; // 200K tokens
    }
    if (model.includes('claude-3-opus')) {
        return 200000; // 200K tokens
    }
    if (model.includes('claude-3-haiku')) {
        return 200000; // 200K tokens
    }
    if (model.includes('claude')) {
        return 200000; // 200K tokens
    }

    // OpenAI reasoning 系列
    if (model.includes('o4-mini')) {
        return 200000; // 200K tokens
    }
    if (model.includes('o3-pro') || model.includes('o3-mini') || model.includes('o3')) {
        return 200000; // 200K tokens
    }
    if (model.includes('o1-pro') || model.includes('o1-mini') || model.includes('o1')) {
        return 200000; // 200K tokens
    }

    // GPT 系列
    if (model.includes('gpt-4.1')) {
        return 1047576; // ~1M tokens
    }
    if (model.includes('gpt-4o-mini')) {
        return 128000; // 128K tokens
    }
    if (model.includes('gpt-4o')) {
        return 128000; // 128K tokens
    }
    if (model.includes('gpt-4-turbo')) {
        return 128000; // 128K tokens
    }
    if (model.includes('gpt-4')) {
        return 8192; // 8K tokens (旧版)
    }
    if (model.includes('gpt-3.5-turbo-16k')) {
        return 16384; // 16K tokens
    }
    if (model.includes('gpt-3.5')) {
        return 4096; // 4K tokens
    }

    // DeepSeek 系列
    if (model.includes('deepseek-r1')) {
        return 128000; // 128K tokens
    }
    if (model.includes('deepseek-v3')) {
        return 128000; // 128K tokens
    }
    if (model.includes('deepseek-coder')) {
        return 128000; // 128K tokens
    }
    if (model.includes('deepseek')) {
        return 128000; // 128K tokens
    }

    // GLM 系列
    if (model.includes('glm-4-plus') || model.includes('glm-4-long')) {
        return 1000000; // 1M tokens
    }
    if (model.includes('glm-4')) {
        return 128000; // 128K tokens
    }
    if (model.includes('glm')) {
        return 128000; // 128K tokens
    }

    // Kimi / Moonshot 系列
    if (model.includes('kimi-k2')) {
        return 131072; // 128K tokens
    }
    if (model.includes('moonshot-v1-128k') || model.includes('kimi')) {
        return 131072; // 128K tokens
    }
    if (model.includes('moonshot-v1-32k')) {
        return 32768; // 32K tokens
    }
    if (model.includes('moonshot')) {
        return 8192; // 8K tokens
    }

    // Qwen 系列
    if (model.includes('qwen3') || model.includes('qwen2.5')) {
        return 131072; // 128K tokens
    }
    if (model.includes('qwen-long') || model.includes('qwen-turbo')) {
        return 131072; // 128K tokens
    }
    if (model.includes('qwen')) {
        return 32768; // 32K tokens
    }

    // MiniMax 系列
    if (model.includes('minimax')) {
        return 245760; // ~245K tokens
    }

    // Mistral 系列
    if (model.includes('mistral-large')) {
        return 128000; // 128K tokens
    }
    if (model.includes('mistral')) {
        return 32768; // 32K tokens
    }

    // Llama 系列
    if (model.includes('llama-4')) {
        return 1048576; // 1M tokens
    }
    if (model.includes('llama-3.3') || model.includes('llama-3.2') || model.includes('llama-3.1')) {
        return 131072; // 128K tokens
    }
    if (model.includes('llama')) {
        return 8192; // 8K tokens
    }

    // Yi / 零一万物
    if (model.includes('yi-large') || model.includes('yi-medium')) {
        return 32768; // 32K tokens
    }
    if (model.includes('yi-')) {
        return 16384; // 16K tokens
    }

    // 默认值
    return 200000; // 200K tokens
}

/**
 * 估算文本的 token 数量（粗略估算）
 * 英文：约 4 字符 = 1 token
 * 中文：约 1.5 字符 = 1 token
 */
function estimateTokens(text: string): number {
    if (!text) return 0;
    
    // 统计中文字符
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    // 统计其他字符
    const otherChars = text.length - chineseChars;
    
    // 中文按 1.5 字符/token，英文按 4 字符/token
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 估算交互历史的总 token 数
 */
function estimateExchangesTokens(exchanges: Exchange[]): number {
    let totalTokens = 0;
    
    for (const exchange of exchanges) {
        // 用户消息
        if (exchange.request_message) {
            totalTokens += estimateTokens(exchange.request_message);
        }
        
        // 响应节点
        if (exchange.response_nodes) {
            for (const node of exchange.response_nodes) {
                if (node.type === 0 && node.text_node) {
                    totalTokens += estimateTokens(node.text_node.content || '');
                } else if (node.type === 5 && node.tool_use) {
                    // 工具调用：名称 + 参数
                    totalTokens += estimateTokens(node.tool_use.tool_name || '');
                    totalTokens += estimateTokens(node.tool_use.input_json || '');
                }
            }
        }
        
        // 请求节点（工具结果）
        if (exchange.request_nodes) {
            for (const node of exchange.request_nodes) {
                if (node.type === 1 && node.tool_result_node) {
                    totalTokens += estimateTokens(node.tool_result_node.content || '');
                }
            }
        }
    }
    
    return totalTokens;
}

function hasToolUse(exchange?: Exchange): boolean {
    return !!exchange?.response_nodes?.some((node: any) => node.type === 5 && node.tool_use);
}

/**
 * 获取上下文统计信息
 */
export function getContextStats(
    chatHistory: Exchange[],
    tokenLimit: number = 200000,
    compressionThreshold: number = 0.8
): ContextStats {
    const estimatedTokens = estimateExchangesTokens(chatHistory || []);
    const usagePercentage = (estimatedTokens / tokenLimit) * 100;
    
    return {
        total_exchanges: chatHistory?.length || 0,
        estimated_tokens: estimatedTokens,
        token_limit: tokenLimit,
        usage_percentage: usagePercentage,
        needs_compression: usagePercentage > (compressionThreshold * 100)
    };
}

/**
 * 智能压缩对话历史（基于 token 使用率）
 * @param chatHistory 完整的对话历史
 * @param tokenLimit token 限制
 * @param targetUsage 目标使用率（默认 40%）
 * @param compressionThreshold 压缩阈值（默认 80%）
 * @returns 压缩后的历史和统计信息
 */
export async function compressChatHistoryByTokens(
    chatHistory: Exchange[],
    tokenLimit: number = 200000,
    targetUsage: number = 0.4,
    compressionThreshold: number = 0.8
): Promise<CompressionResult> {
    
    if (!chatHistory || chatHistory.length === 0) {
        return {
            compressed_exchanges: [],
            original_count: 0,
            compressed_count: 0,
            estimated_tokens_before: 0,
            estimated_tokens_after: 0,
            compression_ratio: 1.0
        };
    }

    const tokensBefore = estimateExchangesTokens(chatHistory);
    const usagePercentage = (tokensBefore / tokenLimit);
    
    // 如果使用率低于阈值，不需要压缩
    if (usagePercentage < compressionThreshold) {
        return {
            compressed_exchanges: chatHistory,
            original_count: chatHistory.length,
            compressed_count: chatHistory.length,
            estimated_tokens_before: tokensBefore,
            estimated_tokens_after: tokensBefore,
            compression_ratio: 1.0
        };
    }

    // 计算需要保留多少最近的交互
    const targetTokens = tokenLimit * targetUsage;
    let keepCount = 0;
    let accumulatedTokens = 0;
    
    // 从后往前累加，直到达到目标 token 数
    for (let i = chatHistory.length - 1; i >= 0; i--) {
        const exchangeTokens = estimateExchangesTokens([chatHistory[i]]);
        if (accumulatedTokens + exchangeTokens > targetTokens && keepCount > 0) {
            break;
        }
        accumulatedTokens += exchangeTokens;
        keepCount++;
    }
    
    // 至少保留 3 次交互
    keepCount = Math.max(keepCount, Math.min(3, chatHistory.length));
    
    // 分离最近的和需要压缩的历史
    // 不要在 tool_use / tool_result 的边界中间切断，否则会破坏多步任务连续性
    let splitIndex = Math.max(0, chatHistory.length - keepCount);
    while (splitIndex > 0 && hasToolUse(chatHistory[splitIndex - 1])) {
        splitIndex--;
    }

    const recentExchanges = chatHistory.slice(splitIndex);
    const oldExchanges = chatHistory.slice(0, splitIndex);

    if (oldExchanges.length === 0) {
        return {
            compressed_exchanges: chatHistory,
            original_count: chatHistory.length,
            compressed_count: chatHistory.length,
            estimated_tokens_before: tokensBefore,
            estimated_tokens_after: tokensBefore,
            compression_ratio: 1.0
        };
    }

    // 生成旧历史的摘要
    const summary = generateHistorySummary(oldExchanges);
    const summaryTokens = estimateTokens(summary);
    const recentTokens = estimateExchangesTokens(recentExchanges);

    // 创建一个摘要交互
    const summaryExchange: Exchange = {
        request_message: "[上下文摘要] 已压缩前 " + oldExchanges.length + " 次交互",
        response_nodes: [{
            type: 0,
            text_node: {
                content: summary
            }
        }],
        request_nodes: []
    };

    const compressedExchanges = [summaryExchange, ...recentExchanges];
    const tokensAfter = summaryTokens + recentTokens;
    
    return {
        compressed_exchanges: compressedExchanges,
        summary: summary,
        original_count: chatHistory.length,
        compressed_count: compressedExchanges.length,
        estimated_tokens_before: tokensBefore,
        estimated_tokens_after: tokensAfter,
        compression_ratio: tokensBefore > 0 ? tokensAfter / tokensBefore : 1.0
    };
}

/**
 * 生成历史摘要
 * 提取关键信息：工具调用、文件操作、重要决策
 */
function generateHistorySummary(exchanges: Exchange[]): string {
    const summaryParts: string[] = [];
    const toolCalls: string[] = [];
    const filesAccessed: Set<string> = new Set();
    const keyActions: string[] = [];

    for (let i = 0; i < exchanges.length; i++) {
        const exchange = exchanges[i];
        
        // 提取用户消息
        if (exchange.request_message && exchange.request_message.length > 0) {
            const msg = exchange.request_message.slice(0, 100);
            if (msg !== 'Continue with the previous request.' && msg !== '...') {
                keyActions.push(`User: ${msg}${exchange.request_message.length > 100 ? '...' : ''}`);
            }
        }

        // 提取工具调用
        if (exchange.response_nodes) {
            for (const node of exchange.response_nodes) {
                if (node.type === 5 && node.tool_use) {
                    const toolName = node.tool_use.tool_name || node.tool_use.name;
                    toolCalls.push(toolName);

                    // 提取文件路径
                    try {
                        const input = JSON.parse(node.tool_use.input_json || '{}');
                        if (input.path) {
                            filesAccessed.add(input.path);
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }
    }

    // 构建摘要
    summaryParts.push(`📝 已压缩前 ${exchanges.length} 次交互:`);
    
    if (keyActions.length > 0) {
        summaryParts.push(`\n关键交互: ${keyActions.slice(0, 3).join('; ')}`);
    }

    if (toolCalls.length > 0) {
        const toolStats = countOccurrences(toolCalls);
        const topTools = Object.entries(toolStats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([tool, count]) => `${tool}(${count})`)
            .join(', ');
        summaryParts.push(`\n工具使用: ${topTools}`);
    }

    if (filesAccessed.size > 0) {
        const fileList = Array.from(filesAccessed).slice(0, 5).join(', ');
        summaryParts.push(`\n访问文件: ${fileList}${filesAccessed.size > 5 ? '...' : ''}`);
    }

    return summaryParts.join('\n');
}

/**
 * 统计数组元素出现次数
 */
function countOccurrences(arr: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of arr) {
        counts[item] = (counts[item] || 0) + 1;
    }
    return counts;
}

/**
 * 使用 AI 模型生成智能摘要（高级版本）
 * 当需要更智能的压缩时使用
 */
export async function compressWithAI(
    chatHistory: Exchange[],
    apiKey: string,
    model: string = 'gemini-2.0-flash-exp'
): Promise<string> {
    const { GoogleGenAI } = require('@google/genai');
    
    try {
        // 构建历史文本
        const historyText = exchangesToText(chatHistory);
        
        const ai = new GoogleGenAI({ apiKey });
        
        const prompt = `请总结以下对话历史的关键信息，包括：
1. 用户的主要需求和目标
2. 已完成的主要操作
3. 访问或修改的文件
4. 重要的决策和结论

对话历史：
${historyText}

请用简洁的中文总结（不超过200字）：`;

        const response = await ai.models.generateContent({
            model: model,
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });

        const summary = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return summary || generateHistorySummary(chatHistory);
        
    } catch (error) {
        console.error('[CONTEXT-MANAGER] AI compression failed, using fallback:', error);
        return generateHistorySummary(chatHistory);
    }
}

/**
 * 将交互历史转换为文本
 */
function exchangesToText(exchanges: Exchange[]): string {
    const lines: string[] = [];
    
    for (let i = 0; i < exchanges.length; i++) {
        const exchange = exchanges[i];
        
        if (exchange.request_message) {
            lines.push(`[${i}] User: ${exchange.request_message.slice(0, 200)}`);
        }
        
        if (exchange.response_nodes) {
            for (const node of exchange.response_nodes) {
                if (node.type === 0 && node.text_node) {
                    lines.push(`[${i}] Assistant: ${node.text_node.content.slice(0, 200)}`);
                } else if (node.type === 5 && node.tool_use) {
                    const toolName = node.tool_use.tool_name || node.tool_use.name;
                    lines.push(`[${i}] Tool: ${toolName}`);
                }
            }
        }
    }
    
    return lines.join('\n');
}
