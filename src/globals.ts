import * as vscode from 'vscode';
import * as http from 'http';
import { CurrentConfig } from './types';

// ===== 全局共享状态 =====
// 所有模块通过 state 对象访问共享状态
// 使用对象属性而非 export let，确保 CommonJS 下跨模块引用一致

export const state = {
    proxyServer: null as http.Server | null,
    statusBarItem: null as vscode.StatusBarItem | null,
    outputChannel: null as vscode.OutputChannel | null,
    sidebarProvider: null as any,
    extensionContext: null as vscode.ExtensionContext | null,
    ragIndex: null as any,
    semanticEngine: null as any,

    // 会话级请求队列 - 防止同一会话并发请求冲突
    conversationQueues: new Map<string, Promise<void>>(),

    // 保存每个会话的原始用户消息（Augment 不在 chat_history 中保存 request_message）
    conversationUserMessages: new Map<string, string>(),

    // 当前配置
    currentConfig: {
        provider: 'anthropic',
        port: 8765,
        apiKey: '',
        baseUrl: '',
        model: '',
        enableCache: true,
        enableInterleavedThinking: true,
        enableThinking: true,
        // OMC defaults
        omcEnabled: false,
        omcMode: 'team',
        omcContinuationEnforcement: true,
        omcMagicKeywords: true
    } as CurrentConfig
};

// 日志便捷函数 - 减少 state.outputChannel!.appendLine 的冗长写法
export function log(msg: string) {
    state.outputChannel?.appendLine(msg);
}

