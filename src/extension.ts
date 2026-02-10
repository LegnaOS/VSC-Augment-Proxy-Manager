// ===== Augment Proxy VSCode Extension 入口 =====
import * as vscode from 'vscode';
import { state, log } from './globals';
import { startProxy, stopProxy, configureProvider, showStatus, updateStatusBar, refreshConfig, initializeRAGIndex, closeRAGIndex } from './proxy';
import { AugmentProxySidebarProvider } from './sidebar';

export function activate(context: vscode.ExtensionContext) {
    state.extensionContext = context;
    state.outputChannel = vscode.window.createOutputChannel('Augment Proxy');

    // 侧边栏
    state.sidebarProvider = new AugmentProxySidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('augmentProxy.sidebar', state.sidebarProvider)
    );

    // 状态栏
    state.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    state.statusBarItem.command = 'augmentProxy.showStatus';
    updateStatusBar(false);
    state.statusBarItem.show();
    context.subscriptions.push(state.statusBarItem);

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('augmentProxy.startProxy', () => startProxy(context)),
        vscode.commands.registerCommand('augmentProxy.stopProxy', stopProxy),
        vscode.commands.registerCommand('augmentProxy.configureProvider', configureProvider),
        vscode.commands.registerCommand('augmentProxy.showStatus', () => showStatus())
    );

    // 配置变更监听 — 实现热更新，切换 Provider/Model 无需重启代理
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('augmentProxy')) {
                refreshConfig().catch(err => log(`[CONFIG] 热更新失败: ${err}`));
            }
        })
    );

    log('Augment Proxy Manager 已激活');

    // 异步初始化 RAG 索引
    initializeRAGIndex().catch(err => log(`[RAG] Background initialization failed: ${err}`));

    // 窗口重载后自动恢复代理（零注入流程的关键一环）
    if (context.globalState.get<boolean>('proxyAutoStart')) {
        context.globalState.update('proxyAutoStart', false);
        log('[AUTO-START] 检测到重载前代理正在运行，自动恢复...');
        setTimeout(() => startProxy(context), 1000);
    }
}

export async function deactivate() {
    // 清除 Augment 扩展的自动配置，避免代理停止后扩展仍指向已关闭的代理
    try {
        const augmentConfig = vscode.workspace.getConfiguration('augment');
        const currentAdvanced = augmentConfig.get<any>('advanced', {}) || {};
        await augmentConfig.update('advanced', { ...currentAdvanced, apiToken: '', completionURL: '' }, vscode.ConfigurationTarget.Global);
    } catch {}
    await closeRAGIndex();
    if (state.proxyServer) state.proxyServer.close();
}
