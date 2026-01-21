// ===== AUGMENT CUSTOM MODEL INJECTION v7.1 =====
// 核心修复：同时 hook global.fetch 和 globalThis.fetch
// 逆向确认：Augment 使用 global.fetch (extension.js 第6832行)
// v7.1 修复：默认允许请求通过，避免阻塞 Augment 初始化
(function() {
    "use strict";
    var CONFIG = {
        enabled: true,
        proxyUrl: 'http://localhost:8765',
        debug: true,
        proxyAvailable: true,  // v7.1: 默认 true，避免阻塞初始化
        proxyChecked: false
    };
    var log = function() {
        if (CONFIG.debug) console.log.apply(console, ['[Augment-Proxy]'].concat(Array.prototype.slice.call(arguments)));
    };

    // ===== 立即保存原始 fetch 引用（最高优先级）=====
    var _originalGlobalFetch = global.fetch;
    var _originalGlobalThisFetch = globalThis.fetch;
    log('📌 Saved original fetch references');

    // 检查代理健康状态
    var checkProxyHealth = function() {
        try {
            var http = require('http');
            var req = http.request({ hostname: 'localhost', port: 8765, path: '/health', method: 'GET', timeout: 2000 }, function(res) {
                var wasAvailable = CONFIG.proxyAvailable;
                CONFIG.proxyAvailable = res.statusCode === 200;
                CONFIG.proxyChecked = true;
                if (CONFIG.proxyAvailable && !wasAvailable) log('✅ Proxy is now available');
                if (!CONFIG.proxyAvailable && wasAvailable) log('⚠️ Proxy became unavailable');
            });
            req.on('error', function() {
                if (CONFIG.proxyChecked) CONFIG.proxyAvailable = false;
                // 首次检查失败不改变状态，保持 true 让请求尝试通过
            });
            req.on('timeout', function() {
                req.destroy();
                if (CONFIG.proxyChecked) CONFIG.proxyAvailable = false;
            });
            req.end();
        } catch(e) {
            if (CONFIG.proxyChecked) CONFIG.proxyAvailable = false;
        }
    };
    checkProxyHealth();
    setInterval(checkProxyHealth, 5000);

    // 模拟 Pro 状态
    globalThis.__AUGMENT_MOCK_STATE__ = {
        authenticated: true, hasValidSubscription: true, isLoggedIn: true,
        subscriptionType: 'pro', userId: 'proxy', email: 'p@a.com'
    };

    // ===== 创建统一的 fetch 拦截器 =====
    var createProxiedFetch = function(origFetch) {
        return function proxiedFetch(input, init) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            if (!CONFIG.enabled) return origFetch.apply(this, arguments);

            var isAugment = url.indexOf('augmentcode.com') >= 0;
            if (!isAugment) return origFetch.apply(this, arguments);

            // v7.1: 总是尝试通过代理，让连接错误自然发生
            var pathMatch = url.match(/augmentcode\.com(\/[^\?#]*)/);
            var path = pathMatch ? pathMatch[1] : '/';
            var newUrl = CONFIG.proxyUrl + path;
            log('🔄 [FETCH] Route:', url.substring(0, 60), '->', newUrl);

            var newInit = Object.assign({}, init, {
                headers: Object.assign({}, init && init.headers, {
                    'Content-Type': 'application/json',
                    'X-Original-URL': url
                })
            });
            return origFetch(newUrl, newInit).catch(function(e) {
                log('❌ [FETCH] Proxy error:', e.message, '- 请确保代理服务器已启动');
                // v7.1: 返回更友好的错误
                return Promise.resolve(new Response(JSON.stringify({
                    error: 'Proxy connection failed',
                    message: '请启动代理服务器: Augment Proxy > Start Server',
                    blocked: true
                }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
            });
        };
    };

    // ===== 核心修复：同时 hook global.fetch 和 globalThis.fetch =====
    var proxiedFetch = createProxiedFetch(_originalGlobalFetch || _originalGlobalThisFetch);

    // Hook global.fetch (Node.js 环境)
    try {
        Object.defineProperty(global, 'fetch', {
            value: proxiedFetch,
            writable: false,
            configurable: true
        });
        log('✅ global.fetch hooked (Object.defineProperty)');
    } catch(e) {
        global.fetch = proxiedFetch;
        log('✅ global.fetch hooked (direct assignment)');
    }

    // Hook globalThis.fetch (确保兼容)
    try {
        Object.defineProperty(globalThis, 'fetch', {
            value: proxiedFetch,
            writable: false,
            configurable: true
        });
        log('✅ globalThis.fetch hooked (Object.defineProperty)');
    } catch(e) {
        globalThis.fetch = proxiedFetch;
        log('✅ globalThis.fetch hooked (direct assignment)');
    }

    // ===== 拦截 Node.js https.request =====
    try {
        var https = require('https');
        var http = require('http');
        var origHttpsRequest = https.request;
        var origHttpRequest = http.request;

        var interceptRequest = function(origRequest, protocol) {
            return function(urlOrOptions, optionsOrCallback, callback) {
                var options = typeof urlOrOptions === 'string' ? require('url').parse(urlOrOptions) : urlOrOptions;
                if (typeof optionsOrCallback === 'function') {
                    callback = optionsOrCallback;
                } else if (optionsOrCallback) {
                    options = Object.assign({}, options, optionsOrCallback);
                }

                var host = options.hostname || options.host || '';
                var isAugment = host.indexOf('augmentcode.com') >= 0;

                if (!CONFIG.enabled || !isAugment) {
                    return origRequest.apply(this, arguments);
                }

                // v7.1: 直接尝试通过代理，不再预先阻止
                var path = options.path || '/';
                log('🔄 [' + protocol.toUpperCase() + '] Intercepting:', host + path);

                var proxyOptions = {
                    hostname: 'localhost',
                    port: 8765,
                    path: path,
                    method: options.method || 'GET',
                    headers: Object.assign({}, options.headers, {
                        'X-Original-Host': host,
                        'X-Original-URL': protocol + '://' + host + path
                    })
                };

                log('🔄 [' + protocol.toUpperCase() + '] -> localhost:8765' + path);
                return origHttpRequest.call(http, proxyOptions, callback);
            };
        };

        https.request = interceptRequest(origHttpsRequest, 'https');
        http.request = interceptRequest(origHttpRequest, 'http');
        log('✅ Node.js https/http.request intercepted');
    } catch(e) {
        log('⚠️ Failed to intercept https.request:', e.message);
    }

    globalThis.__AUGMENT_PROXY__ = {
        CONFIG: CONFIG,
        version: '7.1',
        enable: function() { CONFIG.enabled = true; log('Enabled'); },
        disable: function() { CONFIG.enabled = false; log('Disabled'); },
        setProxyUrl: function(url) { CONFIG.proxyUrl = url; checkProxyHealth(); },
        setDebug: function(v) { CONFIG.debug = v; },
        checkProxy: checkProxyHealth,
        status: function() { console.log('[Augment-Proxy] Status:', CONFIG); }
    };
    log('==================================================');
    log('🎉 Augment Proxy Injection v7.1 loaded!');
    log('   🔧 Hook global.fetch + globalThis.fetch');
    log('   📌 v7.1: 不再预先阻止请求，避免初始化问题');
    log('   Proxy URL:', CONFIG.proxyUrl);
    log('   ⚠️  请确保代理服务器已启动');
    log('==================================================');
})();
// ===== END AUGMENT PROXY INJECTION =====

