import { randomUUID } from 'node:crypto';
import type { Account, SourceCandidate } from '../../shared/domain';
import type { CredentialManager } from '../services/settings';
import type { ConnectionResult, DiscoveryProvider } from './contracts';
import { ProviderRequestError } from './contracts';

const API = 'https://www.googleapis.com/youtube/v3';

export type YouTubeFormat = 'SHORTS' | 'LONG_FORM' | 'UNKNOWN';

export function youtubeDurationSeconds(value?: string): number | undefined {
  const match = value?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : undefined;
}

export function youtubeFormatFromDuration(value?: string): YouTubeFormat {
  const seconds = youtubeDurationSeconds(value);
  if (seconds === undefined) return 'UNKNOWN';
  return seconds <= 180 ? 'SHORTS' : 'LONG_FORM';
}

export function youtubeFormatEnabled(config: Record<string, unknown>, format: unknown): boolean {
  const includeLongForm = config.includeLongForm !== false;
  const includeShorts = config.includeShorts !== false;
  if (format === 'SHORTS') return includeShorts;
  if (format === 'LONG_FORM') return includeLongForm;
  // API가 길이를 돌려주지 않아 분류할 수 없는 영상은 한쪽만 선택한 계정에 잘못 발행하지 않는다.
  return includeLongForm && includeShorts;
}

export class YouTubeProvider implements DiscoveryProvider {
  readonly type = 'YOUTUBE' as const;
  constructor(private readonly credentials: CredentialManager) {}

  private async key(accountId: string): Promise<string> {
    const key = await this.credentials.get(`youtubeApiKey:${accountId}`);
    if (!key) throw new Error('YouTube Data API Key가 저장되지 않았습니다.');
    return key;
  }

  private async get(accountId: string, path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`${API}/${path}`);
    Object.entries({ ...params, key: await this.key(accountId) }).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 4_000_000) throw new Error('YouTube API 응답 크기 제한을 초과했습니다.');
    const body = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    if (!response.ok) throw new ProviderRequestError(`YouTube API 요청 실패 (${body?.error?.errors?.[0]?.reason ?? response.status})`, response.status === 429 || response.status >= 500, Number(response.headers.get('retry-after') ?? 0) * 1000 || undefined, response.status);
    return body;
  }

  async test(accountId: string, config: Record<string, unknown>): Promise<ConnectionResult> {
    try { await this.resolveChannel(accountId, String(config.channel ?? '')); return { ok: true, message: 'YouTube API 연결에 성공했습니다.' }; }
    catch { return { ok: false, message: 'YouTube 조회 실패: API 키와 채널 정보를 확인하세요.' }; }
  }

  async resolveChannel(accountId: string, input: string): Promise<any> {
    const directId = input.match(/UC[\w-]{20,}/)?.[0];
    const handleFromUrl = input.match(/@([^/?#]+)/u)?.[1];
    const handle = handleFromUrl
      ? decodeURIComponent(handleFromUrl)
      : input.startsWith('@') ? input.slice(1) : undefined;
    const params: Record<string, string> = directId
      ? { part: 'contentDetails,snippet', id: directId }
      : { part: 'contentDetails,snippet', forHandle: handle ?? input };
    const data = await this.get(accountId, 'channels', params);
    if (!data.items?.[0]) throw new Error('YouTube 채널을 찾을 수 없습니다.');
    return data.items[0];
  }

  async discover(account: Account, config: Record<string, unknown>): Promise<SourceCandidate[]> {
    const channel = await this.resolveChannel(account.id, String(config.channel ?? ''));
    const playlistId = channel.contentDetails.relatedPlaylists.uploads;
    const items: any[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const data = await this.get(account.id, 'playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
      items.push(...(data.items ?? []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    const videoIds = items.map((item: any) => item.contentDetails.videoId).filter(Boolean);
    const details = new Map<string, any>();
    for (let offset = 0; offset < videoIds.length; offset += 50) {
      const data = await this.get(account.id, 'videos', { part: 'contentDetails', id: videoIds.slice(offset, offset + 50).join(',') });
      for (const item of data.items ?? []) details.set(item.id, item.contentDetails);
    }
    return items.map((item: any) => {
      const videoId = item.contentDetails.videoId;
      const duration = details.get(videoId)?.duration;
      const seconds = youtubeDurationSeconds(duration);
      const format = youtubeFormatFromDuration(duration);
      return {
        id: randomUUID(), accountId: account.id, sourceType: 'YOUTUBE' as const, sourceKey: videoId,
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, publishedAt: item.contentDetails.videoPublishedAt ?? item.snippet.publishedAt,
        title: item.snippet.title, summary: item.snippet.description,
        imageUrl: item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url,
        metadata: { channelId: channel.id, durationSeconds: seconds, format },
      };
    }).filter((candidate: SourceCandidate) => youtubeFormatEnabled(config, candidate.metadata?.format))
      .sort((a: SourceCandidate, b: SourceCandidate) => String(a.publishedAt).localeCompare(String(b.publishedAt)));
  }
}
