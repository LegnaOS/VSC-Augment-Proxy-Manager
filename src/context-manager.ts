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
}

/**
 * 压缩对话历史
 * @param chatHistory 完整的对话历史
 * @param keepRecentCount 保留最近几次完整交互（默认3次）
 * @param maxHistoryLength 触发压缩的历史长度阈值（默认8次）
 * @returns 压缩后的历史和摘要
 */
export async function compressChatHistory(
    chatHistory: Exchange[],
    keepRecentCount: number = 3,
    maxHistoryLength: number = 8
): Promise<CompressionResult> {
    
    // 如果历史不够长，不需要压缩
    if (!chatHistory || chatHistory.length <= maxHistoryLength) {
        return {
            compressed_exchanges: chatHistory || [],
            original_count: chatHistory?.length || 0,
            compressed_count: chatHistory?.length || 0
        };
    }

    // 分离最近的和需要压缩的历史
    const recentExchanges = chatHistory.slice(-keepRecentCount);
    const oldExchanges = chatHistory.slice(0, -keepRecentCount);

    // 生成旧历史的摘要
    const summary = generateHistorySummary(oldExchanges);

    // 创建一个摘要交互，放在压缩历史的开头
    const summaryExchange: Exchange = {
        request_message: "[Context Summary] Previous conversation summary",
        response_nodes: [{
            type: 0,
            text_node: {
                content: summary
            }
        }],
        request_nodes: []
    };

    return {
        compressed_exchanges: [summaryExchange, ...recentExchanges],
        summary: summary,
        original_count: chatHistory.length,
        compressed_count: 1 + recentExchanges.length
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
    summaryParts.push(`📝 Previous ${exchanges.length} exchanges compressed:`);
    
    if (keyActions.length > 0) {
        summaryParts.push(`\nKey interactions: ${keyActions.slice(0, 3).join('; ')}`);
    }

    if (toolCalls.length > 0) {
        const toolStats = countOccurrences(toolCalls);
        const topTools = Object.entries(toolStats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([tool, count]) => `${tool}(${count})`)
            .join(', ');
        summaryParts.push(`\nTools used: ${topTools}`);
    }

    if (filesAccessed.size > 0) {
        const fileList = Array.from(filesAccessed).slice(0, 5).join(', ');
        summaryParts.push(`\nFiles accessed: ${fileList}${filesAccessed.size > 5 ? '...' : ''}`);
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
