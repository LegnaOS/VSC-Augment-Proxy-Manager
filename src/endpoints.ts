// ===== Augment API 端点列表 - 单一数据源 =====
// 消除三处重复：handleProxyRequest, fetch interceptor, HTTP interceptor

export const AUGMENT_ENDPOINTS = [
    // 核心 AI 端点
    '/chat-stream',
    '/chat-input-completion',
    '/chat',
    '/instruction-stream',
    '/smart-paste-stream',
    '/completion',
    // 插件状态和配置
    '/getPluginState',
    '/get-model-config',
    '/get-models',
    // Agent 端点
    '/agents/codebase-retrieval',
    '/agents/edit-file',
    '/agents/list-remote-tools',
    '/agents/run-remote-tool',
    // 远程代理
    '/remote-agents/list-stream',
    // 订阅和用户
    '/subscription-banner',
    '/save-chat',
    // 用户密钥
    '/user-secrets/list',
    '/user-secrets/upsert',
    '/user-secrets/delete',
    // 通知
    '/notifications/mark-read',
    '/notifications',
    // 遥测和事件
    '/client-completion-timelines',
    '/record-session-events',
    '/record-request-events',
    // 其他
    '/next-edit-stream',
    '/find-missing',
    '/client-metrics',
    '/batch-upload',
    '/report-feature-vector',
    // 错误报告
    '/report-error'
] as const;

// 从 URL 中匹配端点路径
// 按长度降序匹配，确保 /chat-stream 优先于 /chat
export function matchEndpoint(urlStr: string): string | null {
    const sorted = [...AUGMENT_ENDPOINTS].sort((a, b) => b.length - a.length);
    for (const endpoint of sorted) {
        if (urlStr.includes(endpoint)) {
            return endpoint;
        }
    }
    return null;
}

