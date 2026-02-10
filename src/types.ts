// ===== 共享类型定义 =====

export interface CodebaseRetrievalRequest {
    information_request: string;
    blobs?: { checkpoint_id?: string; added_blobs?: string[]; deleted_blobs?: string[] };
    dialog?: any[];
    max_output_length?: number;
    disable_codebase_retrieval?: boolean;
    enable_commit_retrieval?: boolean;
}

export interface CodeSnippet {
    path: string;
    content: string;
    lineStart: number;
    lineEnd: number;
    score: number;
}

export interface OpenAIRequestResult {
    text: string;
    toolCalls: Array<{
        id: string;
        name: string;
        arguments: string;
    }>;
    finishReason: string | null;
    thinkingContent: string;
}

export interface CurrentConfig {
    provider: string;
    port: number;
    apiKey: string;
    baseUrl: string;
    model: string;
    enableCache: boolean;
    enableInterleavedThinking: boolean;
    enableThinking: boolean;
}

