// ===== Provider 配置常量和格式检测 =====

export const PROVIDERS = ['minimax', 'anthropic', 'deepseek', 'glm', 'openai', 'google', 'kimi', 'custom'];

export const PROVIDER_NAMES: Record<string, string> = {
    minimax: 'MiniMax',
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    glm: 'GLM (智谱)',
    openai: 'OpenAI',
    google: 'Google Gemini',
    kimi: 'Kimi (月之暗面)',
    custom: '自定义'
};

export const DEFAULT_BASE_URLS: Record<string, string> = {
    minimax: 'https://api.minimaxi.com/anthropic/v1/messages',
    anthropic: 'https://api.anthropic.com/v1/messages',
    deepseek: 'https://api.deepseek.com/anthropic/v1/messages',
    glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
    google: 'https://generativelanguage.googleapis.com/v1beta/models',
    kimi: 'https://api.moonshot.cn/v1/chat/completions',
    custom: ''
};

export const DEFAULT_MODELS: Record<string, string> = {
    minimax: 'MiniMax-M2.2',
    anthropic: 'claude-sonnet-4-20250514',
    deepseek: 'deepseek-chat',
    glm: 'glm-4.7',
    openai: 'gpt-4',
    google: 'gemini-3-pro-preview',
    kimi: 'kimi-k2.5',
    custom: ''
};

// 判断是否为 Anthropic 格式
// DeepSeek 提供 Anthropic 兼容 API
export function isAnthropicFormat(provider: string): boolean {
    return ['anthropic', 'minimax', 'deepseek'].includes(provider);
}

// 判断是否为 OpenAI 格式
export function isOpenAIFormat(provider: string): boolean {
    return ['openai', 'glm', 'kimi'].includes(provider);
}

// 判断是否为 Google 格式
export function isGoogleFormat(provider: string): boolean {
    return provider === 'google';
}

