// ===== Augment Proxy VSCode Extension 入口 =====
import * as vscode from 'vscode';
import { state, log } from './globals';
import { startProxy, stopProxy, configureProvider, showStatus, updateStatusBar, initializeRAGIndex, closeRAGIndex } from './proxy';
import { injectPlugin, restorePlugin } from './injection';
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
        vscode.commands.registerCommand('augmentProxy.showStatus', () => showStatus()),
        vscode.commands.registerCommand('augmentProxy.injectPlugin', injectPlugin),
        vscode.commands.registerCommand('augmentProxy.restorePlugin', restorePlugin)
    );

    log('Augment Proxy Manager 已激活');

    // 异步初始化 RAG 索引
    initializeRAGIndex().catch(err => log(`[RAG] Background initialization failed: ${err}`));
}

export async function deactivate() {
    // 清除 Augment 扩展的自动配置，避免代理停止后扩展仍指向已关闭的代理
    try {
        const augmentConfig = vscode.workspace.getConfiguration('augment');
        await augmentConfig.update('advanced.apiToken', undefined, vscode.ConfigurationTarget.Global);
        await augmentConfig.update('advanced.completionURL', undefined, vscode.ConfigurationTarget.Global);
    } catch {}
    await closeRAGIndex();
    if (state.proxyServer) state.proxyServer.close();
}
