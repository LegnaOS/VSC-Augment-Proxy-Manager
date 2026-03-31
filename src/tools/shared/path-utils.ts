// ===== 路径修正工具 =====
// 从 fixToolCallInput 提取路径前缀修正逻辑

import { log } from '../../globals';

export function fixPathPrefix(toolName: string, input: any, workspaceInfo: any): any {
    const fileTools = ['save-file', 'view', 'remove-files', 'str-replace-editor'];
    if (!fileTools.includes(toolName) || !workspaceInfo) return input;

    const workspacePath = workspaceInfo.workspacePath || '';
    const repoRoot = workspaceInfo.repositoryRoot || '';

    let relativePrefix = '';
    if (repoRoot && workspacePath && workspacePath.startsWith(repoRoot) && workspacePath !== repoRoot) {
        relativePrefix = workspacePath.substring(repoRoot.length).replace(/^\//, '');
    }

    if (!relativePrefix) return input;

    if (input.path && typeof input.path === 'string' && !input.path.startsWith('/') && !input.path.startsWith(relativePrefix)) {
        const originalPath = input.path;
        input.path = relativePrefix + '/' + input.path;
        log(`[PATH FIX] ${toolName}: "${originalPath}" -> "${input.path}"`);
    }
    if (input.file_paths && Array.isArray(input.file_paths)) {
        input.file_paths = input.file_paths.map((p: string) => {
            if (typeof p === 'string' && !p.startsWith('/') && !p.startsWith(relativePrefix)) {
                const newPath = relativePrefix + '/' + p;
                log(`[PATH FIX] ${toolName} file_paths: "${p}" -> "${newPath}"`);
                return newPath;
            }
            return p;
        });
    }

    return input;
}
