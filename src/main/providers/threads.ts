import type { ThreadsPostSummary, ThreadsProfile, ThreadsTokenDebugResult } from '../../shared/domain';
import type { CredentialManager } from '../services/settings';
import { InvalidThreadsTokenError, ProviderRequestError, TokenInspectionUnavailableError, UncertainRemoteOperationError, type ConnectionResult, type InsightValues, type PublishInput, type PublishResult, type RemoteComment, type ThreadsProvider, type ThreadsTokenRefreshResult } from './contracts';

const API_HOST = 'https://graph.threads.net';
const BASE_URL = API_HOST;
const PROFILE_URL = 'https://graph.threads.net/me?fields=id,username,name';
const POST_FIELDS = 'id,owner,username,text,permalink,timestamp,has_replies';
const POST_DETAIL_FIELDS = `${POST_FIELDS},media_product_type,media_type,is_reply,is_reply_owned_by_me,root_post,replied_to`;
const REPLY_FIELDS = `${POST_DETAIL_FIELDS},shortcode,has_replies`;
const MAX_CAROUSEL_ITEMS = 20;
const REMOTE_CONTAINER_SETTLE_MS = 2_500;
const CAROUSEL_CHILD_STATUS_INTERVAL_MS = 2_500;
const CAROUSEL_CHILD_STATUS_MAX_ATTEMPTS = 12;

interface ThreadsRequestContext {
  operation: string;
}

interface CarouselChildContainer {
  id: string;
  index: number;
  imageUrl: string;
}

const remoteUrlLabel = (value: string): string => {
  try {
    const url = new URL(value);
    const extension = /\.[a-z0-9]+$/i.exec(url.pathname)?.[0]?.toLowerCase() ?? '확장자 없음';
    return `${url.hostname}, ${extension}`;
  } catch {
    return '주소 형식 오류';
  }
};

const publishImageUrls = (input: PublishInput): string[] => {
  const values = input.imageUrls?.length ? input.imageUrls : input.imageUrl ? [input.imageUrl] : [];
  if (values.length > MAX_CAROUSEL_ITEMS) {
    throw new Error(`Threads 이미지는 최대 ${MAX_CAROUSEL_ITEMS}장까지 발행할 수 있습니다.`);
  }
  if (values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('Threads 이미지 주소를 확인할 수 없습니다.');
  }
  return values.map((value) => value.trim());
};

const epochIso = (value: unknown): string | undefined => {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) return undefined;
  const milliseconds = seconds * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds > 8_640_000_000_000_000) return undefined;
  return new Date(milliseconds).toISOString();
};

const safeApiMessage = (value:unknown, token:string):string|undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value
    .replaceAll(token, '[REDACTED]')
    .replaceAll(encodeURIComponent(token), '[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 240);
};

const postSummary = (value: any): ThreadsPostSummary => ({
  id:String(value?.id ?? ''),
  ownerId:typeof value?.owner?.id === 'string' || typeof value?.owner?.id === 'number' ? String(value.owner.id) : undefined,
  username:typeof value?.username === 'string' ? value.username : undefined,
  text:typeof value?.text === 'string' ? value.text : undefined,
  permalink:typeof value?.permalink === 'string' ? value.permalink : undefined,
  timestamp:typeof value?.timestamp === 'string' ? value.timestamp : undefined,
  mediaProductType:typeof value?.media_product_type === 'string' ? value.media_product_type : undefined,
  mediaType:typeof value?.media_type === 'string' ? value.media_type : undefined,
  isReply:typeof value?.is_reply === 'boolean' ? value.is_reply : undefined,
  isReplyOwnedByMe:typeof value?.is_reply_owned_by_me === 'boolean' ? value.is_reply_owned_by_me : undefined,
  hasReplies:typeof value?.has_replies === 'boolean' ? value.has_replies : undefined,
  rootPostId:typeof value?.root_post?.id === 'string' || typeof value?.root_post?.id === 'number' ? String(value.root_post.id) : undefined,
  repliedToId:typeof value?.replied_to?.id === 'string' || typeof value?.replied_to?.id === 'number' ? String(value.replied_to.id) : undefined,
});

type SafeOperation = '게시물 조회' | '답글 조회' | '답글 작성' | '게시물 삭제';

const safeOperationError = (operation: SafeOperation, error: unknown): Error => {
  if (error instanceof UncertainRemoteOperationError) return error;
  if (error instanceof ProviderRequestError) {
    if ([401, 403].includes(error.status ?? 0) || /\bcode 10\b/i.test(error.message)) {
      return new Error(`Threads ${operation} 권한이 없습니다. Access Token 권한을 확인하세요.`, { cause:error });
    }
    if (error.status === 404) {
      return new Error(`Threads ${operation} 대상을 찾을 수 없습니다. 게시물 ID와 삭제 여부를 확인하세요.`, { cause:error });
    }
    if (error.status === 429) {
      return new Error(`Threads ${operation} 요청이 너무 많습니다. 잠시 후 다시 시도하세요.`, { cause:error });
    }
    if ((error.status ?? 0) >= 500) {
      return new Error(`Threads 서비스 오류로 ${operation} 작업을 완료하지 못했습니다. 잠시 후 다시 시도하세요.`, { cause:error });
    }
    return new Error(`Threads ${operation} 요청을 완료하지 못했습니다. 입력값과 계정 상태를 확인하세요.`, { cause:error });
  }
  return new Error(`Threads 서비스에 연결할 수 없어 ${operation}을 완료하지 못했습니다. 인터넷 연결을 확인하세요.`, { cause:error });
};

export class MetaThreadsProvider implements ThreadsProvider {
  constructor(
    private readonly credentials: CredentialManager,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly pause: (milliseconds: number) => Promise<void> = async () => undefined,
  ) {}

  private async waitForContainerConsistency(): Promise<void> {
    await this.pause(REMOTE_CONTAINER_SETTLE_MS);
  }

  private async waitForCarouselChildren(token: string, children: CarouselChildContainer[]): Promise<void> {
    let pending = [...children];
    // ID 발급 직후에는 마지막 이미지가 아직 원격 처리 대기 상태일 수 있다.
    // Meta가 공개한 컨테이너 상태 API로 실제 준비 완료를 확인한 뒤 부모를 만든다.
    await this.pause(CAROUSEL_CHILD_STATUS_INTERVAL_MS);
    for (let attempt = 1; attempt <= CAROUSEL_CHILD_STATUS_MAX_ATTEMPTS; attempt += 1) {
      const next: CarouselChildContainer[] = [];
      for (const child of pending) {
        const operation = `캐러셀 이미지 ${child.index + 1}/${children.length} 처리 상태 (${remoteUrlLabel(child.imageUrl)})`;
        let result: any;
        try {
          result = await this.request(
            `/${encodeURIComponent(child.id)}?fields=id,status,error_message`,
            token,
            { method:'GET' },
            { operation },
          );
        } catch (error) {
          // 새 컨테이너 ID 자체가 Graph 조회 계층에 전파되기 전에는 Meta가
          // 일시적으로 media/child not found를 반환할 수 있다. 우리가 방금
          // 만든 ID에 한해서만 준비 중으로 취급하고 제한 횟수 안에서 재확인한다.
          if (error instanceof ProviderRequestError && /\bsubcode (4279004|4279009)\b/i.test(error.message)) {
            next.push(child);
            continue;
          }
          throw error;
        }
        const status = typeof result?.status === 'string' ? result.status.toUpperCase() : '';
        if (status === 'FINISHED' || status === 'PUBLISHED') continue;
        if (status === 'ERROR' || status === 'EXPIRED') {
          const reason = safeApiMessage(result?.error_message, token);
          throw new Error(`Threads ${operation}가 실패했습니다.${reason ? ` 원인: ${reason}` : ''}`);
        }
        if (status !== 'IN_PROGRESS') {
          throw new Error(`Threads ${operation} 응답을 확인할 수 없습니다.`);
        }
        next.push(child);
      }
      if (next.length === 0) return;
      pending = next;
      if (attempt < CAROUSEL_CHILD_STATUS_MAX_ATTEMPTS) await this.pause(CAROUSEL_CHILD_STATUS_INTERVAL_MS);
    }
    const indexes = pending.map((child) => child.index + 1).join(', ');
    throw new Error(`Threads 캐러셀 이미지 처리 시간이 초과되었습니다. 미완료 이미지: ${indexes}`);
  }

  private async token(accountId: string): Promise<string> {
    const token = await this.credentials.get(`threadsToken:${accountId}`);
    if (!token) throw new Error('Threads Access Token이 저장되지 않았습니다.');
    return token;
  }

  private async request(path: string, token: string, init?: RequestInit, context?: ThreadsRequestContext): Promise<any> {
    const response = await this.fetchImpl(path.startsWith('https://') ? path : `${BASE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded', ...init?.headers },
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 2_000_000) throw new Error('Threads API 응답 크기 제한을 초과했습니다.');
    const body = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    if (!response.ok) {
      const code = body?.error?.code ?? response.status;
      const subcode = body?.error?.error_subcode;
      const providerMessage = safeApiMessage(body?.error?.message, token);
      const userTitle = safeApiMessage(body?.error?.error_user_title, token);
      const userMessage = safeApiMessage(body?.error?.error_user_msg, token);
      const errorData = safeApiMessage(body?.error?.error_data == null ? undefined : JSON.stringify(body.error.error_data), token);
      const detail = [`code ${code}`, subcode == null ? undefined : `subcode ${subcode}`].filter(Boolean).join(', ');
      const operation = context?.operation ? ` [${context.operation}]` : '';
      const providerDetails = [providerMessage, userTitle && `Meta 제목: ${userTitle}`, userMessage && `Meta 안내: ${userMessage}`, errorData && `Meta 상세: ${errorData}`].filter(Boolean).join(' | ');
      throw new ProviderRequestError(`Threads API 요청 실패${operation} (${detail})${providerDetails ? `: ${providerDetails}` : ''}`, response.status === 429 || response.status >= 500, Number(response.headers.get('retry-after') ?? 0) * 1000 || undefined, response.status);
    }
    return body;
  }

  async verifyAccessToken(accessToken: string): Promise<ThreadsProfile> {
    const token = accessToken.trim();
    if (!token) throw new Error('Threads Access Token을 입력하세요.');
    try {
      const body = await this.request(PROFILE_URL, token, { method:'GET' });
      const id = typeof body?.id === 'string' || typeof body?.id === 'number' ? String(body.id).trim() : '';
      const username = typeof body?.username === 'string' ? body.username.trim().replace(/^@/, '') : '';
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!id || !username) throw new Error('Threads 계정 정보를 확인할 수 없습니다. 토큰 권한을 확인하세요.');
      return { id, username, name:name || username };
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        if (error.status === 401 || /\bcode 190\b/i.test(error.message)) throw new InvalidThreadsTokenError('Threads Access Token이 유효하지 않습니다. 새 토큰을 연결하세요.', { cause:error });
        if ([400,401,403].includes(error.status ?? 0)) throw new Error('Threads Access Token이 유효하지 않거나 필요한 권한이 없습니다. Meta Developers에서 장기 토큰을 다시 확인하세요.', { cause:error });
        if (error.status === 429) throw new Error('Threads API 요청이 너무 많습니다. 잠시 후 다시 시도하세요.', { cause:error });
        if ((error.status ?? 0) >= 500) throw new Error('Threads 서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.', { cause:error });
      }
      if (error instanceof Error && error.message.startsWith('Threads 계정 정보를')) throw error;
      throw new Error('Threads 서비스에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.', { cause:error });
    }
  }

  async debugAccessToken(accessToken: string): Promise<ThreadsTokenDebugResult> {
    const token = accessToken.trim();
    if (!token) throw new Error('Threads Access Token을 입력하세요.');
    try {
      const params = new URLSearchParams({ input_token:token });
      const body = await this.request(`${API_HOST}/debug_token?${params}`, token, { method:'GET' });
      const data = body?.data;
      if (!data || typeof data !== 'object' || typeof data.is_valid !== 'boolean') {
        throw new Error('Threads 토큰 진단 응답을 확인할 수 없습니다.');
      }
      const valid = data.is_valid === true;
      const rawUserId = data.user_id;
      if (typeof rawUserId === 'number' && !Number.isSafeInteger(rawUserId)) throw new Error('Threads 토큰 사용자 ID 형식을 안전하게 확인할 수 없습니다.');
      const userId = typeof rawUserId === 'string' || typeof rawUserId === 'number' ? String(rawUserId).trim() : undefined;
      const issuedAt = epochIso(data.issued_at);
      const expiresAt = epochIso(data.expires_at);
      if (valid && data.type !== 'USER') throw new Error('Threads 사용자 토큰이 아닙니다. 장기 User Access Token을 입력하세요.');
      if (valid && (!userId || !issuedAt || !expiresAt || Date.parse(issuedAt) > Date.parse(expiresAt))) {
        throw new Error('Threads 토큰의 발급일 또는 만료일을 확인할 수 없습니다.');
      }
      if (data.scopes != null && !Array.isArray(data.scopes)) throw new Error('Threads 토큰 권한 정보를 확인할 수 없습니다.');
      return {
        valid, userId, issuedAt, expiresAt,
        dataAccessExpiresAt:epochIso(data.data_access_expires_at),
        scopes:Array.isArray(data.scopes) ? [...new Set<string>(data.scopes.filter((scope:unknown):scope is string => typeof scope === 'string' && Boolean(scope.trim())).map((scope:string)=>scope.trim()))].sort() : [],
        application:typeof data.application === 'string' ? data.application.trim() || undefined : undefined,
        checkedAt:new Date(this.now()).toISOString(),
      };
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('Threads 토큰 진단 응답') || error.message.startsWith('Threads 토큰의 발급일')
        || error.message.startsWith('Threads 토큰 사용자 ID') || error.message.startsWith('Threads 사용자 토큰') || error.message.startsWith('Threads 토큰 권한'))) throw error;
      if (error instanceof ProviderRequestError) {
        if (error.status === 400 && /\bcode 200\b/i.test(error.message) && /API access blocked/i.test(error.message)) {
          throw new TokenInspectionUnavailableError('Meta가 현재 User Access Token만으로는 토큰 상세 조회를 허용하지 않습니다.', { cause:error });
        }
        if (error.status === 401 || /\bcode 190\b/i.test(error.message)) throw new InvalidThreadsTokenError('Threads Access Token이 유효하지 않습니다. 새 토큰을 연결하세요.', { cause:error });
        if ([400,401,403].includes(error.status ?? 0)) throw new Error('Threads 토큰 정보를 확인할 수 없습니다. Access Token과 권한을 다시 확인하세요.', { cause:error });
        if (error.status === 429) throw new Error('Threads 토큰 확인 요청이 너무 많습니다. 잠시 후 다시 시도하세요.', { cause:error });
        if ((error.status ?? 0) >= 500) throw new Error('Threads 서비스 오류로 토큰 정보를 확인하지 못했습니다. 잠시 후 다시 시도하세요.', { cause:error });
      }
      if (error instanceof Error) {
        error.message = safeApiMessage(error.message, token) ?? 'Threads API network error';
        error.stack = undefined;
        throw new Error('Threads 서비스에 연결할 수 없어 토큰 정보를 확인하지 못했습니다. 인터넷 연결을 확인하세요.', { cause:error });
      }
      // Non-Error rejection values are intentionally omitted because they may contain a raw token.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Threads 서비스에 연결할 수 없어 토큰 정보를 확인하지 못했습니다. 인터넷 연결을 확인하세요.');
    }
  }

  async debugStoredAccessToken(accountId: string): Promise<ThreadsTokenDebugResult> {
    return this.debugAccessToken(await this.token(accountId));
  }

  async refreshAccessToken(accountId: string): Promise<ThreadsTokenRefreshResult> {
    const currentToken = await this.token(accountId);
    try {
      const params = new URLSearchParams({ grant_type:'th_refresh_token', access_token:currentToken });
      const body = await this.request(`${API_HOST}/refresh_access_token?${params}`, currentToken, { method:'GET' });
      const accessToken = typeof body?.access_token === 'string' ? body.access_token.trim() : '';
      const tokenType = typeof body?.token_type === 'string' ? body.token_type.trim().toLowerCase() : 'bearer';
      const expiresInSeconds = Number(body?.expires_in);
      const refreshedAtMs = this.now();
      const expiresAtMs = refreshedAtMs + expiresInSeconds * 1000;
      if (!accessToken || tokenType !== 'bearer' || !Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || !Number.isFinite(expiresAtMs) || expiresAtMs > 8_640_000_000_000_000) {
        throw new Error('Threads 토큰 갱신 응답을 확인할 수 없습니다. 토큰은 변경하지 않았습니다.');
      }
      return {
        accessToken,
        tokenType:'bearer',
        expiresInSeconds,
        refreshedAt:new Date(refreshedAtMs).toISOString(),
        expiresAt:new Date(expiresAtMs).toISOString(),
        tokenChanged:accessToken !== currentToken,
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Threads 토큰 갱신 응답을')) throw error;
      if (error instanceof ProviderRequestError) {
        if (/parameter access_token is required/i.test(error.message)) throw new Error('Threads 토큰 갱신 요청에서 access_token 매개변수가 누락되었습니다 (API code 100).', { cause:error });
        if ([400,401,403].includes(error.status ?? 0)) {
          throw new Error('Threads 장기 토큰이 만료되었거나 갱신할 수 없습니다. 새 장기 토큰을 발급해 연결하세요.', { cause:error });
        }
        if (error.status === 429) throw new Error('Threads 토큰 갱신 요청이 너무 많습니다. 잠시 후 다시 시도하세요.', { cause:error });
        if ((error.status ?? 0) >= 500) throw new Error(`Threads 서비스 오류로 토큰을 갱신하지 못했습니다. HTTP ${error.status}${error.message.match(/\bcode \d+/)?.[0]?`, API ${error.message.match(/\bcode \d+/)![0]}`:''}. 잠시 후 다시 시도하세요.`, { cause:error });
        throw new Error('Threads 토큰을 갱신하지 못했습니다. 계정과 토큰 상태를 확인하세요.', { cause:error });
      }
      if (error instanceof Error) {
        error.message = safeApiMessage(error.message, currentToken) ?? 'Threads API network error';
        error.stack = undefined;
        throw new Error('Threads 서비스에 연결할 수 없어 토큰을 갱신하지 못했습니다. 인터넷 연결을 확인하세요.', { cause:error });
      }
      // Non-Error rejection values are intentionally omitted because they may contain a raw token.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Threads 서비스에 연결할 수 없어 토큰을 갱신하지 못했습니다. 인터넷 연결을 확인하세요.');
    }
  }

  async test(accountId: string): Promise<ConnectionResult> {
    try { const profile = await this.verifyAccessToken(await this.token(accountId)); return { ok: true, message: `Threads 연결에 성공했습니다. (@${profile.username})` }; }
    catch { return { ok: false, message: 'Threads 연결 실패: 토큰 또는 권한을 확인하세요.' }; }
  }

  async ownPosts(accountId: string, limit = 10): Promise<ThreadsPostSummary[]> {
    const params = new URLSearchParams({ fields:POST_FIELDS, limit:String(Math.max(1, Math.min(50, limit))) });
    const body = await this.request(`${API_HOST}/me/threads?${params}`, await this.token(accountId), { method:'GET' });
    return (Array.isArray(body?.data) ? body.data : []).map(postSummary).filter((post:ThreadsPostSummary) => post.id);
  }

  async getPost(accountId: string, postId: string): Promise<ThreadsPostSummary> {
    try {
      const body = await this.request(`${API_HOST}/${encodeURIComponent(postId)}?fields=${encodeURIComponent(POST_DETAIL_FIELDS)}`, await this.token(accountId), { method:'GET' });
      const post = postSummary(body);
      if (!post.id) throw new Error('Threads 게시물 정보를 확인할 수 없습니다.');
      return post;
    } catch (error) {
      if (error instanceof Error && error.message === 'Threads 게시물 정보를 확인할 수 없습니다.') throw error;
      throw safeOperationError('게시물 조회', error);
    }
  }

  async replies(accountId: string, parentId: string, limit = 250): Promise<ThreadsPostSummary[]> {
    return this.readReplies(accountId, parentId, 'replies', limit);
  }

  async conversation(accountId: string, parentId: string, limit = 250): Promise<ThreadsPostSummary[]> {
    return this.readReplies(accountId, parentId, 'conversation', limit);
  }

  async publish(accountId: string, input: PublishInput): Promise<PublishResult> {
    const imageUrls = publishImageUrls(input);
    const token = await this.token(accountId);
    let container: any;
    if (imageUrls.length >= 2) {
      const children: CarouselChildContainer[] = [];
      for (const [index, imageUrl] of imageUrls.entries()) {
        const child = await this.request('/me/threads', token, {
          method:'POST',
          body:new URLSearchParams({ media_type:'IMAGE', image_url:imageUrl, is_carousel_item:'true' }),
        }, { operation:`캐러셀 이미지 ${index + 1}/${imageUrls.length} (${remoteUrlLabel(imageUrl)})` });
        if (!child?.id) throw new Error('Threads 캐러셀 항목 컨테이너 ID를 받지 못했습니다.');
        children.push({ id:String(child.id), index, imageUrl });
      }
      await this.waitForCarouselChildren(token, children);
      container = await this.request('/me/threads', token, {
        method:'POST',
        body:new URLSearchParams({ media_type:'CAROUSEL', text:input.text, children:children.map((child) => child.id).join(',') }),
      }, { operation:`캐러셀 부모 컨테이너 (${children.length}개 항목)` });
    } else {
      const params = new URLSearchParams({ media_type:imageUrls.length === 1 ? 'IMAGE' : 'TEXT', text:input.text });
      if (imageUrls[0]) params.set('image_url', imageUrls[0]);
      else if (input.linkUrl) params.set('link_attachment', input.linkUrl);
      const operation = imageUrls[0] ? `단일 이미지 컨테이너 (${remoteUrlLabel(imageUrls[0])})` : input.linkUrl ? '링크 텍스트 컨테이너' : '텍스트 컨테이너';
      container = await this.request('/me/threads', token, { method:'POST', body:params }, { operation });
    }
    if (!container?.id) throw new Error('Threads 게시물 컨테이너 ID를 받지 못했습니다.');
    // Meta may return a creation id before it is visible to threads_publish.
    // A short local wait prevents the definitive code 24 / subcode 4279009
    // "media not found" response without adding another Graph API request.
    await this.waitForContainerConsistency();
    let published: any;
    try { published = await this.request('/me/threads_publish', token, { method: 'POST', body: new URLSearchParams({ creation_id: container.id }) }, { operation:imageUrls.length >= 2 ? '캐러셀 최종 게시' : '단일 게시 최종 게시' }); }
    catch (error) { throw new UncertainRemoteOperationError(`Threads 게시 결과가 불확실합니다. 자동 재시도하지 않습니다. 원인: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    if (!published?.id) throw new UncertainRemoteOperationError('Threads 게시물 ID를 확인할 수 없습니다. 자동 재시도하지 않습니다.');
    return { remoteId: published.id };
  }

  async deletePost(accountId: string, postId: string): Promise<string> {
    try {
      const token=await this.token(accountId);
      const body = await this.request(`${API_HOST}/${encodeURIComponent(postId)}`, token, { method:'DELETE' });
      const deletedId=typeof body?.deleted_id==='string'||typeof body?.deleted_id==='number'?String(body.deleted_id):'';
      if (body?.success !== true || !deletedId || deletedId !== postId) throw new Error('Threads 게시물 삭제 결과를 확인할 수 없습니다.');
      return deletedId;
    } catch (error) {
      if (error instanceof Error && error.message === 'Threads 게시물 삭제 결과를 확인할 수 없습니다.') throw error;
      throw safeOperationError('게시물 삭제', error);
    }
  }

  async comments(accountId: string): Promise<RemoteComment[]> {
    const token = await this.token(accountId);
    const me = await this.request('/me?fields=id,username', token);
    const results: RemoteComment[] = [];
    // 댓글 주기마다 과거 게시물 페이지 전체를 순회하지 않고 최신 50개만 확인한다.
    const data = await this.request('/me/threads?fields=id,replies{id,text,timestamp,username}&limit=50', token);
    for (const post of data.data ?? []) {
      let replies = post.replies;
      for (let replyPage = 0; replyPage < 5 && replies; replyPage++) {
        results.push(...(replies.data ?? []).filter((reply: any) => reply.username !== me.username).map((reply: any) => ({ id: reply.id, postId: post.id, text: reply.text ?? '', createdAt: reply.timestamp, username:reply.username })));
        replies = replies.paging?.next ? await this.request(replies.paging.next, token) : undefined;
      }
    }
    return results;
  }

  async reply(accountId: string, commentId: string, text: string, linkUrl?: string): Promise<PublishResult> {
    try {
      const token = await this.token(accountId);
      const body = new URLSearchParams({ media_type:'TEXT', text, reply_to_id:commentId });
      if (linkUrl) body.set('link_attachment', linkUrl);
      const container = await this.request('/me/threads', token, { method:'POST', body }, { operation:linkUrl ? '링크 포함 답글 컨테이너' : '답글 컨테이너' });
      if (!container?.id) throw new Error('Threads 답글 컨테이너 ID를 받지 못했습니다.');
      await this.waitForContainerConsistency();
      let published: any;
      try { published = await this.request('/me/threads_publish', token, { method: 'POST', body: new URLSearchParams({ creation_id: container.id }) }, { operation:'답글 최종 게시' }); }
      catch (error) { throw new UncertainRemoteOperationError(`Threads 답글 결과가 불확실합니다. 같은 댓글에 자동 재답글하지 않습니다. 원인: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      if (!published?.id) throw new UncertainRemoteOperationError('Threads 답글 ID를 확인할 수 없습니다. 자동 재시도하지 않습니다.');
      return { remoteId: published.id };
    } catch (error) {
      if (error instanceof UncertainRemoteOperationError) throw error;
      if (error instanceof Error && error.message === 'Threads 답글 컨테이너 ID를 받지 못했습니다.') throw error;
      throw safeOperationError('답글 작성', error);
    }
  }

  private async readReplies(accountId: string, parentId: string, endpoint: 'replies' | 'conversation', limit: number): Promise<ThreadsPostSummary[]> {
    try {
      const maximum=Math.max(1,Math.min(250,limit));
      const params = new URLSearchParams({
        fields:REPLY_FIELDS,
        reverse:'false',
        limit:String(Math.min(50,maximum)),
      });
      const token=await this.token(accountId);
      const results:ThreadsPostSummary[]=[];
      let next:string|undefined=`${API_HOST}/${encodeURIComponent(parentId)}/${endpoint}?${params}`;
      for(let page=0;page<5&&next&&results.length<maximum;page+=1){
        const body=await this.request(next,token,{method:'GET'});
        results.push(...(Array.isArray(body?.data)?body.data:[]).map(postSummary).filter((post:ThreadsPostSummary)=>post.id));
        next=typeof body?.paging?.next==='string'?body.paging.next:undefined;
      }
      return results.slice(0,maximum);
    } catch (error) {
      throw safeOperationError('답글 조회', error);
    }
  }

  async insights(accountId: string, postId: string): Promise<InsightValues> {
    const data = await this.request(`/${encodeURIComponent(postId)}/insights?metric=views,likes,replies,reposts,quotes,shares`, await this.token(accountId));
    return Object.fromEntries((data.data ?? []).map((metric: any) => [metric.name, Number(metric.values?.[0]?.value ?? 0)]));
  }
}
