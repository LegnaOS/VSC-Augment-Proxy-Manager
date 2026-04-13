// ===== Outbound Proxy Support =====
// Inspired by LegnaCode's proxy.ts — HTTP/HTTPS proxy for outbound API requests
// Supports HTTP_PROXY/HTTPS_PROXY/NO_PROXY environment variables and CONNECT tunneling

import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import { URL } from 'url';
import { log } from './globals';

// ===== Proxy URL Resolution =====

/**
 * Get the active proxy URL from environment variables.
 * Prefers lowercase variants (https_proxy > HTTPS_PROXY > http_proxy > HTTP_PROXY).
 */
export function getProxyUrl(): string | undefined {
    return process.env.https_proxy || process.env.HTTPS_PROXY
        || process.env.http_proxy || process.env.HTTP_PROXY;
}

/**
 * Get the NO_PROXY value from environment variables.
 * Prefers lowercase (no_proxy > NO_PROXY).
 */
export function getNoProxy(): string | undefined {
    return process.env.no_proxy || process.env.NO_PROXY;
}

/**
 * Check if a URL should bypass the proxy based on NO_PROXY patterns.
 * Supports: exact hostname, domain suffix (.example.com), wildcard (*), port-specific (host:port).
 */
export function shouldBypassProxy(urlString: string): boolean {
    const noProxy = getNoProxy();
    if (!noProxy) return false;
    if (noProxy === '*') return true;
    try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        const hostWithPort = `${hostname}:${port}`;
        return noProxy.split(/[,\s]+/).filter(Boolean).some(pattern => {
            pattern = pattern.toLowerCase().trim();
            if (pattern.includes(':')) return hostWithPort === pattern;
            if (pattern.startsWith('.')) {
                return hostname === pattern.substring(1) || hostname.endsWith(pattern);
            }
            return hostname === pattern;
        });
    } catch {
        return false;
    }
}
// ===== CONNECT Tunnel =====

/**
 * Create a TCP tunnel through an HTTP proxy using the CONNECT method.
 * Returns a TLS socket connected to the target through the proxy.
 */
function connectThroughProxy(proxyUrl: string, targetHost: string, targetPort: number): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
        const proxy = new URL(proxyUrl);
        const proxyPort = parseInt(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
        const headers: Record<string, string> = {
            Host: `${targetHost}:${targetPort}`,
        };
        // Proxy authentication (Basic)
        if (proxy.username) {
            headers['Proxy-Authorization'] = `Basic ${Buffer.from(
                `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`
            ).toString('base64')}`;
        }

        const connectReq = http.request({
            host: proxy.hostname,
            port: proxyPort,
            method: 'CONNECT',
            path: `${targetHost}:${targetPort}`,
            headers,
        });

        connectReq.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`Proxy CONNECT failed: ${res.statusCode} ${res.statusMessage}`));
                return;
            }
            // Upgrade the raw TCP socket to TLS
            const tlsSocket = tls.connect({
                socket: socket as any,
                host: targetHost,
                servername: targetHost,
            }, () => {
                resolve(tlsSocket);
            });
            tlsSocket.on('error', (err) => {
                socket.destroy();
                reject(err);
            });
        });

        connectReq.on('error', reject);
        connectReq.setTimeout(30000, () => {
            connectReq.destroy(new Error('Proxy CONNECT timeout'));
        });
        connectReq.end();
    });
}

// ===== Proxy-Aware HTTPS Request =====

/**
 * Drop-in replacement for https.request / http.request that automatically
 * tunnels through an HTTP proxy if HTTPS_PROXY is configured.
 *
 * Usage:
 *   const req = await createProxiedRequest(fullUrl, { method, headers }, callback);
 *   req.write(body);
 *   req.end();
 */
export async function createProxiedRequest(
    targetUrl: string,
    options: https.RequestOptions,
    callback: (res: http.IncomingMessage) => void
): Promise<http.ClientRequest> {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const proxyUrl = getProxyUrl();

    if (proxyUrl && !shouldBypassProxy(targetUrl) && isHttps) {
        const targetHost = url.hostname;
        const targetPort = parseInt(url.port) || 443;
        log(`[PROXY] Tunneling ${targetHost}:${targetPort} via ${new URL(proxyUrl).hostname}`);

        const tlsSocket = await connectThroughProxy(proxyUrl, targetHost, targetPort);

        return https.request({
            ...options,
            hostname: targetHost,
            port: targetPort,
            path: url.pathname + (url.search || ''),
            agent: false,
            createConnection: () => tlsSocket,
        }, callback);
    }

    // Direct connection (no proxy or bypass)
    const mod = isHttps ? https : http;
    return mod.request({
        ...options,
        hostname: url.hostname,
        port: parseInt(url.port as string) || (isHttps ? 443 : 80),
        path: url.pathname + (url.search || ''),
    }, callback);
}

// ===== Request Correlation =====

let requestCounter = 0;

/** Generate a short correlation ID for request tracing. */
export function generateRequestId(): string {
    return `req-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
}

// ===== Transient Error Retry (Anthropic) =====

/** Check if an HTTP status code indicates a transient upstream failure. */
export function isTransientStatusCode(statusCode: number | undefined): boolean {
    return [502, 503, 504].includes(statusCode || 0);
}

/** Check if an error is a transient transport failure (timeout, reset, etc.). */
export function isTransientTransportError(error: any): boolean {
    const msg = String(error?.message || error || '').toLowerCase();
    return msg.includes('timeout')
        || msg.includes('socket hang up')
        || msg.includes('econnreset')
        || msg.includes('econnrefused')
        || msg.includes('etimedout')
        || msg.includes('ehostunreach');
}

// ===== Startup Logging =====

/** Log the current outbound proxy configuration. */
export function logProxyStatus(): void {
    const proxyUrl = getProxyUrl();
    const noProxy = getNoProxy();
    if (proxyUrl) {
        log(`[PROXY] Outbound proxy: ${proxyUrl}`);
        if (noProxy) {
            log(`[PROXY] NO_PROXY: ${noProxy}`);
        }
    } else {
        log(`[PROXY] No outbound proxy configured`);
    }
}
