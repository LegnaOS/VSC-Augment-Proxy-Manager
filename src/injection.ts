// ===== 插件注入与恢复（Fallback 方案，主方案为零注入自动配置）=====
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { state, log } from './globals';
import { updateStatusBar } from './proxy';

// ========== 跨平台 Augment 插件路径检测 ==========
// 支持: VSCode / VSCode Insiders / Cursor / Windsurf / macOS / Windows / Linux
function getExtensionsDirs(): string[] {
    const home = os.homedir();
    const platform = process.platform;
    // 所有可能的 VSCode 变体目录名
    const variants = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'];
    const dirs: string[] = [];
    if (platform === 'win32') {
        // Windows: %USERPROFILE%\.vscode\extensions 或 %APPDATA%\Code\extensions
        for (const v of variants) dirs.push(path.join(home, v, 'extensions'));
        const appData = process.env.APPDATA;
        if (appData) {
            dirs.push(path.join(appData, 'Code', 'extensions'));
            dirs.push(path.join(appData, 'Code - Insiders', 'extensions'));
        }
    } else {
        // macOS / Linux: ~/.vscode/extensions
        for (const v of variants) dirs.push(path.join(home, v, 'extensions'));
    }
    return dirs.filter(d => { try { return fs.existsSync(d); } catch { return false; } });
}

export function getAugmentExtensionPath(): string | null {
    for (const dir of getExtensionsDirs()) {
        try {
            const augmentDirs = fs.readdirSync(dir)
                .filter(d => d.startsWith('augment.vscode-augment-'))
                .sort();
            if (augmentDirs.length > 0) return path.join(dir, augmentDirs[augmentDirs.length - 1]);
        } catch {}
    }
    return null;
}

// ========== 检查注入状态 ==========
export function checkInjectionStatus(): boolean {
    try {
        const extPath = getAugmentExtensionPath();
        if (!extPath) return false;
        const jsPath = path.join(extPath, 'out', 'extension.js');
        if (fs.existsSync(jsPath)) return fs.readFileSync(jsPath, 'utf-8').includes('AUGMENT CUSTOM MODEL INJECTION');
    } catch {}
    return false;
}

// ========== 生成注入代码 ==========
function generateInjectionCode(proxyUrl: string): string {
    const timestamp = new Date().toISOString();
    return `
// ===== AUGMENT CUSTOM MODEL INJECTION v9.0 =====
// Injected at: ${timestamp}
// v9.0: 代理不启动时保持原版 Augment 功能（不注入 mockPluginState）
(function() {
    "use strict";
    const CONFIG = { enabled: true, proxyUrl: '${proxyUrl}', debug: true, routeAllRequests: true, proxyAvailable: false, checkInterval: null };
    const log = (...args) => { if (CONFIG.debug) console.log('[Augment-Proxy]', ...args); };
    const checkProxyHealth = async () => {
        try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 1000); const r = await fetch(CONFIG.proxyUrl + '/health', { method: 'GET', signal: c.signal }); clearTimeout(t); CONFIG.proxyAvailable = r.ok; if (CONFIG.proxyAvailable) log('Proxy is available'); } catch (e) { CONFIG.proxyAvailable = false; }
        return CONFIG.proxyAvailable;
    };
    checkProxyHealth(); CONFIG.checkInterval = setInterval(checkProxyHealth, 5000);
    globalThis.__AUGMENT_PROXY__ = { CONFIG, enable: () => { CONFIG.enabled = true; }, disable: () => { CONFIG.enabled = false; }, setProxyUrl: (url) => { CONFIG.proxyUrl = url; checkProxyHealth(); }, status: () => console.log('[Augment-Proxy] Status:', CONFIG), checkProxy: checkProxyHealth };
    log('Injection loaded'); log('Proxy URL:', CONFIG.proxyUrl);
    const mockPluginState = { authenticated: true, hasValidSubscription: true, isLoggedIn: true, subscriptionType: 'pro', userId: 'proxy-user', email: 'proxy@augmentcode.com', planName: 'Pro', features: { chat: true, completion: true, instruction: true, agentMode: true }, modelConfig: { internalName: 'proxy-model', displayName: 'Proxy Model' }, getValue: (k, d) => d, setValue: () => true, getUser: () => ({ id: 'proxy-user', email: 'proxy@augmentcode.com' }), getSubscription: () => ({ plan: 'Pro', valid: true }), isAuthenticated: () => true, hasFeature: () => true, onDidChange: () => ({ dispose: () => {} }) };
    globalThis.__AUGMENT_MOCK_STATE__ = mockPluginState;
    const tryInjectMockState = () => {
        if (!CONFIG.proxyAvailable) { log('Proxy not available, skipping PluginState mock injection'); return; }
        log('Proxy is available, attempting to patch PluginState singleton...');
        try { for (const key in globalThis) { try { const obj = globalThis[key]; if (obj && typeof obj === 'object' && typeof obj.getStateForSidecar === 'function') { log('Found PluginState singleton:', key); if (obj._instance === void 0 || !obj._instance.__isProxyMock) { obj._instance = mockPluginState; obj._instance.__isProxyMock = true; log('PluginState mock injected!'); } } } catch (e) {} } } catch (e) { log('Error patching PluginState:', e.message); }
    };
    setTimeout(tryInjectMockState, 1000);
    const originalCheck = checkProxyHealth;
    const enhanced = async () => { const was = CONFIG.proxyAvailable; const r = await originalCheck(); if (!was && CONFIG.proxyAvailable) { log('Proxy became available, injecting mock state...'); tryInjectMockState(); } return r; };
    CONFIG.checkInterval && clearInterval(CONFIG.checkInterval); enhanced(); CONFIG.checkInterval = setInterval(enhanced, 5000);
    // fetch 拦截
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function(url, options = {}) {
        if (!CONFIG.enabled) return originalFetch.call(this, url, options);
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (!urlStr.includes('augmentcode.com')) return originalFetch.call(this, url, options);
        if (!CONFIG.proxyAvailable) { log('Proxy not available, passing through:', urlStr.substring(0, 80)); return originalFetch.call(this, url, options); }
        let ep = null;
        if (urlStr.includes('/chat-stream')) ep = '/chat-stream'; else if (urlStr.includes('/chat-input-completion')) ep = '/chat-input-completion'; else if (urlStr.includes('/chat')) ep = '/chat'; else if (urlStr.includes('/instruction-stream')) ep = '/instruction-stream'; else if (urlStr.includes('/smart-paste-stream')) ep = '/smart-paste-stream'; else if (urlStr.includes('/completion')) ep = '/completion';
        else if (urlStr.includes('/getPluginState')) ep = '/getPluginState'; else if (urlStr.includes('/get-model-config')) ep = '/get-model-config'; else if (urlStr.includes('/get-models')) ep = '/get-models';
        else if (urlStr.includes('/agents/codebase-retrieval')) ep = '/agents/codebase-retrieval'; else if (urlStr.includes('/agents/edit-file')) ep = '/agents/edit-file'; else if (urlStr.includes('/agents/list-remote-tools')) ep = '/agents/list-remote-tools'; else if (urlStr.includes('/agents/run-remote-tool')) ep = '/agents/run-remote-tool';
        else if (urlStr.includes('/remote-agents/list-stream')) ep = '/remote-agents/list-stream'; else if (urlStr.includes('/subscription-banner')) ep = '/subscription-banner'; else if (urlStr.includes('/save-chat')) ep = '/save-chat';
        else if (urlStr.includes('/user-secrets/list')) ep = '/user-secrets/list'; else if (urlStr.includes('/user-secrets/upsert')) ep = '/user-secrets/upsert'; else if (urlStr.includes('/user-secrets/delete')) ep = '/user-secrets/delete';
        else if (urlStr.includes('/notifications/mark-read')) ep = '/notifications/mark-read'; else if (urlStr.includes('/notifications')) ep = '/notifications';
        else if (urlStr.includes('/client-completion-timelines')) ep = '/client-completion-timelines'; else if (urlStr.includes('/record-session-events')) ep = '/record-session-events'; else if (urlStr.includes('/record-request-events')) ep = '/record-request-events';
        else if (urlStr.includes('/next-edit-stream')) ep = '/next-edit-stream'; else if (urlStr.includes('/find-missing')) ep = '/find-missing'; else if (urlStr.includes('/client-metrics')) ep = '/client-metrics'; else if (urlStr.includes('/batch-upload')) ep = '/batch-upload'; else if (urlStr.includes('/report-feature-vector')) ep = '/report-feature-vector'; else if (urlStr.includes('/report-error')) ep = '/report-error';
        if (!ep) { log('Passing through (no matching endpoint):', urlStr); return originalFetch.call(this, url, options); }
        const target = CONFIG.proxyUrl + ep; log('Intercepted:', urlStr, '->', target);
        try { const h = {}; if (options.headers) { const e = options.headers.entries ? [...options.headers.entries()] : Object.entries(options.headers); for (const [k, v] of e) { if (k.toLowerCase() === 'content-type') h[k] = v; } } h['Content-Type'] = 'application/json'; return await originalFetch.call(this, target, { method: options.method || 'POST', headers: h, body: options.body }); }
        catch (err) { log('Proxy error:', err.message, 'falling back'); return originalFetch.call(this, url, options); }
    };
    // Node.js http/https 拦截
    try {
        const https = require('https'); const http = require('http'); const oHttps = https.request; const oHttp = http.request;
        const getEp = (u) => { if(u.includes('/chat-stream'))return'/chat-stream';if(u.includes('/chat-input-completion'))return'/chat-input-completion';if(u.includes('/chat'))return'/chat';if(u.includes('/instruction-stream'))return'/instruction-stream';if(u.includes('/smart-paste-stream'))return'/smart-paste-stream';if(u.includes('/completion'))return'/completion';if(u.includes('/getPluginState'))return'/getPluginState';if(u.includes('/get-model-config'))return'/get-model-config';if(u.includes('/get-models'))return'/get-models';if(u.includes('/agents/codebase-retrieval'))return'/agents/codebase-retrieval';if(u.includes('/agents/edit-file'))return'/agents/edit-file';if(u.includes('/agents/list-remote-tools'))return'/agents/list-remote-tools';if(u.includes('/agents/run-remote-tool'))return'/agents/run-remote-tool';if(u.includes('/remote-agents/list-stream'))return'/remote-agents/list-stream';if(u.includes('/next-edit-stream'))return'/next-edit-stream';if(u.includes('/find-missing'))return'/find-missing';if(u.includes('/client-metrics'))return'/client-metrics';if(u.includes('/batch-upload'))return'/batch-upload';if(u.includes('/report-feature-vector'))return'/report-feature-vector';if(u.includes('/report-error'))return'/report-error';return null; };
        const wrap = (orig, proto) => function(urlOrOpts, opts, cb) { let t=''; if(typeof urlOrOpts==='string')t=urlOrOpts; else if(urlOrOpts&&urlOrOpts.hostname)t=proto+'://'+urlOrOpts.hostname+(urlOrOpts.path||''); if(!CONFIG.enabled||!t.includes('augmentcode.com')||!CONFIG.proxyAvailable)return orig.apply(this,arguments); const ep=getEp(t); if(!ep){log('HTTP: pass through:',t.substring(0,80));return orig.apply(this,arguments);} log('HTTP: Intercepting '+ep); const po={hostname:'localhost',port:8765,path:ep,method:(typeof urlOrOpts==='object'?urlOrOpts.method:'GET')||'GET',headers:typeof urlOrOpts==='object'?urlOrOpts.headers:{}}; po.headers['Content-Type']='application/json'; return oHttp.call(http,po,typeof opts==='function'?opts:cb); };
        https.request = wrap(oHttps, 'https'); http.request = wrap(oHttp, 'http'); log('Node.js http intercepted');
    } catch (e) { log('Failed to intercept http:', e.message); }
    log('🎉 Augment Proxy Injection v9.0 loaded!');
})();
// ===== END AUGMENT PROXY INJECTION =====

`;
}


// ========== 注入插件 ==========
export async function injectPlugin() {
    const extPath = getAugmentExtensionPath();
    if (!extPath) { vscode.window.showErrorMessage('未找到 Augment 插件'); return; }
    if (checkInjectionStatus()) {
        const confirm = await vscode.window.showWarningMessage('插件已注入，是否重新注入？', '是', '否');
        if (confirm !== '是') return;
        await restorePluginInternal(extPath);
    }
    const config = vscode.workspace.getConfiguration('augmentProxy');
    const port = config.get('port', 8765);
    const proxyUrl = `http://localhost:${port}`;
    try {
        const jsPath = path.join(extPath, 'out', 'extension.js');
        const backupPath = jsPath + '.backup';
        if (!fs.existsSync(backupPath)) { fs.copyFileSync(jsPath, backupPath); log('Created backup: extension.js.backup'); }
        let code = fs.readFileSync(jsPath, 'utf-8');
        code = generateInjectionCode(proxyUrl) + code;
        fs.writeFileSync(jsPath, code, 'utf-8');
        log(`注入成功! 代理: ${proxyUrl}`);
        updateStatusBar(!!state.proxyServer);
        const action = await vscode.window.showInformationMessage('插件注入成功！请重载 VSCode 窗口。', '重载窗口');
        if (action === '重载窗口') vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error: any) { log(`注入失败: ${error.message}`); vscode.window.showErrorMessage(`注入失败: ${error.message}`); }
}

// ========== 恢复插件内部 ==========
async function restorePluginInternal(extPath: string): Promise<boolean> {
    const jsPath = path.join(extPath, 'out', 'extension.js');
    const backupPath = jsPath + '.backup';
    if (fs.existsSync(backupPath)) { fs.copyFileSync(backupPath, jsPath); log('Restored from backup'); return true; }
    return false;
}

// ========== 恢复插件 ==========
export async function restorePlugin() {
    const extPath = getAugmentExtensionPath();
    if (!extPath) { vscode.window.showErrorMessage('未找到 Augment 插件'); return; }
    if (!checkInjectionStatus()) { vscode.window.showWarningMessage('插件未注入，无需恢复'); return; }
    const confirm = await vscode.window.showWarningMessage('确定要恢复原始插件吗？', '是', '否');
    if (confirm !== '是') return;
    try {
        if (await restorePluginInternal(extPath)) {
            updateStatusBar(!!state.proxyServer);
            const action = await vscode.window.showInformationMessage('插件已恢复！请重载 VSCode 窗口。', '重载窗口');
            if (action === '重载窗口') vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else { vscode.window.showErrorMessage('未找到备份文件'); }
    } catch (error: any) { log(`恢复失败: ${error.message}`); vscode.window.showErrorMessage(`恢复失败: ${error.message}`); }
}