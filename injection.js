/* AUGMENT_PROXY_INJECTION_START */
(function() {
    "use strict";
    var CONFIG = { enabled: true, proxyUrl: 'http://localhost:8765', debug: false };
    var log = function() { if (CONFIG.debug) console.log.apply(console, ['[Proxy]'].concat(Array.prototype.slice.call(arguments))); };
    log('Injection loaded, Proxy:', CONFIG.proxyUrl);

    var mockState = {
        authenticated: true, hasValidSubscription: true, isLoggedIn: true,
        subscriptionType: 'pro', userId: 'proxy', email: 'p@a.com',
        getStateForSidecar: function() { return mockState; },
        getInstance: function() { return mockState; }
    };

    var origFetch = globalThis.fetch;
    globalThis.fetch = function(input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (!CONFIG.enabled) return origFetch.apply(this, arguments);

        var isAugment = url.indexOf('augmentcode.com') >= 0;
        if (!isAugment) return origFetch.apply(this, arguments);

        // 提取路径：从 URL 中获取端点路径
        var pathMatch = url.match(/augmentcode\.com(\/[^\?#]*)/);
        var path = pathMatch ? pathMatch[1] : '/';

        // 将所有 Augment API 请求转发到代理
        var newUrl = CONFIG.proxyUrl + path;
        log('Route:', url, '->', newUrl);

        var h = {};
        if (init && init.headers) {
            var hh = new Headers(init.headers);
            hh.forEach(function(v, k) { h[k] = v; });
        }
        h['X-Original-URL'] = url;

        var newInit = {};
        for (var k in init) { newInit[k] = init[k]; }
        newInit.headers = h;

        return origFetch(newUrl, newInit).catch(function(e) {
            log('Proxy error:', e, 'Fallback blocked');
            // 代理失败时返回空响应，避免请求官方服务器
            return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        });
    };

    globalThis.__AUGMENT_PROXY__ = {
        config: CONFIG,
        enable: function() { CONFIG.enabled = true; log('Enabled'); },
        disable: function() { CONFIG.enabled = false; log('Disabled'); },
        setProxyUrl: function(url) { CONFIG.proxyUrl = url; log('Proxy URL:', url); },
        setDebug: function(v) { CONFIG.debug = v; log('Debug:', v); }
    };
    log('Augment Proxy v5.0 ready!');
})();
/* AUGMENT_PROXY_INJECTION_END */

