// ===== AUGMENT CUSTOM MODEL INJECTION v4.0 =====
// Injected at: __TIMESTAMP__
// Proxy URL: __PROXY_URL__
(function() {
    "use strict";

    // ===== CONFIG =====
    const CONFIG = {
        enabled: true,
        proxyUrl: '__PROXY_URL__',
        debug: true,
        routeAllRequests: true
    };

    // Expose to global for debugging
    globalThis.__AUGMENT_PROXY__ = {
        CONFIG,
        enable: () => { CONFIG.enabled = true; console.log('[Augment-Proxy] Enabled'); },
        disable: () => { CONFIG.enabled = false; console.log('[Augment-Proxy] Disabled'); },
        setProxyUrl: (url) => { CONFIG.proxyUrl = url; console.log('[Augment-Proxy] Proxy URL:', url); },
        status: () => console.log('[Augment-Proxy] Status:', CONFIG)
    };

    const log = (...args) => { if (CONFIG.debug) console.log('[Augment-Proxy]', ...args); };
    log('Injection loaded');
    log('Proxy URL:', CONFIG.proxyUrl);

    // ===== Mock PluginState =====
    const mockPluginState = {
        authenticated: true,
        hasValidSubscription: true,
        isLoggedIn: true,
        subscriptionType: 'pro',
        userId: 'proxy-user',
        email: 'proxy@augmentcode.com',
        planName: 'Pro',
        features: { chat: true, completion: true, instruction: true, agentMode: true },
        modelConfig: { internalName: 'proxy-model', displayName: 'Proxy Model' },
        getValue: (k, d) => d,
        setValue: () => true,
        getUser: () => ({ id: 'proxy-user', email: 'proxy@augmentcode.com' }),
        getSubscription: () => ({ plan: 'Pro', valid: true }),
        isAuthenticated: () => true,
        hasFeature: () => true,
        onDidChange: () => ({ dispose: () => {} })
    };
    globalThis.__AUGMENT_MOCK_STATE__ = mockPluginState;

    // Hook Object.defineProperty
    const originalDefineProperty = Object.defineProperty;
    Object.defineProperty = function(obj, prop, descriptor) {
        if (prop === '_instance' && descriptor && descriptor.value === void 0) {
            log('Intercepted _instance definition');
        }
        return originalDefineProperty.call(this, obj, prop, descriptor);
    };

    // Delayed PluginState mock injection
    setTimeout(() => {
        log('Attempting to patch PluginState singleton...');
        try {
            for (const key in globalThis) {
                try {
                    const obj = globalThis[key];
                    if (obj && typeof obj === 'object' && typeof obj.getStateForSidecar === 'function') {
                        log('Found PluginState singleton:', key);
                        if (obj._instance === void 0) {
                            obj._instance = mockPluginState;
                            log('PluginState mock injected successfully!');
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {
            log('Error patching PluginState:', e.message);
        }
    }, 500);

    // ===== Core: Intercept fetch requests =====
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function(url, options = {}) {
        if (!CONFIG.enabled) return originalFetch.call(this, url, options);

        const urlStr = typeof url === 'string' ? url : url.toString();
        const isAugmentApi = urlStr.includes('augmentcode.com');
        if (!isAugmentApi) return originalFetch.call(this, url, options);

        let endpoint = null;
        if (urlStr.includes('/chat-stream')) endpoint = '/chat-stream';
        else if (urlStr.includes('/chat-input-completion')) endpoint = '/chat-input-completion';
        else if (urlStr.includes('/chat')) endpoint = '/chat';
        else if (urlStr.includes('/instruction-stream')) endpoint = '/instruction-stream';
        else if (urlStr.includes('/smart-paste-stream')) endpoint = '/smart-paste-stream';
        else if (urlStr.includes('/completion')) endpoint = '/completion';
        else if (urlStr.includes('/getPluginState')) endpoint = '/getPluginState';
        else if (urlStr.includes('/get-model-config')) endpoint = '/get-model-config';
        else if (urlStr.includes('/get-models')) endpoint = '/get-models';
        else if (urlStr.includes('/remote-agents/list-stream')) endpoint = '/remote-agents/list-stream';
        else if (urlStr.includes('/subscription-banner')) endpoint = '/subscription-banner';
        else if (urlStr.includes('/save-chat')) endpoint = '/save-chat';
        else if (urlStr.includes('/user-secrets/list')) endpoint = '/user-secrets/list';
        else if (urlStr.includes('/user-secrets/upsert')) endpoint = '/user-secrets/upsert';
        else if (urlStr.includes('/user-secrets/delete')) endpoint = '/user-secrets/delete';
        else if (urlStr.includes('/notifications/mark-read')) endpoint = '/notifications/mark-read';
        else if (urlStr.includes('/notifications')) endpoint = '/notifications';
        else if (urlStr.includes('/client-completion-timelines')) endpoint = '/client-completion-timelines';
        else if (urlStr.includes('/record-session-events')) endpoint = '/record-session-events';
        else if (urlStr.includes('/report-error')) endpoint = '/report-error';

        if (!endpoint) {
            log('Passing through (no matching endpoint):', urlStr);
            return originalFetch.call(this, url, options);
        }

        const proxyTargetUrl = CONFIG.proxyUrl + endpoint;
        log('=== Intercepted Augment API request ===');
        log('Original URL:', urlStr);
        log('Routing to:', proxyTargetUrl);

        try {
            const newHeaders = {};
            if (options.headers) {
                const entries = options.headers.entries ? [...options.headers.entries()] : Object.entries(options.headers);
                for (const [key, value] of entries) {
                    if (key.toLowerCase() === 'content-type') newHeaders[key] = value;
                }
            }
            newHeaders['Content-Type'] = 'application/json';

            const proxyResponse = await originalFetch.call(this, proxyTargetUrl, {
                method: options.method || 'POST',
                headers: newHeaders,
                body: options.body
            });
            log('Proxy response status:', proxyResponse.status);
            return proxyResponse;
        } catch (error) {
            log('Proxy error:', error.message);
            log('Falling back to original Augment API');
            return originalFetch.call(this, url, options);
        }
    };

    // ===== Intercept HTTP module (Node.js) =====
    try {
        const http = require('http');
        const https = require('https');

        const getEndpoint = (url) => {
            if (url.includes('/chat-stream')) return '/chat-stream';
            if (url.includes('/chat-input-completion')) return '/chat-input-completion';
            if (url.includes('/chat')) return '/chat';
            if (url.includes('/instruction-stream')) return '/instruction-stream';
            if (url.includes('/smart-paste-stream')) return '/smart-paste-stream';
            if (url.includes('/completion')) return '/completion';
            if (url.includes('/getPluginState')) return '/getPluginState';
            if (url.includes('/get-model-config')) return '/get-model-config';
            if (url.includes('/get-models')) return '/get-models';
            if (url.includes('/remote-agents/list-stream')) return '/remote-agents/list-stream';
            if (url.includes('/subscription-banner')) return '/subscription-banner';
            if (url.includes('/save-chat')) return '/save-chat';
            if (url.includes('/user-secrets/list')) return '/user-secrets/list';
            if (url.includes('/user-secrets/upsert')) return '/user-secrets/upsert';
            if (url.includes('/user-secrets/delete')) return '/user-secrets/delete';
            if (url.includes('/notifications/mark-read')) return '/notifications/mark-read';
            if (url.includes('/notifications')) return '/notifications';
            if (url.includes('/client-completion-timelines')) return '/client-completion-timelines';
            if (url.includes('/record-session-events')) return '/record-session-events';
            if (url.includes('/report-error')) return '/report-error';
            return null;
        };

        const wrapRequest = (originalRequest, protocol) => {
            return function(urlOrOptions, options, callback) {
                let targetUrl = '';
                if (typeof urlOrOptions === 'string') {
                    targetUrl = urlOrOptions;
                } else if (urlOrOptions && urlOrOptions.hostname) {
                    targetUrl = protocol + '://' + urlOrOptions.hostname + (urlOrOptions.path || '');
                }

                const isAugmentApi = targetUrl.includes('augmentcode.com');
                const endpoint = isAugmentApi ? getEndpoint(targetUrl) : null;

                if (CONFIG.enabled && endpoint) {
                    log('[HTTP] Intercepted:', targetUrl);
                    const proxyHost = new URL(CONFIG.proxyUrl);
                    if (typeof urlOrOptions === 'object') {
                        urlOrOptions.hostname = proxyHost.hostname;
                        urlOrOptions.host = proxyHost.host;
                        urlOrOptions.port = proxyHost.port || 8765;
                        urlOrOptions.path = endpoint;
                        urlOrOptions.protocol = 'http:';
                        log('[HTTP] Routing to:', proxyHost.hostname + ':' + urlOrOptions.port + endpoint);
                    }
                } else if (isAugmentApi) {
                    log('[HTTP] Passing through:', targetUrl);
                }

                return originalRequest.call(this, urlOrOptions, options, callback);
            };
        };

        http.request = wrapRequest(http.request, 'http');
        https.request = wrapRequest(https.request, 'https');
        log('HTTP/HTTPS request interception enabled');
    } catch (e) {
        log('HTTP interception not available (expected in browser context)');
    }

    // ===== Startup log =====
    log('='.repeat(50));
    log('Augment Proxy Injection v4.0 loaded!');
    log('Proxy URL:', CONFIG.proxyUrl);
    log('Enabled:', CONFIG.enabled);
    log('');
    log('Control in DevTools console:');
    log('  __AUGMENT_PROXY__.status()');
    log('  __AUGMENT_PROXY__.enable()');
    log('  __AUGMENT_PROXY__.disable()');
    log('  __AUGMENT_PROXY__.setProxyUrl("http://localhost:8765")');
    log('='.repeat(50));
})();
// ===== END AUGMENT PROXY INJECTION =====

