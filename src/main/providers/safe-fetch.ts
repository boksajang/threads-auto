import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) !== 4) return false;
  const [a, b] = normalized.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function validatePublicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('RSS 주소는 인증정보가 없는 HTTP 또는 HTTPS URL이어야 합니다.');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error('로컬 네트워크 주소는 RSS로 사용할 수 없습니다.');
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error('사설 또는 로컬 네트워크 주소는 RSS로 사용할 수 없습니다.');
  return url;
}

export async function fetchPublicText(value: string, maxBytes = 2_000_000): Promise<string> {
  let current = value;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const url = await validatePublicUrl(current);
    const addresses = isIP(url.hostname) ? [{ address: url.hostname, family: isIP(url.hostname) }] : await lookup(url.hostname, { all: true, verbatim: true });
    const pinned = addresses[0];
    const response = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(url, {
        method: 'GET', headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9' },
        lookup: (_hostname, options, callback: any) => {
          const address = { address: pinned.address, family: pinned.family as 4 | 6 };
          if (typeof options === 'object' && options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      }, (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) { incoming.resume(); resolve({ status, headers: incoming.headers, body: '' }); return; }
        const declared = Number(incoming.headers['content-length'] ?? 0);
        if (declared > maxBytes) { incoming.destroy(); reject(new Error('RSS 응답 크기 제한을 초과했습니다.')); return; }
        const chunks: Buffer[] = []; let received = 0;
        incoming.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) { incoming.destroy(new Error('RSS 응답 크기 제한을 초과했습니다.')); return; }
          chunks.push(chunk);
        });
        incoming.on('end', () => resolve({ status, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }));
        incoming.on('error', reject);
      });
      request.setTimeout(12_000, () => request.destroy(new Error('RSS 요청 시간이 초과되었습니다.')));
      request.on('error', reject);
      request.end();
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location || redirect === 3) throw new Error('RSS Redirect가 너무 많거나 올바르지 않습니다.');
      current = new URL(location, url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`RSS 요청 실패 (${response.status})`);
    return response.body;
  }
  throw new Error('RSS를 가져오지 못했습니다.');
}
