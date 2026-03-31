// ===== ToolResultFormatter =====
// 从 tools.ts 提取 renderDiffText，统一工具结果格式化

import { ToolResult } from './Tool';

export function renderDiffText(result: ToolResult, toolName: string): string {
    if (!result) return '';
    const diffs = result.diffs;
    if (!diffs || diffs.length === 0) {
        return result.success ? `\n✅ ${toolName}\n` : `\n❌ ${toolName} failed\n`;
    }

    const parts: string[] = [];
    for (const diff of diffs) {
        const fileName = diff.file;
        const oldLines = (diff.oldStr || '').split('\n');
        const newLines = (diff.newStr || '').split('\n');

        // 新建文件
        if (!diff.oldStr && diff.newStr) {
            const preview = newLines.slice(0, 15);
            parts.push(`\n✅ **${toolName}** → \`${fileName}\` (新建)\n\`\`\`\n${preview.join('\n')}${newLines.length > 15 ? '\n... (+' + (newLines.length - 15) + ' lines)' : ''}\n\`\`\`\n`);
            continue;
        }

        // 大文件跳过详细 diff
        if (oldLines.length > 50 && newLines.length > 50) {
            parts.push(`\n✅ **${toolName}** → \`${fileName}\` (${oldLines.length} → ${newLines.length} lines)\n`);
            continue;
        }

        // 行级 diff
        const removed: string[] = [];
        const added: string[] = [];
        const maxShow = 12;

        for (const line of oldLines) { if (removed.length < maxShow) removed.push(`- ${line}`); }
        if (oldLines.length > maxShow) removed.push(`  ... (${oldLines.length - maxShow} more removed)`);
        for (const line of newLines) { if (added.length < maxShow) added.push(`+ ${line}`); }
        if (newLines.length > maxShow) added.push(`  ... (${newLines.length - maxShow} more added)`);

        parts.push(`\n✅ **${toolName}** → \`${fileName}\`\n\`\`\`diff\n${removed.join('\n')}\n${added.join('\n')}\n\`\`\`\n`);
    }
    return parts.join('') || (result.success ? `\n✅ ${toolName}\n` : `\n❌ ${toolName} failed\n`);
}

// 兼容旧的 interceptResult 格式
export function renderDiffTextCompat(interceptResult: any, toolName: string): string {
    if (!interceptResult) return '';
    return renderDiffText({
        success: interceptResult.success ?? true,
        content: interceptResult.message || '',
        diffs: interceptResult.diffs,
        error: interceptResult.error
    }, toolName);
}
