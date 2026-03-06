// ===== 通用上下文压缩 =====
import * as vscode from 'vscode';
import { state, log } from './globals';

export async function applyContextCompression(augmentReq: any, providerName: string = 'unknown') {
    const config = vscode.workspace.getConfiguration('augmentProxy');
    const enableCompression = config.get('enableContextCompression', true) as boolean;
    const compressionThresholdPercent = config.get('compressionThreshold', 60) as number; // 降低到 60%
    const compressionThreshold = compressionThresholdPercent / 100;

    delete augmentReq.compressed_chat_history;

    if (!enableCompression || !augmentReq.chat_history || augmentReq.chat_history.length === 0) return;

    const modelName = state.currentConfig.model || 'unknown';
    const { getModelContextLimit, compressChatHistoryByTokens, getContextStats } = require('./context-manager');
    const tokenLimit = getModelContextLimit(modelName);

    log(`[CONTEXT] 提供商: ${providerName}, 模型: ${modelName}, 上下文限制: ${tokenLimit} tokens, 压缩阈值: ${compressionThresholdPercent}%`);

    const contextStats = getContextStats(augmentReq.chat_history, tokenLimit, compressionThreshold);
    log(`[CONTEXT] 📊 统计: ${contextStats.total_exchanges} 次交互, ~${contextStats.estimated_tokens} tokens (${contextStats.usage_percentage.toFixed(1)}%)`);

    if (state.sidebarProvider) {
        state.sidebarProvider.updateContextStatus({
            total_exchanges: contextStats.total_exchanges,
            estimated_tokens: contextStats.estimated_tokens,
            token_limit: tokenLimit,
            usage_percentage: contextStats.usage_percentage,
            compressed: false
        });
    }

    // 预压缩：在 50% 时就开始主动压缩
    const preemptiveThreshold = 0.5;
    if (contextStats.usage_percentage > (preemptiveThreshold * 100)) {
        log(`[CONTEXT] ⚡ 预压缩触发 (${contextStats.usage_percentage.toFixed(1)}% > ${preemptiveThreshold * 100}%)`);
    }

    if (contextStats.needs_compression || contextStats.usage_percentage > (preemptiveThreshold * 100)) {
        const compressionResult = await compressChatHistoryByTokens(augmentReq.chat_history, tokenLimit, 0.3, compressionThreshold); // 目标 30%
        if (compressionResult.compressed_count < compressionResult.original_count) {
            augmentReq.compressed_chat_history = compressionResult.compressed_exchanges;
            log(`[CONTEXT] ✂️ 压缩: ${compressionResult.original_count} → ${compressionResult.compressed_count} 次交互`);
            log(`[CONTEXT] 📉 Token: ${compressionResult.estimated_tokens_before} → ${compressionResult.estimated_tokens_after} (${(compressionResult.compression_ratio * 100).toFixed(1)}%)`);
            if (compressionResult.summary) log(`[CONTEXT] 📝 摘要: ${compressionResult.summary.slice(0, 80)}...`);
            if (state.sidebarProvider) {
                state.sidebarProvider.updateContextStatus({
                    total_exchanges: compressionResult.compressed_count,
                    estimated_tokens: compressionResult.estimated_tokens_after,
                    token_limit: tokenLimit,
                    usage_percentage: (compressionResult.estimated_tokens_after / tokenLimit) * 100,
                    compressed: true
                });
            }
        }
    }
}

