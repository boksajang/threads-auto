import type { Account, SourceCandidate, ThreadsPostSummary, ThreadsProfile, ThreadsTokenDebugResult } from '../../shared/domain';

export interface ConnectionResult { ok: boolean; message: string }
export interface PublishInput {
  text: string;
  linkUrl?: string;
  /** @deprecated 단일 이미지 호출 호환용입니다. 새 호출자는 imageUrls를 사용하세요. */
  imageUrl?: string;
  imageUrls?: string[];
}
export interface PublishResult { remoteId: string; permalink?: string }
export interface ThreadsTokenRefreshResult {
  accessToken: string;
  tokenType: 'bearer';
  expiresInSeconds: number;
  refreshedAt: string;
  expiresAt: string;
  tokenChanged: boolean;
}
export interface RemoteComment { id: string; postId: string; text: string; createdAt: string; username?: string }
export interface InsightValues { views?: number; likes?: number; replies?: number; reposts?: number; quotes?: number; shares?: number }

export class UncertainRemoteOperationError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'UncertainRemoteOperationError'; }
}
export class ProviderRequestError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs?: number, readonly status?: number, options?: ErrorOptions) { super(message, options); this.name = 'ProviderRequestError'; }
}
export class InvalidThreadsTokenError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'InvalidThreadsTokenError'; }
}
export class TokenInspectionUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'TokenInspectionUnavailableError'; }
}

export interface ThreadsProvider {
  verifyAccessToken(accessToken: string): Promise<ThreadsProfile>;
  debugAccessToken(accessToken: string): Promise<ThreadsTokenDebugResult>;
  debugStoredAccessToken(accountId: string): Promise<ThreadsTokenDebugResult>;
  refreshAccessToken(accountId: string): Promise<ThreadsTokenRefreshResult>;
  test(accountId: string): Promise<ConnectionResult>;
  ownPosts(accountId: string, limit?: number): Promise<ThreadsPostSummary[]>;
  getPost(accountId: string, postId: string): Promise<ThreadsPostSummary>;
  replies(accountId: string, parentId: string, limit?: number): Promise<ThreadsPostSummary[]>;
  conversation(accountId: string, parentId: string, limit?: number): Promise<ThreadsPostSummary[]>;
  publish(accountId: string, input: PublishInput): Promise<PublishResult>;
  deletePost(accountId: string, postId: string): Promise<string>;
  comments(accountId: string): Promise<RemoteComment[]>;
  reply(accountId: string, commentId: string, text: string, linkUrl?: string): Promise<PublishResult>;
  insights(accountId: string, postId: string): Promise<InsightValues>;
}

export interface DiscoveryProvider {
  readonly type: 'YOUTUBE' | 'BLOG';
  test(accountId: string, config: Record<string, unknown>): Promise<ConnectionResult>;
  discover(account: Account, config: Record<string, unknown>): Promise<SourceCandidate[]>;
}

export interface ProductCandidate extends SourceCandidate { productId: string; price?: number }
export interface AffiliatePerformance { date: string; subId: string; clicks: number; orders: number; orderAmount: number; revenue: number }
export interface CoupangProvider {
  connectionFingerprint(accountId: string): Promise<string>;
  test(accountId: string): Promise<ConnectionResult>;
  search(account: Account, keyword: string): Promise<ProductCandidate[]>;
  goldbox(account: Account): Promise<ProductCandidate[]>;
  bestCategory(account: Account, categoryId: string): Promise<ProductCandidate[]>;
  coupangPl(account: Account, brandId?: string): Promise<ProductCandidate[]>;
  deepLink(accountId: string, url: string, registeredSubId?: string): Promise<string>;
  performance(accountId: string, from: Date, to: Date): Promise<AffiliatePerformance[]>;
}

export class ProviderRegistry {
  private discoveries = new Map<string, DiscoveryProvider>();
  registerDiscovery(provider: DiscoveryProvider): void { this.discoveries.set(provider.type, provider); }
  discovery(type: string): DiscoveryProvider | undefined { return this.discoveries.get(type); }
}
