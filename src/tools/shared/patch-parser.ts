// ===== Patch 解析器 =====
// 从 tools.ts 提取，支持 Augment V4A 和标准 Unified Diff 两种格式

export interface ParsedPatch {
    filePath: string;
    oldContent: string;
    newContent: string;
    startLine?: number;
    endLine?: number;
}

export interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}

export function parsePatchInput(patchInput: string): ParsedPatch[] {
    const patches: ParsedPatch[] = [];
    const lines = patchInput.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (line.startsWith('*** Update File:') || line.startsWith('*** Create File:')) {
            const filePath = line.split(':')[1]?.trim() || '';
            i++;
            const patch = parseAugmentPatch(lines, i, filePath);
            if (patch) {
                patches.push(patch);
                i = patch.nextIndex;
            }
            continue;
        }

        if (line.startsWith('--- ') || line.startsWith('diff --git')) {
            const patch = parseUnifiedDiff(lines, i);
            if (patch) {
                patches.push(patch.patch);
                i = patch.nextIndex;
            } else {
                i++;
            }
            continue;
        }

        i++;
    }

    return patches;
}

function parseAugmentPatch(lines: string[], startIndex: number, filePath: string): (ParsedPatch & { nextIndex: number }) | null {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let i = startIndex;
    let hasAnyDiffMarkers = false;

    while (i < lines.length) {
        const line = lines[i];

        if (line.startsWith('*** ') && (line.includes('File:') || line.includes('End Patch'))) {
            break;
        }

        if (line.startsWith('@@')) {
            hasAnyDiffMarkers = true;
            i++;
            continue;
        }

        if (line.startsWith('-')) {
            hasAnyDiffMarkers = true;
            const content = line.startsWith('- ') ? line.substring(2) : line.substring(1);
            oldLines.push(content);
            i++;
            continue;
        }

        if (line.startsWith('+')) {
            hasAnyDiffMarkers = true;
            const content = line.startsWith('+ ') ? line.substring(2) : line.substring(1);
            newLines.push(content);
            i++;
            continue;
        }

        oldLines.push(line);
        newLines.push(line);
        i++;
    }

    if (oldLines.length === 0 && newLines.length === 0) return null;

    if (!hasAnyDiffMarkers && newLines.length > 0) {
        return { filePath, oldContent: '', newContent: newLines.join('\n'), nextIndex: i };
    }

    return { filePath, oldContent: oldLines.join('\n'), newContent: newLines.join('\n'), nextIndex: i };
}

function parseUnifiedDiff(lines: string[], startIndex: number): { patch: ParsedPatch; nextIndex: number } | null {
    let i = startIndex;
    let filePath = '';

    if (lines[i].startsWith('diff --git')) {
        const match = lines[i].match(/diff --git a\/(.+?) b\//);
        if (match) filePath = match[1];
        i++;
    }

    while (i < lines.length && !lines[i].startsWith('---')) { i++; }

    if (i < lines.length && lines[i].startsWith('---')) {
        if (!filePath) {
            const match = lines[i].match(/^--- (?:a\/)?(.+?)$/);
            if (match) filePath = match[1];
        }
        i++;
    }

    if (i < lines.length && lines[i].startsWith('+++')) { i++; }
    if (!filePath) return null;

    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
        const hunk = parseHunk(lines, i);
        if (hunk) { hunks.push(hunk.hunk); i = hunk.nextIndex; }
        else break;
    }

    if (hunks.length === 0) return null;

    const { oldContent, newContent, startLine, endLine } = mergeHunks(hunks);
    return { patch: { filePath, oldContent, newContent, startLine, endLine }, nextIndex: i };
}

function parseHunk(lines: string[], startIndex: number): { hunk: Hunk; nextIndex: number } | null {
    const match = lines[startIndex].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) return null;

    const hunkLines: string[] = [];
    let i = startIndex + 1;

    while (i < lines.length) {
        const l = lines[i];
        if (l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++') || l.startsWith('diff --git')) break;
        hunkLines.push(l);
        i++;
    }

    return {
        hunk: {
            oldStart: parseInt(match[1], 10),
            oldLines: match[2] ? parseInt(match[2], 10) : 1,
            newStart: parseInt(match[3], 10),
            newLines: match[4] ? parseInt(match[4], 10) : 1,
            lines: hunkLines
        },
        nextIndex: i
    };
}

export function mergeHunks(hunks: Hunk[]): { oldContent: string; newContent: string; startLine: number; endLine: number } {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let minLine = Infinity;
    let maxLine = -Infinity;

    for (const hunk of hunks) {
        minLine = Math.min(minLine, hunk.oldStart);
        maxLine = Math.max(maxLine, hunk.oldStart + hunk.oldLines - 1);

        for (const line of hunk.lines) {
            if (line.startsWith(' ')) { oldLines.push(line.substring(1)); newLines.push(line.substring(1)); }
            else if (line.startsWith('-')) { oldLines.push(line.substring(1)); }
            else if (line.startsWith('+')) { newLines.push(line.substring(1)); }
            else if (line.trim() === '') { oldLines.push(''); newLines.push(''); }
        }
    }

    return {
        oldContent: oldLines.join('\n'),
        newContent: newLines.join('\n'),
        startLine: minLine !== Infinity ? minLine : 1,
        endLine: maxLine !== -Infinity ? maxLine : 1
    };
}
