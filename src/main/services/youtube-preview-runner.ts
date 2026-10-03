import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeImage } from 'electron';
import { CodexRateLimitClient } from '../codex/rate-limits';
import { CodexRunner, type AgentInvocation, type AgentInvocationResult } from '../codex/runner';
import { AppDatabase } from '../db/database';
import { Repositories } from '../db/repositories';
import type { CoupangProvider, ThreadsProvider } from '../providers/contracts';
import { ProviderRegistry } from '../providers/contracts';
import { YouTubeProvider } from '../providers/youtube';
import { AutomationPipeline } from './pipeline';
import { CredentialManager, SettingsManager } from './settings';

class TracingCodexRunner extends CodexRunner {
  constructor(workDirectory: string, dataDirectory: string, private readonly repositories: Repositories) {
    super(workDirectory, dataDirectory);
  }

  override async run(invocation: AgentInvocation): Promise<AgentInvocationResult> {
    const result = await super.run(invocation);
    this.repositories.addLog(
      'INFO',
      'AGENT_TRACE',
      `${invocation.role} Agent 완료: ${result.result.decision}`,
      `tokens=${result.totalTokens ?? 'unknown'}`,
    );
    return result;
  }
}

function safeTimestamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

export async function runYouTubePreview(userDataPath: string, projectPath: string): Promise<string> {
  const outputDirectory = path.join(projectPath, 'test-artifacts', `youtube-preview-${safeTimestamp()}`);
  await mkdir(outputDirectory, { recursive: true });
  const database = new AppDatabase(path.join(userDataPath, 'threads-auto.db'));
  const repositories = new Repositories(database);
  const settings = new SettingsManager(userDataPath);
  const credentials = new CredentialManager(userDataPath);
  const youtube = new YouTubeProvider(credentials);
  const originalFetch = globalThis.fetch;
  let threadsProviderCalls = 0;
  const blockedThreads = async () => {
    threadsProviderCalls += 1;
    throw new Error('미게시 Preview에서 Threads Provider 호출이 차단되었습니다.');
  };
  const blockedExternal = async () => { throw new Error('미게시 Preview에서 불필요한 외부 Provider 호출이 차단되었습니다.'); };
  const threads = {
    test: blockedThreads,
    publish: blockedThreads,
    comments: blockedThreads,
    reply: blockedThreads,
    insights: blockedThreads,
  } as unknown as ThreadsProvider;
  const coupang = {
    test: blockedExternal,
    search: blockedExternal,
    deepLink: blockedExternal,
    performance: blockedExternal,
  } as unknown as CoupangProvider;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl);
    const allowed = url.hostname === 'www.googleapis.com' || url.hostname === 'i.ytimg.com' || url.hostname === 'yt3.ggpht.com';
    if (!allowed) throw new Error(`미게시 Preview에서 허용되지 않은 외부 요청을 차단했습니다: ${url.hostname}`);
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const account = repositories.listAccounts().find((candidate) =>
      candidate.active && repositories.listProviderConfigs(candidate.id).some((config) => config.type === 'YOUTUBE' && config.enabled),
    );
    if (!account) throw new Error('활성화된 YouTube 설정을 가진 테스트 계정이 없습니다.');
    const providerConfig = repositories.listProviderConfigs(account.id).find((config) => config.type === 'YOUTUBE' && config.enabled);
    if (!providerConfig) throw new Error('YouTube Provider 설정을 찾을 수 없습니다.');
    const credentialStatus = await credentials.status([`youtubeApiKey:${account.id}`]);
    if (!credentialStatus[`youtubeApiKey:${account.id}`]?.stored) {
      throw new Error('선택 계정에 YouTube API 키가 저장되지 않았습니다.');
    }

    repositories.addLog('INFO', 'LIVE_TEST', 'YouTube 자료 기반 미게시 본문 생성 테스트를 시작했습니다.', undefined, account.id);
    const discovered = await youtube.discover(account, providerConfig.config);
    const recent = [...discovered].reverse();
    const unprocessed = recent.filter((candidate) => !repositories.hasExactSource(account.id, 'YOUTUBE', candidate.sourceKey));
    const candidates = [
      ...unprocessed.filter((candidate) => candidate.metadata?.format === 'LONG_FORM'),
      ...unprocessed.filter((candidate) => candidate.metadata?.format !== 'LONG_FORM'),
    ];
    if (!candidates.length) throw new Error('새로 처리할 YouTube 영상이 없습니다.');

    const codex = new TracingCodexRunner(path.join(userDataPath, 'agent-work'), userDataPath, repositories);
    await codex.initialize();
    const usage = new CodexRateLimitClient(await codex.executablePath());
    const pipeline = new AutomationPipeline(repositories, settings, codex, usage, new ProviderRegistry(), threads, coupang);
    const previewAccount = { ...account, dailyEnabled: false, promotionEnabled: true, automationTarget: false };
    const startedAt = new Date().toISOString();
    let selected = candidates[0];
    let post;
    for (const candidate of candidates.slice(0, 3)) {
      selected = candidate;
      repositories.addLog('INFO', 'YOUTUBE', `YouTube 참고 영상을 선택했습니다: ${candidate.title}`, candidate.sourceUrl, account.id);
      post = await pipeline.preview(previewAccount, candidate);
      if (post) break;
    }
    if (!post) throw new Error('최근 YouTube 후보 3개가 품질 검수를 통과하지 못해 미게시 본문이 생성되지 않았습니다.');
    if (!selected.imageUrl) throw new Error('선택한 YouTube 영상에 썸네일 URL이 없습니다.');

    const thumbnailResponse = await originalFetch(selected.imageUrl, { signal: AbortSignal.timeout(15_000) });
    if (!thumbnailResponse.ok) throw new Error(`YouTube 썸네일 조회 실패 (${thumbnailResponse.status})`);
    const contentType = thumbnailResponse.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) throw new Error(`YouTube 썸네일 응답이 이미지가 아닙니다: ${contentType || 'unknown'}`);
    const thumbnailBuffer = Buffer.from(await thumbnailResponse.arrayBuffer());
    if (!thumbnailBuffer.length || thumbnailBuffer.length > 10_000_000) throw new Error('YouTube 썸네일 파일 크기가 허용 범위를 벗어났습니다.');
    const decodedImage = nativeImage.createFromBuffer(thumbnailBuffer);
    if (decodedImage.isEmpty()) throw new Error('YouTube 썸네일 이미지를 디코딩하지 못했습니다.');
    const thumbnailPath = path.join(outputDirectory, 'thumbnail.jpg');
    await writeFile(thumbnailPath, thumbnailBuffer);

    const postRow = database.raw.prepare('SELECT * FROM posts WHERE id=?').get(post.id) as Record<string, unknown> | undefined;
    const sourceRow = database.raw.prepare('SELECT * FROM sources WHERE id=?').get(selected.id) as Record<string, unknown> | undefined;
    const logs = repositories.recentLogs(200).filter((log) => log.accountId === account.id && log.createdAt >= startedAt);
    const integrity = database.raw.pragma('integrity_check', { simple: true });
    const foreignKeyErrors = database.raw.pragma('foreign_key_check') as unknown[];
    const checks = {
      threadsProviderCalls,
      noRemotePublish: threadsProviderCalls === 0 && !post.threadsPostId && !post.publishedAt,
      postStored: Boolean(postRow),
      sourceStored: Boolean(sourceRow),
      sourceDoneWithoutThreadsId: sourceRow?.status === 'DONE' && sourceRow?.threads_post_id == null,
      postUnpublished: postRow?.threads_post_id == null && postRow?.published_at == null,
      bodyMatchesDatabase: postRow?.body === post.body,
      sourceUrlIncluded: post.body.includes(selected.sourceUrl),
      thumbnailMatchesDatabase: postRow?.image_url === selected.imageUrl,
      qualityReviewPassed: logs.some((log) => log.category === 'QUALITY' && log.message.startsWith('검토·수정 Agent 품질 통과')),
      qualityOrchestratorPassed: logs.some((log) => log.category === 'QUALITY' && log.message.startsWith('총괄 Agent 최종 품질 승인')),
      previewLogged: logs.some((log) => log.category === 'PREVIEW'),
      publishLogCount: logs.filter((log) => log.category === 'PUBLISH').length,
      databaseIntegrity: integrity,
      foreignKeyErrorCount: foreignKeyErrors.length,
    };
    const allChecksPassed = checks.threadsProviderCalls === 0
      && checks.noRemotePublish
      && checks.postStored
      && checks.sourceStored
      && checks.sourceDoneWithoutThreadsId
      && checks.postUnpublished
      && checks.bodyMatchesDatabase
      && checks.sourceUrlIncluded
      && checks.thumbnailMatchesDatabase
      && checks.qualityReviewPassed
      && checks.qualityOrchestratorPassed
      && checks.previewLogged
      && checks.publishLogCount === 0
      && checks.databaseIntegrity === 'ok'
      && checks.foreignKeyErrorCount === 0;
    if (!allChecksPassed) {
      throw new Error(`미게시 Preview 검증에 실패했습니다: ${JSON.stringify(checks)}`);
    }

    const size = decodedImage.getSize();
    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'YOUTUBE_NO_PUBLISH_PREVIEW',
      account: { id: account.id, name: account.name },
      youtubeSource: {
        title: selected.title,
        url: selected.sourceUrl,
        publishedAt: selected.publishedAt,
        format: selected.metadata?.format,
        durationSeconds: selected.metadata?.durationSeconds,
        descriptionPreview: (selected.summary ?? '').slice(0, 1_000),
      },
      thumbnail: {
        sourceUrl: selected.imageUrl,
        savedPath: thumbnailPath,
        httpStatus: thumbnailResponse.status,
        contentType,
        bytes: thumbnailBuffer.length,
        width: size.width,
        height: size.height,
        sha256: createHash('sha256').update(thumbnailBuffer).digest('hex'),
      },
      generatedPost: {
        body: post.body,
        characters: post.body.length,
        sourceType: post.sourceType,
        sourceUrl: post.url,
        imageUrl: post.imageUrl,
        threadsPostId: null,
        publishedAt: null,
      },
      qualityLogs: logs.filter((log) => log.category === 'TOPIC' || log.category === 'QUALITY').map((log) => ({
        category: log.category,
        message: log.message,
        detail: log.detail,
        createdAt: log.createdAt,
      })),
      checks,
      routineTokens: usage.current().routineTokens,
    };
    await writeFile(path.join(outputDirectory, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    await writeFile(path.join(outputDirectory, 'result.md'), [
      '# YouTube 기반 Threads 미게시 결과물', '',
      `- 생성 시각: ${report.generatedAt}`,
      `- 계정: ${account.name}`,
      '- Threads Provider 호출: 0회',
      '- 발행 상태: 미게시', '',
      '## 참고 영상', '',
      `- 제목: ${selected.title}`,
      `- URL: ${selected.sourceUrl}`,
      `- 게시일: ${selected.publishedAt ?? '확인 불가'}`,
      `- 형식: ${String(selected.metadata?.format ?? '확인 불가')}`,
      `- 재생 시간: ${String(selected.metadata?.durationSeconds ?? '확인 불가')}초`, '',
      '## 썸네일 검증', '',
      `- HTTP: ${thumbnailResponse.status}`,
      `- 형식: ${contentType}`,
      `- 크기: ${size.width}×${size.height}px / ${thumbnailBuffer.length} bytes`,
      `- 저장 파일: ${thumbnailPath}`, '',
      '## 생성 본문', '', post.body, '',
      `- 글자 수: ${post.body.length}자`, '',
      '## 검증', '',
      `- DB 무결성: ${integrity}`,
      `- 외래 키 오류: ${foreignKeyErrors.length}건`,
      '- posts 저장: 정상',
      '- sources DONE·Threads ID 없음: 정상',
      '- PUBLISH 로그: 0건',
      '- Threads API 호출: 0회', '',
      '## 품질 Agent 로그', '',
      ...report.qualityLogs.flatMap((log) => [`- ${log.message}`, log.detail ? `  - ${log.detail}` : '']),
    ].join('\n'), 'utf8');
    repositories.addLog('INFO', 'LIVE_TEST', `YouTube 미게시 결과물 테스트를 완료했습니다: ${outputDirectory}`, undefined, account.id);
    return outputDirectory;
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
}
