import { HttpsProxyAgent } from 'https-proxy-agent';

let agent;
export function proxyAgent(url) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy || !/^wss?:|^https:/.test(url)) return undefined;
  const host = new URL(url).hostname;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (noProxy.some((n) => host === n || host.endsWith(n.replace(/^\*/, '')))) return undefined;
  agent ??= new HttpsProxyAgent(proxy);
  return agent;
}
