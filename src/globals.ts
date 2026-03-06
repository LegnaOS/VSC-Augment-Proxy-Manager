import * as vscode from 'vscode';
import * as http from 'http';
import { CurrentConfig } from './types';
import type { VikingContextStore } from './rag/viking-context';
import type { SessionMemory } from './rag/session-memory';

export interface RecordedEvent {
    id: string;
    source: 'session' | 'user' | 'request';
    type: string;
    recordedAt: string;
    conversationId?: string;
    sessionId?: string;
    requestId?: string;
    canvasId?: string;
    userId?: string;
    payload: any;
}

export interface ConversationState {
    conversationId: string;
    canvasId?: string;
    title?: string;
    createdAt: string;
    updatedAt: string;
    lastMessage?: string;
    lastRequestId?: string;
    chatHistory: any[];
    compressedChatHistory?: any[];
    nodes: any[];
    metadata?: Record<string, any>;
}

export interface CanvasState {
    canvasId: string;
    conversationId?: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, any>;
}

// ===== 全局共享状态 =====
// 所有模块通过 state 对象访问共享状态

export const state = {
    proxyServer: null as http.Server | null,
    statusBarItem: null as vscode.StatusBarItem | null,
    outputChannel: null as vscode.OutputChannel | null,
    sidebarProvider: null as any,
    extensionContext: null as vscode.ExtensionContext | null,
    ragIndex: null as any,
    semanticEngine: null as any,

    // v2.0.0: Viking 子系统
    vikingStore: null as VikingContextStore | null,
    sessionMemory: null as SessionMemory | null,

    // 会话级请求队列
    conversationQueues: new Map<string, Promise<void>>(),

    // 最小状态承接
    conversationStates: new Map<string, ConversationState>(),
    canvasStates: new Map<string, CanvasState>(),
    sessionEventStore: new Map<string, RecordedEvent[]>(),
    userEventStore: new Map<string, RecordedEvent[]>(),
    requestEventStore: new Map<string, RecordedEvent[]>(),

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

