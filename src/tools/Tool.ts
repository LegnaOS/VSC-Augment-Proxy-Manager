// ===== 工具系统核心接口 + buildTool 工厂 =====
// 参考 Claude Code Tool<Input,Output> 架构，适配 VSCode 扩展代理层

export interface ToolInputSchema {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
}

export interface ToolResult {
    success: boolean;
    content: string;
    diffs?: Array<{ file: string; oldStr: string; newStr: string }>;
    error?: string;
    metadata?: Record<string, unknown>;
}

export interface ToolContext {
    workspacePath: string;
    repositoryRoot: string;
    cwd: string;
    conversationId: string;
    abortSignal?: AbortSignal;
}

export interface Tool {
    readonly name: string;
    readonly aliases?: string[];
    readonly description: string;
    readonly inputSchema: ToolInputSchema;
    readonly isReadOnly: boolean;
    readonly isConcurrencySafe: boolean;
    readonly maxResultSizeChars: number;

    call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
    fixInput?(input: Record<string, unknown>, context: ToolContext): Record<string, unknown>;
    validateInput?(input: Record<string, unknown>): { valid: boolean; error?: string };
    isEnabled?(): boolean;
}

// fail-closed 默认值
const TOOL_DEFAULTS = {
    isReadOnly: false,
    isConcurrencySafe: false,
    maxResultSizeChars: 50_000,
    isEnabled: () => true,
};

export type ToolDef = Omit<Tool, keyof typeof TOOL_DEFAULTS> & Partial<Pick<Tool, keyof typeof TOOL_DEFAULTS>>;

export function buildTool(def: ToolDef): Tool {
    return { ...TOOL_DEFAULTS, ...def } as Tool;
}
