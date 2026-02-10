/**
 * 代码解析器 - 提取代码结构（函数、类、代码块、公式）
 * v1.7.0: 支持 TypeScript/JavaScript, Python, Markdown
 */

export interface CodeBlock {
    type: 'function' | 'class' | 'method' | 'interface' | 'type' | 'const' | 'code_block' | 'formula' | 'unknown';
    name: string;
    content: string;
    startLine: number;
    endLine: number;
    language?: string;
    signature?: string;
    parent?: string;
}

export interface ParseResult {
    blocks: CodeBlock[];
    imports: string[];
    exports: string[];
    language: string;
}

// 中英文代码术语同义词映射
export const CODE_SYNONYMS: Record<string, string[]> = {
    '函数': ['function', 'func', 'fn', 'def', 'method', '方法'],
    '类': ['class', 'struct', 'type', 'interface', '结构体'],
    '精灵': ['sprite', 'actor', 'entity', 'character', '角色'],
    '图片': ['image', 'texture', 'picture', 'bitmap', '纹理'],
    '区域': ['region', 'area', 'rect', 'bounds', 'zone', '矩形'],
    '动画': ['animation', 'anim', 'motion', 'tween'],
    '音效': ['sound', 'audio', 'sfx', 'music'],
    '场景': ['scene', 'stage', 'level', 'screen'],
    '组件': ['component', 'widget', 'element', 'control'],
    '事件': ['event', 'listener', 'handler', 'callback'],
    '变量': ['variable', 'var', 'let', 'const', '常量'],
    '数组': ['array', 'list', 'collection', '列表'],
    '对象': ['object', 'instance', 'entity', '实例'],
    '循环': ['loop', 'for', 'while', 'iterate', '遍历'],
    '条件': ['condition', 'if', 'switch', 'case', '判断'],
};

// 扩展查询：将中文术语扩展为同义词
export function expandQuery(query: string): string[] {
    const terms = query.split(/\s+/);
    const expanded: string[] = [query];
    for (const term of terms) {
        for (const [key, synonyms] of Object.entries(CODE_SYNONYMS)) {
            if (term === key || synonyms.includes(term.toLowerCase())) {
                expanded.push(...synonyms, key);
            }
        }
    }
    return [...new Set(expanded)];
}

export function detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript', 'js': 'javascript', 'jsx': 'javascript',
        'py': 'python', 'rs': 'rust', 'go': 'go', 'java': 'java', 'c': 'c', 'cpp': 'cpp',
        'md': 'markdown', 'mdx': 'markdown', 'json': 'json', 'yaml': 'yaml', 'yml': 'yaml',
    };
    return langMap[ext] || 'text';
}

export function parseCode(content: string, filePath: string): ParseResult {
    const language = detectLanguage(filePath);
    if (language === 'markdown') return parseMarkdown(content);
    if (['typescript', 'javascript'].includes(language)) return parseTypeScript(content, language);
    if (language === 'python') return parsePython(content);
    return { blocks: [], imports: [], exports: [], language };
}

function parseTypeScript(content: string, language: string): ParseResult {
    const blocks: CodeBlock[] = [];
    const lines = content.split('\n');
    const patterns: Record<string, RegExp> = {
        function: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
        class: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
        interface: /^(?:export\s+)?interface\s+(\w+)/,
        type: /^(?:export\s+)?type\s+(\w+)\s*=/,
    };
    let cur: Partial<CodeBlock> | null = null;
    let braceCount = 0, blockStart = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i], trimmed = line.trim();
        if (!cur) {
            for (const [type, pattern] of Object.entries(patterns)) {
                const match = trimmed.match(pattern);
                if (match) {
                    cur = { type: type as CodeBlock['type'], name: match[1], startLine: i + 1, signature: trimmed };
                    blockStart = i;
                    braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
                    break;
                }
            }
        } else {
            braceCount += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
            if (braceCount <= 0) {
                blocks.push({ ...cur, content: lines.slice(blockStart, i + 1).join('\n'), endLine: i + 1 } as CodeBlock);
                cur = null;
            }
        }
    }
    return { blocks, imports: [], exports: [], language };
}

function parsePython(content: string): ParseResult {
    const blocks: CodeBlock[] = [];
    const lines = content.split('\n');
    let cur: Partial<CodeBlock> | null = null;
    let blockStart = 0, baseIndent = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i], trimmed = line.trim(), indent = line.search(/\S/);
        if (cur && indent >= 0 && indent <= baseIndent && trimmed) {
            blocks.push({ ...cur, content: lines.slice(blockStart, i).join('\n'), endLine: i } as CodeBlock);
            cur = null;
        }
        if (!cur) {
            const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)/);
            const classMatch = trimmed.match(/^class\s+(\w+)/);
            if (funcMatch) { cur = { type: 'function', name: funcMatch[1], startLine: i + 1 }; blockStart = i; baseIndent = indent; }
            else if (classMatch) { cur = { type: 'class', name: classMatch[1], startLine: i + 1 }; blockStart = i; baseIndent = indent; }
        }
    }
    if (cur) blocks.push({ ...cur, content: lines.slice(blockStart).join('\n'), endLine: lines.length } as CodeBlock);
    return { blocks, imports: [], exports: [], language: 'python' };
}

function parseMarkdown(content: string): ParseResult {
    const blocks: CodeBlock[] = [];
    const lines = content.split('\n');
    let inCodeBlock = false, blockStart = 0, blockLang = '', blockContent: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('```')) {
            if (!inCodeBlock) {
                inCodeBlock = true; blockStart = i + 1;
                blockLang = line.trim().slice(3).split(/\s/)[0] || 'text';
                blockContent = [];
            } else {
                blocks.push({ type: 'code_block', name: `code_${blocks.length}`, content: blockContent.join('\n'), startLine: blockStart, endLine: i, language: blockLang });
                inCodeBlock = false;
            }
        } else if (inCodeBlock) {
            blockContent.push(line);
        }
        if (line.trim().startsWith('$$') && !inCodeBlock) {
            blocks.push({ type: 'formula', name: `formula_${blocks.length}`, content: line, startLine: i + 1, endLine: i + 1 });
        }
    }
    return { blocks, imports: [], exports: [], language: 'markdown' };
}
