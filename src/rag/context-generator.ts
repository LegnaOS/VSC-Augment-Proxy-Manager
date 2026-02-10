/**
 * Context Generator - 使用用户配置的 LLM 生成代码块上下文描述
 *
 * 基于 Claude Contextual Embeddings 方法：
 * 1. 为每个代码块生成简短的上下文描述
 * 2. 将上下文描述 + 原始内容一起用于索引
 * 3. 提高检索精度
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface LLMConfig {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
}

export interface ContextResult {
    context: string;        // LLM 生成的上下文描述
    codeStructure: CodeStructure;  // 代码结构分析
}

export interface CodeStructure {
    functions: string[];    // 函数名列表
    classes: string[];      // 类名列表
    imports: string[];      // 导入语句
    exports: string[];      // 导出语句
    type: 'module' | 'class' | 'script' | 'config' | 'unknown';
}

// 生成上下文描述的 Prompt（参考 Claude Contextual Embeddings）
const CONTEXT_PROMPT = `You are a code analyzer. Given a code file, generate a brief context description (2-3 sentences) that explains:
1. What this file does (purpose)
2. Key components (main functions/classes)
3. Where it fits in a project

Be concise and focus on searchable keywords. Answer in the same language as code comments (if Chinese comments, answer in Chinese).

File path: {filePath}
Content:
\`\`\`
{content}
\`\`\`

Context description:`;

/**
 * 代码结构解析器 - 使用正则表达式提取代码结构
 * 不依赖 LLM，快速本地解析
 */
export function parseCodeStructure(content: string, filePath: string): CodeStructure {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const structure: CodeStructure = {
        functions: [],
        classes: [],
        imports: [],
        exports: [],
        type: 'unknown'
    };

    // 根据文件扩展名选择解析策略
    if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
        parseJavaScriptLike(content, structure);
    } else if (['py', 'pyw'].includes(ext)) {
        parsePython(content, structure);
    } else if (['go'].includes(ext)) {
        parseGo(content, structure);
    } else if (['rs'].includes(ext)) {
        parseRust(content, structure);
    } else if (['java', 'kt', 'scala'].includes(ext)) {
        parseJavaLike(content, structure);
    } else if (['json', 'yaml', 'yml', 'toml'].includes(ext)) {
        structure.type = 'config';
    } else if (['md', 'mdx', 'txt'].includes(ext)) {
        structure.type = 'unknown';  // 文档类型
    }

    // 推断文件类型
    if (structure.classes.length > 0) {
        structure.type = 'class';
    } else if (structure.functions.length > 0 || structure.imports.length > 0) {
        structure.type = 'module';
    }

    return structure;
}

// JavaScript/TypeScript 解析
function parseJavaScriptLike(content: string, structure: CodeStructure): void {
    // 函数: function name(), const name = () =>, async function name()
    const funcPatterns = [
        /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
        /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
        /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?function/g,
        /(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/g,  // 对象方法
    ];
    for (const pattern of funcPatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
            if (match[1] && !structure.functions.includes(match[1])) {
                structure.functions.push(match[1]);
            }
        }
    }

    // 类: class Name, export class Name
    const classPattern = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
    let match;
    while ((match = classPattern.exec(content)) !== null) {
        if (match[1] && !structure.classes.includes(match[1])) {
            structure.classes.push(match[1]);
        }
    }

    // 导入: import ... from '...'
    const importPattern = /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = importPattern.exec(content)) !== null) {
        if (match[1] && !structure.imports.includes(match[1])) {
            structure.imports.push(match[1]);
        }
    }

    // 导出: export { }, export default, export const
    const exportPattern = /export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type)\s+(\w+)/g;
    while ((match = exportPattern.exec(content)) !== null) {
        if (match[1] && !structure.exports.includes(match[1])) {
            structure.exports.push(match[1]);
        }
    }
}

// Python 解析
function parsePython(content: string, structure: CodeStructure): void {
    // 函数: def name(
    const funcPattern = /^(?:async\s+)?def\s+(\w+)\s*\(/gm;
    let match;
    while ((match = funcPattern.exec(content)) !== null) {
        if (match[1] && !structure.functions.includes(match[1])) {
            structure.functions.push(match[1]);
        }
    }

    // 类: class Name
    const classPattern = /^class\s+(\w+)/gm;
    while ((match = classPattern.exec(content)) !== null) {
        if (match[1] && !structure.classes.includes(match[1])) {
            structure.classes.push(match[1]);
        }
    }

    // 导入: import x, from x import y
    const importPatterns = [
        /^import\s+(\w+)/gm,
        /^from\s+([\w.]+)\s+import/gm
    ];
    for (const pattern of importPatterns) {
        while ((match = pattern.exec(content)) !== null) {
            if (match[1] && !structure.imports.includes(match[1])) {
                structure.imports.push(match[1]);
            }
        }
    }
}

// Go 解析
function parseGo(content: string, structure: CodeStructure): void {
    // 函数: func name(
    const funcPattern = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/gm;
    let match;
    while ((match = funcPattern.exec(content)) !== null) {
        if (match[1] && !structure.functions.includes(match[1])) {
            structure.functions.push(match[1]);
        }
    }
    // 结构体: type Name struct
    const structPattern = /^type\s+(\w+)\s+struct/gm;
    while ((match = structPattern.exec(content)) !== null) {
        if (match[1] && !structure.classes.includes(match[1])) {
            structure.classes.push(match[1]);
        }
    }
    // 导入: import "path" 或 import (...)
    const importPattern = /import\s+(?:\(\s*)?["']([^"']+)["']/g;
    while ((match = importPattern.exec(content)) !== null) {
        if (match[1] && !structure.imports.includes(match[1])) {
            structure.imports.push(match[1]);
        }
    }
}

// Rust 解析
function parseRust(content: string, structure: CodeStructure): void {
    // 函数: fn name(, pub fn name(
    const funcPattern = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]/g;
    let match;
    while ((match = funcPattern.exec(content)) !== null) {
        if (match[1] && !structure.functions.includes(match[1])) {
            structure.functions.push(match[1]);
        }
    }
    // 结构体/枚举: struct Name, enum Name, impl Name
    const typePatterns = [
        /(?:pub\s+)?struct\s+(\w+)/g,
        /(?:pub\s+)?enum\s+(\w+)/g,
        /impl(?:<[^>]+>)?\s+(\w+)/g
    ];
    for (const pattern of typePatterns) {
        while ((match = pattern.exec(content)) !== null) {
            if (match[1] && !structure.classes.includes(match[1])) {
                structure.classes.push(match[1]);
            }
        }
    }
    // 导入: use crate::path
    const usePattern = /use\s+([\w:]+)/g;
    while ((match = usePattern.exec(content)) !== null) {
        if (match[1] && !structure.imports.includes(match[1])) {
            structure.imports.push(match[1]);
        }
    }
}

// Java/Kotlin/Scala 解析
function parseJavaLike(content: string, structure: CodeStructure): void {
    // 方法: public void name(, private int name(
    const methodPattern = /(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/g;
    let match;
    while ((match = methodPattern.exec(content)) !== null) {
        if (match[1] && !['if', 'while', 'for', 'switch', 'catch'].includes(match[1])) {
            if (!structure.functions.includes(match[1])) {
                structure.functions.push(match[1]);
            }
        }
    }
    // 类: class Name, interface Name
    const classPatterns = [
        /(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/g,
        /(?:public\s+)?interface\s+(\w+)/g
    ];
    for (const pattern of classPatterns) {
        while ((match = pattern.exec(content)) !== null) {
            if (match[1] && !structure.classes.includes(match[1])) {
                structure.classes.push(match[1]);
            }
        }
    }
    // 导入: import xxx.yyy
    const importPattern = /import\s+([\w.]+)/g;
    while ((match = importPattern.exec(content)) !== null) {
        if (match[1] && !structure.imports.includes(match[1])) {
            structure.imports.push(match[1]);
        }
    }
}



/**
 * 生成本地上下文描述（不调用 LLM）
 * 基于代码结构分析生成描述
 */
export function generateLocalContext(content: string, filePath: string): ContextResult {
    const structure = parseCodeStructure(content, filePath);

    // 构建本地上下文描述
    const parts: string[] = [];

    if (structure.type === 'config') {
        parts.push(`Configuration file: ${filePath.split('/').pop()}`);
    } else if (structure.type === 'class') {
        parts.push(`Classes: ${structure.classes.join(', ')}`);
    }

    if (structure.functions.length > 0) {
        parts.push(`Functions: ${structure.functions.slice(0, 10).join(', ')}${structure.functions.length > 10 ? '...' : ''}`);
    }

    if (structure.imports.length > 0) {
        parts.push(`Imports: ${structure.imports.slice(0, 5).join(', ')}${structure.imports.length > 5 ? '...' : ''}`);
    }

    if (structure.exports.length > 0) {
        parts.push(`Exports: ${structure.exports.slice(0, 5).join(', ')}${structure.exports.length > 5 ? '...' : ''}`);
    }

    return {
        context: parts.join('. ') || `File: ${filePath.split('/').pop()}`,
        codeStructure: structure
    };
}

/**
 * 使用 LLM 生成上下文描述
 * 调用用户配置的第三方 API
 */
export async function generateContextWithLLM(
    content: string,
    filePath: string,
    config: LLMConfig,
    maxContentLength: number = 4000
): Promise<ContextResult> {
    const structure = parseCodeStructure(content, filePath);

    // 截断过长的内容
    const truncatedContent = content.length > maxContentLength
        ? content.substring(0, maxContentLength) + '\n... [truncated]'
        : content;

    // 构建 prompt
    const prompt = CONTEXT_PROMPT
        .replace('{filePath}', filePath)
        .replace('{content}', truncatedContent);

    try {
        const context = await callLLMAPI(prompt, config);
        return { context, codeStructure: structure };
    } catch (error) {
        // LLM 调用失败，回退到本地生成
        console.error(`LLM context generation failed for ${filePath}:`, error);
        return generateLocalContext(content, filePath);
    }
}

/**
 * 调用 LLM API（非流式，同步等待结果）
 */
async function callLLMAPI(prompt: string, config: LLMConfig): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = new URL(config.baseUrl);
        const isHttps = url.protocol === 'https:';

        const requestBody = JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 200,
            temperature: 0.3,
            stream: false
        });

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const httpModule = isHttps ? https : http;
        const req = httpModule.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`API error ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try {
                    const json = JSON.parse(data);
                    const content = json.choices?.[0]?.message?.content || '';
                    resolve(content.trim());
                } catch (e) {
                    reject(new Error(`Failed to parse API response: ${e}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('API request timeout'));
        });

        req.write(requestBody);
        req.end();
    });
}

/**
 * 批量生成上下文（带速率限制）
 */
export async function batchGenerateContext(
    files: Array<{ path: string; content: string }>,
    config: LLMConfig | null,
    onProgress?: (current: number, total: number) => void,
    concurrency: number = 3,
    delayMs: number = 200
): Promise<Map<string, ContextResult>> {
    const results = new Map<string, ContextResult>();
    const total = files.length;
    let current = 0;

    // 如果没有 LLM 配置，全部使用本地生成
    if (!config || !config.apiKey) {
        for (const file of files) {
            results.set(file.path, generateLocalContext(file.content, file.path));
            current++;
            onProgress?.(current, total);
        }
        return results;
    }

    // 并发控制
    const queue = [...files];
    const workers: Promise<void>[] = [];

    for (let i = 0; i < concurrency; i++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const file = queue.shift();
                if (!file) break;

                try {
                    const result = await generateContextWithLLM(
                        file.content, file.path, config
                    );
                    results.set(file.path, result);
                } catch {
                    results.set(file.path, generateLocalContext(file.content, file.path));
                }

                current++;
                onProgress?.(current, total);

                // 速率限制
                if (queue.length > 0) {
                    await new Promise(r => setTimeout(r, delayMs));
                }
            }
        })());
    }

    await Promise.all(workers);
    return results;
}