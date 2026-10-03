import { randomUUID } from 'node:crypto';
import Parser from 'rss-parser';
import type { Account, SourceCandidate } from '../../shared/domain';
import { POLICY } from '../../shared/policy';
import type { ConnectionResult, DiscoveryProvider } from './contracts';
import { fetchPublicText } from './safe-fetch';

export class BlogProvider implements DiscoveryProvider {
  readonly type = 'BLOG' as const;
  private readonly parser = new Parser();

  private feedUrl(input: string): string {
    const url = new URL(input);
    if (url.hostname === 'blog.naver.com') {
      const blogId = url.pathname.split('/').filter(Boolean)[0];
      if (blogId) return `https://rss.blog.naver.com/${encodeURIComponent(blogId)}.xml`;
    }
    return url.toString();
  }

  async test(_accountId: string, config: Record<string, unknown>): Promise<ConnectionResult> {
    try { await this.parser.parseString(await fetchPublicText(this.feedUrl(String(config.rssUrl ?? '')))); return { ok: true, message: 'Blog 연결에 성공했습니다.' }; }
    catch { return { ok: false, message: 'Blog RSS 연결 실패: 공개 RSS 주소를 확인하세요.' }; }
  }

  async discover(account: Account, config: Record<string, unknown>): Promise<SourceCandidate[]> {
    const feed = await this.parser.parseString(await fetchPublicText(this.feedUrl(String(config.rssUrl ?? ''))));
    const cutoff = Date.now() - POLICY.blogCandidateMaxAgeDays * 86_400_000;
    return feed.items.flatMap((item): SourceCandidate[] => {
      const publishedAt = item.isoDate ?? item.pubDate;
      if (publishedAt && new Date(publishedAt).getTime() < cutoff) return [];
      const sourceUrl = item.link ?? '';
      const sourceKey = item.guid ?? sourceUrl;
      if (!sourceKey) return [];
      return [{ id: randomUUID(), accountId: account.id, sourceType: 'BLOG', sourceKey, sourceUrl,
        publishedAt, title: item.title ?? '제목 없음', summary: item.contentSnippet ?? item.content ?? '', metadata: {} }];
    }).sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));
  }
}
