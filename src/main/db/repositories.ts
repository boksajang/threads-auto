import { randomUUID } from 'node:crypto';
import { COUPANG_LINK_QUEUE_STATUSES } from '../../shared/domain';
import type { Account, AccountInput, AffiliateReportRow, CoupangInputType, CoupangLinkQueueStatus, CoupangMetadataStatus, CoupangProductQueueItem, CoupangProductQueueSummary, CoupangReviewEvidence, DashboardActivitySnapshot, JobRecord, LogLevel, MediaAsset, PipelineQualityDecision, PipelineRunView, PipelineStage, PipelineStatus, PostRecord, ProductQueueProvider, ProviderConfig, ReportRow, SourceCandidate, SourceType, ThreadsProfile, UserLog } from '../../shared/domain';
import { formatThreadsPostText } from '../../shared/threads-text';
import type { AppDatabase } from './database';
import { composeCoupangPost, coupangCreativeFromStoredBody } from '../services/coupang-compliance';
import { composeNaverBrandPost, naverBrandCreativeFromStoredBody } from '../services/naver-brand-compliance';

export const SCHEDULE_REBUILD_REASON = '자동화 일정 재생성을 위해 예정 작업을 취소했습니다.';
export const GLOBAL_AUTOMATION_STOP_REASON = '전체 자동화가 중지되어 예정 작업을 취소했습니다.';
const PROGRAM_EXIT_CANCELLATION_REASON = '프로그램 종료로 작업이 취소되었습니다.';

const bool = (value: unknown) => value === 1;
const json = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const distinctStrings = (values: unknown[]): string[] => [...new Set(values
  .filter((value): value is string => typeof value === 'string')
  .map((value) => value.trim()).filter(Boolean))];

function normalizedMedia(input: { imageUrl?:string|null; imageUrls?:string[]|null; media?:MediaAsset[]|null }): { imageUrl?:string; imageUrls:string[]; media:MediaAsset[] } {
  const suppliedCollection = input.imageUrls !== undefined || input.media !== undefined;
  const suppliedMedia = (input.media ?? []).filter((asset): asset is MediaAsset => asset?.type === 'IMAGE' && typeof asset.url === 'string' && Boolean(asset.url.trim()));
  const imageUrls = distinctStrings(suppliedCollection
    ? [...(input.imageUrls ?? []), ...suppliedMedia.map((asset) => asset.url)]
    : [input.imageUrl]);
  const mediaByUrl = new Map(suppliedMedia.map((asset) => [asset.url.trim(), asset]));
  const media = imageUrls.map((url, position) => {
    const asset = mediaByUrl.get(url);
    return { type:'IMAGE' as const, url, position, ...(asset?.altText ? { altText:asset.altText } : {}), ...(asset?.source ? { source:asset.source } : {}) };
  });
  return { imageUrl:imageUrls[0], imageUrls, media };
}

function mediaFromRow(row:any): { imageUrl?:string; imageUrls:string[]; media:MediaAsset[] } {
  const storedMedia=json<MediaAsset[]>(row.media_json ?? '[]', []);
  const storedUrls=json<string[]>(row.image_urls_json ?? '[]', []);
  const imageUrls=distinctStrings([row.image_url, ...storedUrls, ...storedMedia.map((asset)=>asset?.url)]);
  const mediaByUrl=new Map(storedMedia.filter((asset)=>asset?.type==='IMAGE'&&typeof asset.url==='string').map((asset)=>[asset.url.trim(),asset]));
  return { imageUrl:row.image_url?.trim()||imageUrls[0], imageUrls, media:imageUrls.map((url,position)=>{
    const asset=mediaByUrl.get(url);
    return {type:'IMAGE',url,position,...(asset?.altText?{altText:asset.altText}:{}),...(asset?.source?{source:asset.source}:{})};
  }) };
}

function normalizedReviewEvidence(values:CoupangReviewEvidence[]|undefined|null):CoupangReviewEvidence[] {
  return (values ?? []).filter((entry)=>typeof entry?.text==='string'&&Boolean(entry.text.trim())).map((entry)=>({
    text:entry.text.trim(),...(entry.id?{id:entry.id}:{}),...(entry.option?{option:entry.option.trim()}:{}),
    ...(typeof entry.rating==='number'?{rating:entry.rating}:{}),...(entry.reviewedAt?{reviewedAt:entry.reviewedAt}:{}),
  }));
}

function accountFromRow(row: any): Account {
  return {
    id: row.id,
    threadsUserId: row.threads_user_id ?? undefined,
    threadsTokenIssuedAt: row.threads_token_issued_at ?? undefined,
    threadsTokenExpiresAt: row.threads_token_expires_at ?? undefined,
    threadsTokenDataAccessExpiresAt: row.threads_token_data_access_expires_at ?? undefined,
    threadsTokenCheckedAt: row.threads_token_checked_at ?? undefined,
    threadsTokenCheckFailedAt: row.threads_token_check_failed_at ?? undefined,
    threadsTokenScopes: row.threads_token_scopes_json == null ? undefined : json<string[]>(row.threads_token_scopes_json, []),
    threadsTokenValid: row.threads_token_valid == null ? undefined : bool(row.threads_token_valid),
    threadsTokenLastRefreshedAt: row.threads_token_last_refreshed_at ?? undefined,
    name: row.name,
    threadsHandle: row.threads_handle,
    topic: row.topic,
    personality: row.personality,
    tone: row.tone,
    audience: row.audience,
    forbiddenTopics: row.forbidden_topics,
    forbiddenExpressions: row.forbidden_expressions,
    dailyEnabled: bool(row.daily_enabled),
    promotionEnabled: bool(row.promotion_enabled),
    automationTarget: bool(row.automation_target),
    active: bool(row.active),
    dailyRatio: row.daily_ratio,
    promotionRatio: row.promotion_ratio,
    dailyPostTarget: row.daily_post_target,
    operationStart: row.operation_start,
    operationEnd: row.operation_end,
    weekdays: json(row.weekdays_json, [0, 1, 2, 3, 4, 5, 6]),
    commentIntervalMinutes: row.comment_interval_minutes,
    fixedLinkEnabled: bool(row.fixed_link_enabled),
    fixedLinkUrl: row.fixed_link_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pipelineRunFromRow(row: any): PipelineRunView {
  const metadata = json<Record<string, unknown>>(row.source_metadata_json ?? '{}', {});
  const sourceMedia=normalizedMedia({
    imageUrl:typeof metadata.imageUrl==='string'?metadata.imageUrl:undefined,
    imageUrls:Array.isArray(metadata.imageUrls)?metadata.imageUrls.filter((value):value is string=>typeof value==='string'):undefined,
    media:Array.isArray(metadata.media)?metadata.media as MediaAsset[]:undefined,
  });
  return {
    id:row.id, accountId:row.account_id, jobId:row.job_id ?? undefined, postId:row.post_id ?? undefined, mode:row.mode,
    postDeletedAt:row.post_deleted_at ?? undefined,
    collectedCommentCount:Number(row.collected_comment_count??0),threadsPostId:row.remote_post_id??undefined,
    status:row.status, stage:row.stage, progress:row.progress, message:row.message,
    errorSummary:row.error_summary ?? undefined, sourceId:row.source_id ?? undefined,
    source:row.source_id ? {
      id:row.source_id, sourceType:row.source_type, title:String(metadata.title ?? ''), sourceUrl:row.source_url ?? '',
      imageUrl:sourceMedia.imageUrl, imageUrls:sourceMedia.imageUrls, media:sourceMedia.media, publishedAt:row.source_published_at ?? undefined,
    } : undefined,
    draftBody:row.draft_body ?? undefined, quality:json<PipelineQualityDecision[]>(row.quality_json, []),
    startedAt:row.started_at, updatedAt:row.updated_at, finishedAt:row.finished_at ?? undefined,
  };
}

export type CommentDecision = 'PENDING' | 'REPLIED' | 'SKIPPED' | 'REPLY_UNCERTAIN' | 'FAILED_RETRYABLE';
export type CommentReplyStatus = 'NONE' | 'PUBLISHED' | 'UNCERTAIN' | 'DELETED' | 'DELETE_FAILED';

export interface CommentRecord {
  postBody?:string;
  postPublishedAt?:string;
  id:string;
  accountId:string;
  postId:string;
  body:string;
  authorUsername:string;
  commentedAt?:string;
  decision:CommentDecision;
  decisionReason?:string;
  replyBody?:string;
  replyId?:string;
  replyStatus:CommentReplyStatus;
  processedAt?:string;
  repliedAt?:string;
  replyDeletedAt?:string;
  lastError?:string;
  attemptCount:number;
  createdAt:string;
  updatedAt:string;
}

export interface CommentListInput {
  postId?:string;
  accountId:string;
  decision?:CommentDecision;
  replyStatus?:CommentReplyStatus;
  beforeUpdatedAt?:string;
  limit?:number;
}

export interface CommentSummary {
  total:number;
  pending:number;
  replied:number;
  skipped:number;
  attentionNeeded:number;
}

export interface ThreadsIntegrationRunRecord {
  id:string;
  accountId:string;
  mode:string;
  status:string;
  stage:string;
  message:string;
  summary?:string;
  lastError?:string;
  draftBody?:string;
  parentId?:string;
  replyId?:string;
  nestedReplyId?:string;
  cleanupNeeded:boolean;
  errorSummary?:string;
  metadata:Record<string,unknown>;
  startedAt:string;
  updatedAt:string;
  finishedAt?:string;
}

export interface ThreadsIntegrationEventRecord {
  id:number;
  runId:string;
  stage:string;
  level:LogLevel;
  message:string;
  detail:Record<string,unknown>;
  remoteId?:string;
  remoteObjectType?:string;
  remoteObjectId?:string;
  createdAt:string;
}

function commentFromRow(row:any):CommentRecord {
  return {
    postBody:row.post_body??undefined,postPublishedAt:row.post_published_at??undefined,
    id:row.id, accountId:row.account_id, postId:row.post_id, body:row.body,
    authorUsername:row.author_username, commentedAt:row.commented_at ?? undefined,
    decision:row.decision, decisionReason:row.decision_reason ?? undefined,
    replyBody:row.reply_body ?? undefined, replyId:row.reply_id ?? undefined,
    replyStatus:row.reply_status, processedAt:row.processed_at ?? undefined,
    repliedAt:row.replied_at ?? undefined, replyDeletedAt:row.reply_deleted_at ?? undefined,
    lastError:row.last_error ?? undefined, attemptCount:row.attempt_count,
    createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

function threadsIntegrationRunFromRow(row:any):ThreadsIntegrationRunRecord {
  return {
    id:row.id, accountId:row.account_id, mode:row.mode, status:row.status, stage:row.stage, message:row.message,
    summary:row.summary ?? undefined, lastError:row.last_error ?? undefined,
    draftBody:row.draft_body ?? undefined, parentId:row.parent_id ?? undefined,
    replyId:row.reply_id ?? undefined, nestedReplyId:row.nested_reply_id ?? undefined,
    cleanupNeeded:bool(row.cleanup_needed), errorSummary:row.error_summary ?? undefined,
    metadata:json(row.metadata_json, {}), startedAt:row.started_at, updatedAt:row.updated_at,
    finishedAt:row.finished_at ?? undefined,
  };
}

function threadsIntegrationEventFromRow(row:any):ThreadsIntegrationEventRecord {
  return {
    id:row.id, runId:row.run_id, stage:row.stage, level:row.level, message:row.message,
    detail:json(row.detail_json, {}), remoteId:row.remote_id ?? undefined, remoteObjectType:row.remote_object_type ?? undefined,
    remoteObjectId:row.remote_object_id ?? undefined, createdAt:row.created_at,
  };
}

function coupangLinkFromRow(row:any):CoupangProductQueueItem {
  const storedMedia=mediaFromRow(row);
  const reviewEvidence=normalizedReviewEvidence(json<CoupangReviewEvidence[]>(row.review_evidence_json ?? '[]', []));
  let draftBody=row.draft_body ?? undefined;
  if(draftBody){
    try{
      const naver=row.provider_type==='NAVER_BRAND_CONNECT';
      const creativeBody=naver?naverBrandCreativeFromStoredBody(draftBody,row.affiliate_url):coupangCreativeFromStoredBody(draftBody,row.affiliate_url);
      draftBody=naver?composeNaverBrandPost(creativeBody,row.affiliate_url,json<string[]>(row.product_facts_json,[]).includes('connectType=TRAVEL')?'TRAVEL':'SHOPPING'):composeCoupangPost(creativeBody,row.affiliate_url);
    }catch{/* 다시 준비 화면에서 손상된 기존 본문을 그대로 보여 준다. */}
  }
  return {
    id:row.id, accountId:row.account_id, providerType:row.provider_type??'COUPANG', originalInputType:row.original_input_type,
    affiliateUrl:row.affiliate_url, urlFingerprint:row.url_fingerprint,
    productName:row.product_name ?? undefined, productNote:row.product_note, imageUrl:storedMedia.imageUrl,
    imageUrls:storedMedia.imageUrls, media:storedMedia.media,
    productFacts:json<string[]>(row.product_facts_json, []), researchSourceUrls:json<string[]>(row.research_source_urls_json, []),
    reviewEvidence, researchVersion:Number(row.research_version ?? 1), reviewCount:Number(row.review_count ?? reviewEvidence.length),
    reviewCollectedAt:row.review_collected_at ?? undefined,
    metadataStatus:row.metadata_status, researchVerified:bool(row.research_verified), sortOrder:row.sort_order, status:row.status, attemptCount:row.attempt_count,
    activeSourceId:row.active_source_id ?? undefined, draftPostId:row.draft_post_id ?? undefined,
    draftBody, draftReplyBody:undefined,
    draftReplyStatus:row.draft_reply_status ?? undefined,
    activeRunId:row.active_run_id ?? undefined, lastError:row.last_error ?? undefined,
    claimedAt:row.claimed_at ?? undefined, previewedAt:row.previewed_at ?? undefined,
    completedAt:row.completed_at ?? undefined, researchedAt:row.researched_at ?? undefined,
    createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

function postFromRow(row:any):PostRecord {
  const storedMedia=mediaFromRow(row);
  return {
    id:row.id, accountId:row.account_id, sourceId:row.source_id ?? undefined, sourceType:row.source_type,
    body:row.body, url:row.url ?? undefined, imageUrl:storedMedia.imageUrl, imageUrls:storedMedia.imageUrls, media:storedMedia.media,
    threadsPostId:row.threads_post_id ?? undefined, remoteDeletedAt:row.remote_deleted_at ?? undefined,
    coupangReplyBody:row.coupang_reply_body ?? undefined, coupangReplyId:row.coupang_reply_id ?? undefined,
    coupangReplyStatus:row.coupang_reply_status ?? 'NONE', coupangReplyError:row.coupang_reply_error ?? undefined,
    coupangReplyPublishedAt:row.coupang_reply_published_at ?? undefined,
    coupangReplyDeletedAt:row.coupang_reply_deleted_at ?? undefined,
    createdAt:row.created_at, publishedAt:row.published_at ?? undefined,
  };
}

export interface CoupangLinkCreateInput {
  id?:string;
  accountId:string;
  providerType?:ProductQueueProvider;
  originalInputType:CoupangInputType;
  affiliateUrl:string;
  urlFingerprint:string;
  productName?:string;
  productNote?:string;
  imageUrl?:string;
  imageUrls?:string[];
  media?:MediaAsset[];
  productFacts?:string[];
  researchSourceUrls?:string[];
  reviewEvidence?:CoupangReviewEvidence[];
  researchVersion?:number;
  reviewCount?:number;
  reviewCollectedAt?:string;
  metadataStatus:CoupangMetadataStatus;
  researchedAt?:string;
  lastError?:string;
}

export interface CoupangLinkStatePatch {
  activeSourceId?:string|null;
  draftPostId?:string|null;
  activeRunId?:string|null;
  lastError?:string|null;
}

export class Repositories {
  private readonly logListeners = new Set<(log: UserLog) => void>();
  private readonly pipelineListeners = new Set<(run: PipelineRunView) => void>();
  constructor(private readonly db: AppDatabase) {}

  onLog(listener: (log: UserLog) => void): () => void { this.logListeners.add(listener); return () => this.logListeners.delete(listener); }
  onPipelineRun(listener: (run: PipelineRunView) => void): () => void { this.pipelineListeners.add(listener); return () => this.pipelineListeners.delete(listener); }

  listAccounts(): Account[] {
    return this.db.raw.prepare('SELECT * FROM accounts ORDER BY created_at').all().map(accountFromRow);
  }

  getAccount(id: string): Account | undefined {
    const row = this.db.raw.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return row ? accountFromRow(row) : undefined;
  }

  getAccountByThreadsUserId(threadsUserId: string): Account | undefined {
    const row = this.db.raw.prepare('SELECT * FROM accounts WHERE threads_user_id = ?').get(threadsUserId);
    return row ? accountFromRow(row) : undefined;
  }

  saveAccount(input: AccountInput & { threadsUserId?: string }): Account {
    if (!input.dailyEnabled && !input.promotionEnabled) throw new Error('일상글 또는 홍보글 중 하나 이상을 선택하세요.');
    const existing = input.id ? this.getAccount(input.id) : undefined;
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    this.db.raw.prepare(`
      INSERT INTO accounts (
        id,threads_user_id,name,threads_handle,topic,personality,tone,audience,forbidden_topics,forbidden_expressions,
        daily_enabled,promotion_enabled,automation_target,active,daily_ratio,promotion_ratio,daily_post_target,
        operation_start,operation_end,weekdays_json,comment_interval_minutes,fixed_link_enabled,fixed_link_url,created_at,updated_at
      ) VALUES (
        @id,@threadsUserId,@name,@threadsHandle,@topic,@personality,@tone,@audience,@forbiddenTopics,@forbiddenExpressions,
        @dailyEnabled,@promotionEnabled,@automationTarget,@active,@dailyRatio,@promotionRatio,@dailyPostTarget,
        @operationStart,@operationEnd,@weekdays,@commentIntervalMinutes,@fixedLinkEnabled,@fixedLinkUrl,@createdAt,@updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, threads_handle=excluded.threads_handle, topic=excluded.topic,
        personality=excluded.personality, tone=excluded.tone, audience=excluded.audience,
        forbidden_topics=excluded.forbidden_topics, forbidden_expressions=excluded.forbidden_expressions,
        daily_enabled=excluded.daily_enabled, promotion_enabled=excluded.promotion_enabled,
        automation_target=excluded.automation_target, active=excluded.active,
        daily_ratio=excluded.daily_ratio, promotion_ratio=excluded.promotion_ratio,
        daily_post_target=excluded.daily_post_target, operation_start=excluded.operation_start,
        operation_end=excluded.operation_end, weekdays_json=excluded.weekdays_json,
        comment_interval_minutes=excluded.comment_interval_minutes,
        fixed_link_enabled=excluded.fixed_link_enabled, fixed_link_url=excluded.fixed_link_url,
        updated_at=excluded.updated_at
    `).run({
      ...input,
      id,
      threadsUserId: input.threadsUserId ?? existing?.threadsUserId ?? null,
      dailyEnabled: Number(input.dailyEnabled), promotionEnabled: Number(input.promotionEnabled),
      automationTarget: Number(input.automationTarget), active: Number(input.active),
      fixedLinkEnabled: Number(input.fixedLinkEnabled), weekdays: JSON.stringify(input.weekdays),
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    });
    return this.getAccount(id)!;
  }

  updateThreadsProfile(accountId: string, profile: ThreadsProfile): Account {
    this.db.raw.prepare('UPDATE accounts SET threads_user_id=?,name=?,threads_handle=?,updated_at=? WHERE id=?')
      .run(profile.id, profile.name || profile.username, profile.username, new Date().toISOString(), accountId);
    return this.getAccount(accountId)!;
  }

  updateThreadsTokenMetadata(accountId: string, metadata: {
    issuedAt?: string; expiresAt: string; dataAccessExpiresAt?: string; checkedAt?: string;
    scopes?: string[]; valid?: boolean; lastRefreshedAt?: string;
  }): Account {
    const expiresAt = new Date(metadata.expiresAt);
    const issuedAt = metadata.issuedAt ? new Date(metadata.issuedAt) : undefined;
    const dataAccessExpiresAt = metadata.dataAccessExpiresAt ? new Date(metadata.dataAccessExpiresAt) : undefined;
    const checkedAt = metadata.checkedAt ? new Date(metadata.checkedAt) : undefined;
    const lastRefreshedAt = metadata.lastRefreshedAt ? new Date(metadata.lastRefreshedAt) : undefined;
    if ([expiresAt,issuedAt,dataAccessExpiresAt,checkedAt,lastRefreshedAt].some((date)=>date && Number.isNaN(date.getTime()))) {
      throw new Error('Threads 토큰 발급·만료·확인 시각이 올바르지 않습니다.');
    }
    const updatedAt = new Date().toISOString();
    const result = this.db.raw.prepare(`UPDATE accounts
      SET threads_token_issued_at=COALESCE(@issuedAt,threads_token_issued_at),
          threads_token_expires_at=@expiresAt,
          threads_token_data_access_expires_at=COALESCE(@dataAccessExpiresAt,threads_token_data_access_expires_at),
          threads_token_checked_at=COALESCE(@checkedAt,threads_token_checked_at),
          threads_token_scopes_json=COALESCE(@scopesJson,threads_token_scopes_json),
          threads_token_valid=COALESCE(@valid,threads_token_valid),
          threads_token_check_failed_at=NULL,
          threads_token_last_refreshed_at=COALESCE(@lastRefreshedAt,threads_token_last_refreshed_at),
          updated_at=@updatedAt
      WHERE id=@accountId`).run({
        issuedAt:issuedAt?.toISOString() ?? null, expiresAt:expiresAt.toISOString(),
        dataAccessExpiresAt:dataAccessExpiresAt?.toISOString() ?? null, checkedAt:checkedAt?.toISOString() ?? null,
        scopesJson:metadata.scopes ? JSON.stringify([...new Set(metadata.scopes)].sort()) : null,
        valid:metadata.valid == null ? null : Number(metadata.valid), lastRefreshedAt:lastRefreshedAt?.toISOString() ?? null,
        updatedAt, accountId,
      });
    if (result.changes !== 1) throw new Error('토큰 정보를 갱신할 계정을 찾을 수 없습니다.');
    return this.getAccount(accountId)!;
  }

  recordThreadsTokenCheck(accountId: string, outcome: 'VERIFIED' | 'INVALID' | 'CHECK_FAILED', checkedAt: string): Account {
    const result = this.db.raw.prepare(`UPDATE accounts SET threads_token_valid=?, threads_token_checked_at=?,
      threads_token_check_failed_at=?, updated_at=? WHERE id=?`).run(
        outcome === 'VERIFIED' ? 1 : outcome === 'INVALID' ? 0 : null,
        checkedAt, outcome === 'CHECK_FAILED' ? checkedAt : null, checkedAt, accountId);
    if (result.changes !== 1) throw new Error('토큰 정보를 갱신할 계정을 찾을 수 없습니다.');
    return this.getAccount(accountId)!;
  }

  clearThreadsTokenMetadata(accountId: string): Account {
    const result = this.db.raw.prepare(`UPDATE accounts
      SET threads_token_issued_at=NULL, threads_token_expires_at=NULL, threads_token_data_access_expires_at=NULL,
          threads_token_checked_at=NULL, threads_token_check_failed_at=NULL, threads_token_scopes_json=NULL, threads_token_valid=NULL,
          threads_token_last_refreshed_at=NULL, updated_at=?
      WHERE id=?`).run(new Date().toISOString(), accountId);
    if (result.changes !== 1) throw new Error('토큰 정보를 삭제할 계정을 찾을 수 없습니다.');
    return this.getAccount(accountId)!;
  }

  deleteAccount(id: string): void {
    this.db.raw.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  listProviderConfigs(accountId: string): ProviderConfig[] {
    return this.db.raw.prepare('SELECT * FROM provider_configs WHERE account_id=? ORDER BY provider_type').all(accountId).map((row: any) => ({
      id: row.id, accountId: row.account_id, type: row.provider_type, enabled: bool(row.enabled), config: json(row.config_json, {}),
    }));
  }

  saveProviderConfig(input: Omit<ProviderConfig, 'id'> & { id?: string }): ProviderConfig {
    const id = input.id ?? randomUUID();
    this.db.raw.prepare(`INSERT INTO provider_configs(id,account_id,provider_type,enabled,config_json)
      VALUES(?,?,?,?,?) ON CONFLICT(account_id,provider_type) DO UPDATE SET enabled=excluded.enabled,config_json=excluded.config_json`)
      .run(id, input.accountId, input.type, Number(input.enabled), JSON.stringify(input.config));
    return this.listProviderConfigs(input.accountId).find((entry) => entry.type === input.type)!;
  }

  deleteProviderConfig(accountId: string, type: ProviderConfig['type']): boolean {
    return this.db.raw.prepare('DELETE FROM provider_configs WHERE account_id=? AND provider_type=?').run(accountId, type).changes === 1;
  }

  createCoupangLink(input:CoupangLinkCreateInput):CoupangProductQueueItem {
    const create=this.db.raw.transaction(()=>{
      const id=input.id ?? randomUUID();
      const now=new Date().toISOString();
      const storedMedia=normalizedMedia(input);
      const reviewEvidence=normalizedReviewEvidence(input.reviewEvidence);
      const providerType=input.providerType??'COUPANG';
      const row:any=this.db.raw.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 next_order FROM coupang_link_queue WHERE account_id=? AND provider_type=?').get(input.accountId,providerType);
      const status:CoupangLinkQueueStatus=input.metadataStatus==='READY' ? 'QUEUED'
        : input.metadataStatus==='FAILED' ? 'REVIEW_REQUIRED' : 'INFORMATION_REQUIRED';
      this.db.raw.prepare(`INSERT INTO coupang_link_queue(
        id,account_id,original_input_type,affiliate_url,url_fingerprint,product_name,product_note,image_url,image_urls_json,media_json,
        product_facts_json,research_source_urls_json,review_evidence_json,research_version,review_count,review_collected_at,
        metadata_status,research_verified,sort_order,status,attempt_count,last_error,researched_at,created_at,updated_at,provider_type
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,0,?,?,?,?,?)`).run(
        id,input.accountId,input.originalInputType,input.affiliateUrl,input.urlFingerprint,input.productName?.trim()||null,
        input.productNote?.trim()??'',storedMedia.imageUrl??null,JSON.stringify(storedMedia.imageUrls),JSON.stringify(storedMedia.media),
        JSON.stringify(input.productFacts??[]),JSON.stringify(input.researchSourceUrls??[]),JSON.stringify(reviewEvidence),
        input.researchVersion??1,input.reviewCount??reviewEvidence.length,input.reviewCollectedAt??null,
        input.metadataStatus,row.next_order,status,input.lastError??null,input.researchedAt??null,now,now,providerType,
      );
      return this.getProductLink(id,input.accountId,providerType)!;
    });
    return create();
  }

  private getProductLink(id:string,accountId:string,providerType:ProductQueueProvider):CoupangProductQueueItem|undefined {
    const row=this.db.raw.prepare(`SELECT q.*,p.body draft_body,p.coupang_reply_body draft_reply_body,
      p.coupang_reply_status draft_reply_status FROM coupang_link_queue q LEFT JOIN posts p ON p.id=q.draft_post_id
      WHERE q.id=? AND q.account_id=? AND q.provider_type=?`).get(id,accountId,providerType);
    return row ? coupangLinkFromRow(row) : undefined;
  }

  private getAnyProductLink(id:string,accountId:string):CoupangProductQueueItem|undefined {
    const row=this.db.raw.prepare(`SELECT q.*,p.body draft_body,p.coupang_reply_body draft_reply_body,
      p.coupang_reply_status draft_reply_status FROM coupang_link_queue q LEFT JOIN posts p ON p.id=q.draft_post_id
      WHERE q.id=? AND q.account_id=?`).get(id,accountId);
    return row ? coupangLinkFromRow(row) : undefined;
  }

  getCoupangLink(id:string,accountId:string):CoupangProductQueueItem|undefined {
    return this.getProductLink(id,accountId,'COUPANG');
  }

  getNaverBrandLink(id:string,accountId:string):CoupangProductQueueItem|undefined { return this.getProductLink(id,accountId,'NAVER_BRAND_CONNECT'); }

  listCoupangLinks(accountId:string):CoupangProductQueueItem[] {
    return this.db.raw.prepare(`SELECT q.*,p.body draft_body,p.coupang_reply_body draft_reply_body,
      p.coupang_reply_status draft_reply_status FROM coupang_link_queue q LEFT JOIN posts p ON p.id=q.draft_post_id
      WHERE q.account_id=? AND q.provider_type='COUPANG' ORDER BY q.sort_order,q.created_at,q.id`)
      .all(accountId).map(coupangLinkFromRow);
  }

  listNaverBrandLinks(accountId:string):CoupangProductQueueItem[] {
    return this.db.raw.prepare(`SELECT q.*,p.body draft_body,p.coupang_reply_body draft_reply_body,
      p.coupang_reply_status draft_reply_status FROM coupang_link_queue q LEFT JOIN posts p ON p.id=q.draft_post_id
      WHERE q.account_id=? AND q.provider_type='NAVER_BRAND_CONNECT' ORDER BY q.sort_order,q.created_at,q.id`)
      .all(accountId).map(coupangLinkFromRow);
  }

  listPendingCoupangLinks(accountId:string):CoupangProductQueueItem[] {
    return this.db.raw.prepare(`SELECT q.*,p.body draft_body,p.coupang_reply_body draft_reply_body,
      p.coupang_reply_status draft_reply_status FROM coupang_link_queue q LEFT JOIN posts p ON p.id=q.draft_post_id
      WHERE q.account_id=? AND q.provider_type='COUPANG' AND q.status NOT IN ('COMPLETED','FAILED') ORDER BY q.sort_order,q.created_at,q.id`)
      .all(accountId).map(coupangLinkFromRow);
  }

  listPendingNaverBrandLinks(accountId:string):CoupangProductQueueItem[] {
    return this.db.raw.prepare(`SELECT q.*,p.body draft_body,p.coupang_reply_body draft_reply_body,
      p.coupang_reply_status draft_reply_status FROM coupang_link_queue q LEFT JOIN posts p ON p.id=q.draft_post_id
      WHERE q.account_id=? AND q.provider_type='NAVER_BRAND_CONNECT' AND q.status NOT IN ('COMPLETED','FAILED') ORDER BY q.sort_order,q.created_at,q.id`)
      .all(accountId).map(coupangLinkFromRow);
  }

  updatePreparedCoupangCopy(id:string,accountId:string,body:string,expectedUpdatedAt:string):CoupangProductQueueItem {
    const update=this.db.raw.transaction(()=>{
      const current=this.getCoupangLink(id,accountId);
      if(!current)throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
      if(current.status!=='PREVIEW_READY'||!current.draftPostId)throw new Error('발행 준비가 완료된 쿠팡 초안만 수정할 수 있습니다.');
      if(current.updatedAt!==expectedUpdatedAt)throw new Error('다른 작업에서 초안이 변경되었습니다. 목록을 새로고침한 뒤 다시 수정하세요.');
      const post:any=this.db.raw.prepare('SELECT id,threads_post_id FROM posts WHERE id=? AND account_id=?').get(current.draftPostId,accountId);
      if(!post||post.threads_post_id)throw new Error('이미 발행됐거나 이 계정의 준비본이 아닌 초안은 수정할 수 없습니다.');
      const submittedBody=formatThreadsPostText(body);
      if(!submittedBody)throw new Error('최종 발행 본문을 입력하세요.');
      const normalizedBody=composeCoupangPost(coupangCreativeFromStoredBody(submittedBody,current.affiliateUrl),current.affiliateUrl);
      const now=new Date().toISOString();
      this.db.raw.prepare(`UPDATE posts SET body=?,coupang_reply_body=NULL,coupang_reply_id=NULL,coupang_reply_status='NONE',
        coupang_reply_error=NULL,coupang_reply_published_at=NULL,coupang_reply_deleted_at=NULL
        WHERE id=? AND account_id=? AND threads_post_id IS NULL`)
        .run(normalizedBody,current.draftPostId,accountId);
      this.db.raw.prepare('UPDATE coupang_link_queue SET updated_at=? WHERE id=? AND account_id=? AND updated_at=?')
        .run(now,id,accountId,expectedUpdatedAt);
      return this.getCoupangLink(id,accountId)!;
    });
    return update();
  }

  updatePreparedNaverBrandCopy(id:string,accountId:string,body:string,expectedUpdatedAt:string):CoupangProductQueueItem {
    const update=this.db.raw.transaction(()=>{
      const current=this.getNaverBrandLink(id,accountId);
      if(!current)throw new Error('네이버 브랜드 커넥트 상품 링크를 찾을 수 없습니다.');
      if(current.status!=='PREVIEW_READY'||!current.draftPostId)throw new Error('발행 준비가 완료된 네이버 브랜드 커넥트 초안만 수정할 수 있습니다.');
      if(current.updatedAt!==expectedUpdatedAt)throw new Error('다른 작업에서 초안이 변경되었습니다. 목록을 새로고침한 뒤 다시 수정하세요.');
      const post:any=this.db.raw.prepare('SELECT id,threads_post_id FROM posts WHERE id=? AND account_id=?').get(current.draftPostId,accountId);
      if(!post||post.threads_post_id)throw new Error('이미 발행됐거나 이 계정의 준비본이 아닌 초안은 수정할 수 없습니다.');
      const normalizedBody=composeNaverBrandPost(naverBrandCreativeFromStoredBody(formatThreadsPostText(body),current.affiliateUrl),current.affiliateUrl,current.productFacts.includes('connectType=TRAVEL')?'TRAVEL':'SHOPPING');
      const now=new Date().toISOString();
      this.db.raw.prepare(`UPDATE posts SET body=?,coupang_reply_body=NULL,coupang_reply_id=NULL,coupang_reply_status='NONE',
        coupang_reply_error=NULL,coupang_reply_published_at=NULL,coupang_reply_deleted_at=NULL
        WHERE id=? AND account_id=? AND threads_post_id IS NULL`).run(normalizedBody,current.draftPostId,accountId);
      this.db.raw.prepare('UPDATE coupang_link_queue SET updated_at=? WHERE id=? AND account_id=? AND updated_at=?')
        .run(now,id,accountId,expectedUpdatedAt);
      return this.getNaverBrandLink(id,accountId)!;
    });
    return update();
  }

  migratePreparedCoupangPostBody(postId:string,accountId:string,body:string):PostRecord {
    const normalizedBody=formatThreadsPostText(body);
    const changed=this.db.raw.prepare(`UPDATE posts SET body=?,coupang_reply_body=NULL,coupang_reply_id=NULL,coupang_reply_status='NONE',
      coupang_reply_error=NULL,coupang_reply_published_at=NULL,coupang_reply_deleted_at=NULL
      WHERE id=? AND account_id=? AND source_type='COUPANG' AND threads_post_id IS NULL`)
      .run(normalizedBody,postId,accountId).changes;
    if(!changed)throw new Error('이전 쿠팡 준비본을 새 단일 본문 형식으로 전환할 수 없습니다.');
    return this.getPost(postId)!;
  }

  migratePreparedNaverBrandPostBody(postId:string,accountId:string,body:string):PostRecord {
    const normalizedBody=formatThreadsPostText(body);
    const changed=this.db.raw.prepare(`UPDATE posts SET body=?,coupang_reply_body=NULL,coupang_reply_id=NULL,coupang_reply_status='NONE',
      coupang_reply_error=NULL,coupang_reply_published_at=NULL,coupang_reply_deleted_at=NULL
      WHERE id=? AND account_id=? AND source_type='NAVER_BRAND_CONNECT' AND threads_post_id IS NULL`)
      .run(normalizedBody,postId,accountId).changes;
    if(!changed)throw new Error('네이버 브랜드 커넥트 준비본을 새 단일 본문 형식으로 전환할 수 없습니다.');
    return this.getPost(postId)!;
  }

  removePreparedCoupangImage(id:string,accountId:string,imageUrl:string,expectedUpdatedAt:string):CoupangProductQueueItem {
    const remove=this.db.raw.transaction(()=>{
      const current=this.getAnyProductLink(id,accountId);
      if(!current)throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
      if(current.status!=='PREVIEW_READY'||!current.draftPostId||!current.activeSourceId)throw new Error('발행 준비가 완료된 쿠팡 초안의 이미지만 삭제할 수 있습니다.');
      if(current.updatedAt!==expectedUpdatedAt)throw new Error('다른 작업에서 이미지가 변경되었습니다. 목록을 새로고침한 뒤 다시 삭제하세요.');
      if(!current.imageUrls.includes(imageUrl))throw new Error('삭제할 이미지가 현재 발행 목록에 없습니다.');
      if(current.imageUrls.length<=1)throw new Error('Threads 발행에는 상품 이미지가 최소 1장 필요합니다. 마지막 이미지는 삭제할 수 없습니다.');
      const post:any=this.db.raw.prepare('SELECT id,threads_post_id FROM posts WHERE id=? AND account_id=?').get(current.draftPostId,accountId);
      if(!post||post.threads_post_id)throw new Error('이미 발행됐거나 이 계정의 준비본이 아닌 이미지는 삭제할 수 없습니다.');
      const source:any=this.db.raw.prepare('SELECT metadata_json FROM sources WHERE id=? AND account_id=?').get(current.activeSourceId,accountId);
      if(!source)throw new Error('상품 근거와 연결된 이미지 정보를 찾을 수 없습니다.');
      const stored=normalizedMedia({
        imageUrls:current.imageUrls.filter((url)=>url!==imageUrl),
        media:current.media.filter((asset)=>asset.url!==imageUrl),
      });
      const sourceMetadata=json<Record<string,unknown>>(source.metadata_json,{});
      const now=new Date().toISOString();
      this.db.raw.prepare('UPDATE coupang_link_queue SET image_url=?,image_urls_json=?,media_json=?,updated_at=? WHERE id=? AND account_id=? AND updated_at=?')
        .run(stored.imageUrl??null,JSON.stringify(stored.imageUrls),JSON.stringify(stored.media),now,id,accountId,expectedUpdatedAt);
      this.db.raw.prepare('UPDATE posts SET image_url=?,image_urls_json=?,media_json=? WHERE id=? AND account_id=? AND threads_post_id IS NULL')
        .run(stored.imageUrl??null,JSON.stringify(stored.imageUrls),JSON.stringify(stored.media),current.draftPostId,accountId);
      this.db.raw.prepare('UPDATE sources SET metadata_json=? WHERE id=? AND account_id=?')
        .run(JSON.stringify({...sourceMetadata,imageUrl:stored.imageUrl,imageUrls:stored.imageUrls,media:stored.media}),current.activeSourceId,accountId);
      return this.getAnyProductLink(id,accountId)!;
    });
    return remove();
  }

  updateCoupangLinkDetails(id:string,accountId:string,patch:{productName?:string;productNote?:string;imageUrl?:string|null;imageUrls?:string[]|null;media?:MediaAsset[]|null;productFacts?:string[];reviewEvidence?:CoupangReviewEvidence[];researchVersion?:number;reviewCount?:number;reviewCollectedAt?:string|null}):CoupangProductQueueItem {
    const current=this.getAnyProductLink(id,accountId);
    if (!current) throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
    const productName=patch.productName===undefined ? current.productName : patch.productName.trim()||undefined;
    const productFacts=patch.productFacts ?? current.productFacts;
    const mediaChanged=patch.imageUrl!==undefined||patch.imageUrls!==undefined||patch.media!==undefined;
    const storedMedia=mediaChanged ? normalizedMedia({imageUrl:patch.imageUrl,imageUrls:patch.imageUrls,media:patch.media}) : current;
    const reviewEvidence=patch.reviewEvidence===undefined ? current.reviewEvidence : normalizedReviewEvidence(patch.reviewEvidence);
    const metadataStatus:CoupangMetadataStatus=productName ? 'READY' : 'INFORMATION_REQUIRED';
    const status:CoupangLinkQueueStatus=current.status==='INFORMATION_REQUIRED'&&metadataStatus==='READY' ? 'QUEUED'
      : current.status==='QUEUED'&&metadataStatus!=='READY' ? 'INFORMATION_REQUIRED' : current.status;
    this.db.raw.prepare(`UPDATE coupang_link_queue SET product_name=?,product_note=?,image_url=?,image_urls_json=?,media_json=?,product_facts_json=?,
      review_evidence_json=?,research_version=?,review_count=?,review_collected_at=?,metadata_status=?,research_verified=0,status=?,
      last_error=CASE WHEN ?='READY' THEN NULL ELSE last_error END,updated_at=? WHERE id=? AND account_id=?`).run(
      productName??null,patch.productNote===undefined?current.productNote:patch.productNote.trim(),
      storedMedia.imageUrl??null,JSON.stringify(storedMedia.imageUrls),JSON.stringify(storedMedia.media),JSON.stringify(productFacts),
      JSON.stringify(reviewEvidence),patch.researchVersion??current.researchVersion,
      patch.reviewCount??(patch.reviewEvidence===undefined?current.reviewCount:reviewEvidence.length),
      patch.reviewCollectedAt===undefined?current.reviewCollectedAt??null:patch.reviewCollectedAt,metadataStatus,status,metadataStatus,
      new Date().toISOString(),id,accountId,
    );
    return this.getAnyProductLink(id,accountId)!;
  }

  applyCoupangLinkResearch(id:string,accountId:string,research:{affiliateUrl:string;urlFingerprint:string;productName?:string;imageUrl?:string;imageUrls?:string[];media?:MediaAsset[];productFacts:string[];researchSourceUrls:string[];reviewEvidence?:CoupangReviewEvidence[];researchVersion?:number;reviewCount?:number;reviewCollectedAt?:string;metadataStatus:CoupangMetadataStatus;researchedAt:string;lastError?:string}):CoupangProductQueueItem {
    const current=this.getAnyProductLink(id,accountId);
    if (!current) throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
    if (current.status==='PROCESSING'||current.status==='COMPLETED') throw new Error('처리 중이거나 완료된 쿠팡 상품 정보는 변경할 수 없습니다.');
    const mediaChanged=research.imageUrl!==undefined||research.imageUrls!==undefined||research.media!==undefined;
    const storedMedia=mediaChanged ? normalizedMedia(research) : current;
    const reviewEvidence=research.reviewEvidence===undefined ? current.reviewEvidence : normalizedReviewEvidence(research.reviewEvidence);
    const status:CoupangLinkQueueStatus=research.metadataStatus==='READY' ? 'QUEUED'
      : research.metadataStatus==='FAILED' ? 'REVIEW_REQUIRED' : 'INFORMATION_REQUIRED';
    this.db.raw.prepare(`UPDATE coupang_link_queue SET affiliate_url=?,url_fingerprint=?,product_name=?,image_url=?,image_urls_json=?,media_json=?,
      product_facts_json=?,research_source_urls_json=?,review_evidence_json=?,research_version=?,review_count=?,review_collected_at=?,
      metadata_status=?,research_verified=0,status=?,researched_at=?,last_error=?,updated_at=?
      WHERE id=? AND account_id=?`).run(
      research.affiliateUrl,research.urlFingerprint,research.productName?.trim()||null,storedMedia.imageUrl??null,
      JSON.stringify(storedMedia.imageUrls),JSON.stringify(storedMedia.media),JSON.stringify(research.productFacts),JSON.stringify(research.researchSourceUrls),
      JSON.stringify(reviewEvidence),research.researchVersion??current.researchVersion,
      research.reviewCount??(research.reviewEvidence===undefined?current.reviewCount:reviewEvidence.length),
      research.reviewCollectedAt??current.reviewCollectedAt??null,research.metadataStatus,status,
      research.researchedAt,research.lastError??null,new Date().toISOString(),id,accountId,
    );
    return this.getAnyProductLink(id,accountId)!;
  }

  updateCoupangLinkResearch(id:string,accountId:string,research:{productName?:string;imageUrl?:string|null;imageUrls?:string[]|null;media?:MediaAsset[]|null;productFacts:string[];researchSourceUrls:string[];reviewEvidence?:CoupangReviewEvidence[];researchVersion?:number;reviewCount?:number;reviewCollectedAt?:string|null;researchedAt:string;lastError?:string|null}):CoupangProductQueueItem {
    const current=this.getAnyProductLink(id,accountId);
    if (!current) throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
    if (current.status==='COMPLETED') throw new Error('완료된 쿠팡 상품 정보는 변경할 수 없습니다.');
    const productName=research.productName?.trim()||current.productName;
    if (!productName) throw new Error('Agent 조사 결과에 상품명이 없어 검증 완료로 저장할 수 없습니다.');
    const productFacts=[...new Set(research.productFacts.map((fact)=>fact.trim()).filter(Boolean))];
    const researchSourceUrls=[...new Set(research.researchSourceUrls.map((url)=>url.trim()).filter((url)=>{
      try{return new URL(url).protocol==='https:';}catch{return false;}
    }))];
    const mediaChanged=research.imageUrl!==undefined||research.imageUrls!==undefined||research.media!==undefined;
    const storedMedia=mediaChanged ? normalizedMedia({imageUrl:research.imageUrl,imageUrls:research.imageUrls,media:research.media}) : current;
    const reviewEvidence=research.reviewEvidence===undefined ? current.reviewEvidence : normalizedReviewEvidence(research.reviewEvidence);
    if (!productFacts.length||!researchSourceUrls.length) throw new Error('Agent 조사 결과에 검증된 상품 사실과 HTTPS 근거가 모두 필요합니다.');
    const metadataStatus:CoupangMetadataStatus=productName ? 'READY' : 'INFORMATION_REQUIRED';
    const status:CoupangLinkQueueStatus=current.status==='PROCESSING' ? 'PROCESSING'
      : metadataStatus==='READY' ? 'QUEUED' : 'INFORMATION_REQUIRED';
    this.db.raw.prepare(`UPDATE coupang_link_queue SET product_name=?,image_url=?,image_urls_json=?,media_json=?,product_facts_json=?,research_source_urls_json=?,
      review_evidence_json=?,research_version=?,review_count=?,review_collected_at=?,metadata_status=?,research_verified=1,status=?,researched_at=?,last_error=?,updated_at=? WHERE id=? AND account_id=?`).run(
      productName??null,storedMedia.imageUrl??null,JSON.stringify(storedMedia.imageUrls),JSON.stringify(storedMedia.media),JSON.stringify(productFacts),
      JSON.stringify(researchSourceUrls),JSON.stringify(reviewEvidence),research.researchVersion??current.researchVersion,
      research.reviewCount??(research.reviewEvidence===undefined?current.reviewCount:reviewEvidence.length),
      research.reviewCollectedAt===undefined?current.reviewCollectedAt??null:research.reviewCollectedAt,
      metadataStatus,status,research.researchedAt,research.lastError??null,
      new Date().toISOString(),id,accountId,
    );
    return this.getAnyProductLink(id,accountId)!;
  }

  reorderCoupangLink(id:string,accountId:string,sortOrder:number):CoupangProductQueueItem {
    if (!Number.isSafeInteger(sortOrder)||sortOrder<0) throw new Error('쿠팡 상품 순서는 0 이상의 정수여야 합니다.');
    const result=this.db.raw.prepare('UPDATE coupang_link_queue SET sort_order=?,updated_at=? WHERE id=? AND account_id=?')
      .run(sortOrder,new Date().toISOString(),id,accountId);
    if (!result.changes) throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
    return this.getAnyProductLink(id,accountId)!;
  }

  deleteCoupangLink(id:string,accountId:string):boolean {
    return this.db.raw.prepare("DELETE FROM coupang_link_queue WHERE id=? AND account_id=? AND status NOT IN ('PROCESSING','COMPLETED')")
      .run(id,accountId).changes===1;
  }

  abortNewCoupangRegistration(id:string,accountId:string):boolean {
    const abort=this.db.raw.transaction(()=>{
      const current=this.getAnyProductLink(id,accountId);
      if(!current||current.status==='COMPLETED')return false;
      const post=current.draftPostId?this.getPost(current.draftPostId):undefined;
      if(post?.threadsPostId)return false;
      const sourceId=current.activeSourceId;
      const postId=current.draftPostId;
      const removed=this.db.raw.prepare("DELETE FROM coupang_link_queue WHERE id=? AND account_id=? AND status<>'COMPLETED'").run(id,accountId).changes===1;
      if(!removed)return false;
      if(postId)this.db.raw.prepare('DELETE FROM posts WHERE id=? AND account_id=? AND threads_post_id IS NULL').run(postId,accountId);
      if(sourceId)this.db.raw.prepare("UPDATE sources SET status='DONE',processed_at=? WHERE id=? AND account_id=? AND threads_post_id IS NULL")
        .run(new Date().toISOString(),sourceId,accountId);
      return true;
    });
    return abort();
  }

  consumeCoupangLinkAfterPublishFailure(id:string,accountId:string,activeRunId:string):boolean {
    return this.db.raw.prepare(`DELETE FROM coupang_link_queue
      WHERE id=? AND account_id=? AND status='PROCESSING' AND active_run_id=? AND draft_post_id IS NOT NULL`)
      .run(id,accountId,activeRunId).changes===1;
  }

  claimNextCoupangLink(accountId:string,activeRunId?:string):CoupangProductQueueItem|undefined {
    return this.claimNextProductLink(accountId,'COUPANG',activeRunId);
  }

  claimNextNaverBrandLink(accountId:string,activeRunId?:string):CoupangProductQueueItem|undefined {
    return this.claimNextProductLink(accountId,'NAVER_BRAND_CONNECT',activeRunId);
  }

  private claimNextProductLink(accountId:string,providerType:ProductQueueProvider,activeRunId?:string):CoupangProductQueueItem|undefined {
    const claim=this.db.raw.transaction(()=>{
      const row:any=this.db.raw.prepare(`SELECT id FROM coupang_link_queue
        WHERE account_id=? AND provider_type=? AND status='QUEUED' AND metadata_status='READY'
        ORDER BY sort_order,created_at,id LIMIT 1`).get(accountId,providerType);
      if (!row) return undefined;
      const now=new Date().toISOString();
      const updated=this.db.raw.prepare(`UPDATE coupang_link_queue SET status='PROCESSING',attempt_count=attempt_count+1,
        active_run_id=?,claimed_at=?,last_error=NULL,updated_at=? WHERE id=? AND status='QUEUED' AND metadata_status='READY'
        `)
        .run(activeRunId??null,now,now,row.id);
      return updated.changes ? this.getProductLink(row.id,accountId,providerType) : undefined;
    });
    return claim();
  }

  claimCoupangLink(id:string,accountId:string,activeRunId:string):CoupangProductQueueItem|undefined {
    return this.claimProductLink(id,accountId,'COUPANG',activeRunId);
  }

  claimNaverBrandLink(id:string,accountId:string,activeRunId:string):CoupangProductQueueItem|undefined {
    return this.claimProductLink(id,accountId,'NAVER_BRAND_CONNECT',activeRunId);
  }

  private claimProductLink(id:string,accountId:string,providerType:ProductQueueProvider,activeRunId:string):CoupangProductQueueItem|undefined {
    const claim=this.db.raw.transaction(()=>{
      const now=new Date().toISOString();
      const changed=this.db.raw.prepare(`UPDATE coupang_link_queue SET status='PROCESSING',attempt_count=attempt_count+1,
        active_run_id=?,claimed_at=?,last_error=NULL,updated_at=? WHERE id=? AND account_id=? AND provider_type=? AND status='QUEUED' AND metadata_status='READY'`)
        .run(activeRunId,now,now,id,accountId,providerType).changes;
      return changed ? this.getProductLink(id,accountId,providerType) : undefined;
    });
    return claim();
  }

  claimNextPreparedCoupangLink(accountId:string,activeRunId:string):CoupangProductQueueItem|undefined {
    return this.claimNextPreparedProductLink(accountId,'COUPANG',activeRunId);
  }

  claimNextPreparedNaverBrandLink(accountId:string,activeRunId:string):CoupangProductQueueItem|undefined {
    return this.claimNextPreparedProductLink(accountId,'NAVER_BRAND_CONNECT',activeRunId);
  }

  private claimNextPreparedProductLink(accountId:string,providerType:ProductQueueProvider,activeRunId:string):CoupangProductQueueItem|undefined {
    const claim=this.db.raw.transaction(()=>{
      const row:any=this.db.raw.prepare(`SELECT q.id FROM coupang_link_queue q
        JOIN posts p ON p.id=q.draft_post_id AND p.account_id=q.account_id
        JOIN sources s ON s.id=q.active_source_id AND s.account_id=q.account_id
        WHERE q.account_id=? AND q.provider_type=? AND q.status='PREVIEW_READY' AND p.threads_post_id IS NULL
          AND TRIM(p.body)<>''
          AND (COALESCE(p.image_url,'')<>'' OR COALESCE(p.image_urls_json,'[]')<>'[]')
        ORDER BY q.sort_order,q.created_at,q.id LIMIT 1`).get(accountId,providerType);
      if(!row)return undefined;
      const now=new Date().toISOString();
      const changed=this.db.raw.prepare(`UPDATE coupang_link_queue SET status='PROCESSING',active_run_id=?,last_error=NULL,updated_at=?
        WHERE id=? AND account_id=? AND status='PREVIEW_READY'`).run(activeRunId,now,row.id,accountId).changes;
      return changed?this.getProductLink(row.id,accountId,providerType):undefined;
    });
    return claim();
  }

  updateCoupangLinkState(id:string,accountId:string,status:CoupangLinkQueueStatus,patch:CoupangLinkStatePatch={}):CoupangProductQueueItem {
    const transition=this.db.raw.transaction(()=>{
      const current=this.getAnyProductLink(id,accountId);
      if (!current) throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
      const allowed:Record<CoupangLinkQueueStatus,CoupangLinkQueueStatus[]>={
        INFORMATION_REQUIRED:['QUEUED','FAILED'], QUEUED:['PROCESSING','INFORMATION_REQUIRED','FAILED'],
        PROCESSING:['QUEUED','PREVIEW_READY','REVIEW_REQUIRED','COMPLETED','FAILED'],
        PREVIEW_READY:['PROCESSING','REVIEW_REQUIRED','COMPLETED','FAILED','QUEUED'],
        REVIEW_REQUIRED:['QUEUED','FAILED'], COMPLETED:[], FAILED:['QUEUED','REVIEW_REQUIRED'],
      };
      if (status!==current.status&&!allowed[current.status].includes(status)) throw new Error(`${current.status} 상태에서 ${status} 상태로 변경할 수 없습니다.`);
      if (status==='QUEUED'&&current.metadataStatus!=='READY') throw new Error('상품 정보 조사가 완료되지 않아 대기열에 넣을 수 없습니다.');
      const now=new Date().toISOString();
      const value=<T>(provided:T|undefined,currentValue:T)=>provided===undefined?currentValue:provided;
      const nextSourceId=value(patch.activeSourceId,current.activeSourceId??null);
      const nextDraftPostId=value(patch.draftPostId,current.draftPostId??null);
      if(status==='PREVIEW_READY'){
        if(!nextSourceId||!nextDraftPostId)throw new Error('최종 발행 본문 준비본 연결이 없어 발행 준비 완료로 저장할 수 없습니다.');
        const source:any=this.db.raw.prepare('SELECT id FROM sources WHERE id=? AND account_id=?').get(nextSourceId,accountId);
        const post:any=this.db.raw.prepare(`SELECT body,image_url,image_urls_json,threads_post_id FROM posts
          WHERE id=? AND account_id=?`).get(nextDraftPostId,accountId);
        const postImages=post?json<string[]>(post.image_urls_json,[]):[];
        if(!source||!post||post.threads_post_id||!String(post.body??'').trim()
          ||(!String(post.image_url??'').trim()&&postImages.length===0)){
          throw new Error('이미지와 최종 발행 본문이 연결된 미발행 준비본만 발행 준비 완료로 저장할 수 있습니다.');
        }
      }
      this.db.raw.prepare(`UPDATE coupang_link_queue SET status=?,active_source_id=?,draft_post_id=?,active_run_id=?,last_error=?,
        claimed_at=?,previewed_at=?,completed_at=?,updated_at=? WHERE id=? AND account_id=?`).run(
        status,nextSourceId,nextDraftPostId,
        value(patch.activeRunId,current.activeRunId??null),status==='QUEUED'?null:value(patch.lastError,current.lastError??null),
        status==='QUEUED'?null:current.claimedAt??null,status==='PREVIEW_READY'?now:current.previewedAt??null,
        status==='COMPLETED'?now:current.completedAt??null,now,id,accountId,
      );
      return this.getAnyProductLink(id,accountId)!;
    });
    return transition();
  }

  retryCoupangLink(id:string,accountId:string):CoupangProductQueueItem {
    const current=this.getAnyProductLink(id,accountId);
    if (!current||!['FAILED','REVIEW_REQUIRED','PREVIEW_READY'].includes(current.status)) throw new Error('다시 처리할 수 있는 쿠팡 상품이 아닙니다.');
    if(current.metadataStatus!=='READY'){
      const now=new Date().toISOString();
      this.db.raw.prepare(`UPDATE coupang_link_queue SET active_source_id=NULL,draft_post_id=NULL,active_run_id=NULL,
        last_error=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND account_id=?`).run(now,id,accountId);
      return this.getAnyProductLink(id,accountId)!;
    }
    return this.updateCoupangLinkState(id,accountId,'QUEUED',{activeSourceId:null,draftPostId:null,activeRunId:null,lastError:null});
  }

  coupangLinkSummary(accountId:string):CoupangProductQueueSummary {
    return this.productLinkSummary(accountId,'COUPANG');
  }

  naverBrandLinkSummary(accountId:string):CoupangProductQueueSummary {
    return this.productLinkSummary(accountId,'NAVER_BRAND_CONNECT');
  }

  private productLinkSummary(accountId:string,providerType:ProductQueueProvider):CoupangProductQueueSummary {
    const byStatus=Object.fromEntries(COUPANG_LINK_QUEUE_STATUSES.map((status)=>[status,0])) as Record<CoupangLinkQueueStatus,number>;
    const rows=this.db.raw.prepare('SELECT status,COUNT(*) count FROM coupang_link_queue WHERE account_id=? AND provider_type=? GROUP BY status').all(accountId,providerType) as Array<{status:CoupangLinkQueueStatus;count:number}>;
    rows.forEach((row)=>{byStatus[row.status]=row.count;});
    const metadata:any=this.db.raw.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN metadata_status='READY' THEN 1 ELSE 0 END) ready FROM coupang_link_queue WHERE account_id=? AND provider_type=?`).get(accountId,providerType);
    return {total:Number(metadata.total),byStatus,metadataReady:Number(metadata.ready??0),metadataAttention:Number(metadata.total)-Number(metadata.ready??0)};
  }

  disableAutomationTarget(accountId: string): void {
    this.db.raw.prepare('UPDATE accounts SET automation_target=0, updated_at=? WHERE id=?').run(new Date().toISOString(), accountId);
  }

  cancelPendingThreadsJobs(accountId: string): number {
    return this.db.raw.prepare(`UPDATE jobs SET status='CANCELLED',last_error='Threads 토큰이 삭제되어 작업을 취소했습니다.',updated_at=?
      WHERE account_id=? AND status='PENDING' AND kind IN ('PUBLISH','COMMENTS','INSIGHTS')`)
      .run(new Date().toISOString(), accountId).changes;
  }

  cancelPendingScheduledJobs(accountId?: string, reason = SCHEDULE_REBUILD_REASON): number {
    const accountFilter = accountId ? ' AND account_id=?' : '';
    const statement = this.db.raw.prepare(`UPDATE jobs SET status='CANCELLED',last_error=?,updated_at=?
      WHERE status='PENDING' AND kind IN ('PUBLISH','COMMENTS','INSIGHTS','COUPANG_REPORT')${accountFilter}`);
    return accountId
      ? statement.run(reason, new Date().toISOString(), accountId).changes
      : statement.run(reason, new Date().toISOString()).changes;
  }

  storeSource(candidate: SourceCandidate): string {
    const storedMedia=normalizedMedia(candidate);
    this.db.raw.prepare(`INSERT OR IGNORE INTO sources(id,account_id,source_type,source_key,source_url,published_at,status,metadata_json,created_at)
      VALUES(?,?,?,?,?,?,'PENDING',?,?)`).run(candidate.id, candidate.accountId, candidate.sourceType, candidate.sourceKey,
      candidate.sourceUrl, candidate.publishedAt ?? null, JSON.stringify({ ...candidate.metadata, title:candidate.title, summary:candidate.summary,
        imageUrl:storedMedia.imageUrl, imageUrls:storedMedia.imageUrls, media:storedMedia.media,
        reviewEvidence:candidate.reviewEvidence, researchVersion:candidate.researchVersion,
        reviewCount:candidate.reviewCount, reviewCollectedAt:candidate.reviewCollectedAt }), new Date().toISOString());
    const stored=this.db.raw.prepare('SELECT id FROM sources WHERE account_id=? AND source_type=? AND source_key=?')
      .get(candidate.accountId,candidate.sourceType,candidate.sourceKey) as {id:string};
    return stored.id;
  }

  getSourceCandidate(id:string,accountId:string):SourceCandidate|undefined {
    const row:any=this.db.raw.prepare('SELECT * FROM sources WHERE id=? AND account_id=?').get(id,accountId);
    if(!row)return undefined;
    const metadata=json<Record<string,unknown>>(row.metadata_json,{});
    const storedMedia=normalizedMedia({imageUrl:typeof metadata.imageUrl==='string'?metadata.imageUrl:undefined,
      imageUrls:Array.isArray(metadata.imageUrls)?metadata.imageUrls.filter((value):value is string=>typeof value==='string'):undefined,
      media:Array.isArray(metadata.media)?metadata.media as MediaAsset[]:undefined});
    const reviewEvidence=Array.isArray(metadata.reviewEvidence)?normalizedReviewEvidence(metadata.reviewEvidence as CoupangReviewEvidence[]):undefined;
    return {id:row.id,accountId:row.account_id,sourceType:row.source_type,sourceKey:row.source_key,
      sourceUrl:row.source_url,publishedAt:row.published_at??undefined,title:String(metadata.title??''),
      summary:typeof metadata.summary==='string'?metadata.summary:undefined,
      imageUrl:storedMedia.imageUrl,imageUrls:storedMedia.imageUrls,media:storedMedia.media,reviewEvidence,
      researchVersion:typeof metadata.researchVersion==='number'?metadata.researchVersion:undefined,
      reviewCount:typeof metadata.reviewCount==='number'?metadata.reviewCount:reviewEvidence?.length,
      reviewCollectedAt:typeof metadata.reviewCollectedAt==='string'?metadata.reviewCollectedAt:undefined,metadata};
  }

  pendingSourceCandidates(accountId:string,type:Exclude<SourceType,'DAILY'>,limit=20):SourceCandidate[] {
    const rows=this.db.raw.prepare(`SELECT s.id,s.status FROM sources s
      WHERE s.account_id=? AND s.source_type=? AND (
        s.status='PENDING' OR (s.status='DONE' AND s.threads_post_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM posts p WHERE p.source_id=s.id))
      ) ORDER BY COALESCE(s.published_at,s.created_at),s.created_at,s.id LIMIT ?`)
      .all(accountId,type,limit) as Array<{id:string;status:string}>;
    const orphaned=rows.filter((row)=>row.status==='DONE').map((row)=>row.id);
    if(orphaned.length){
      const revive=this.db.raw.prepare("UPDATE sources SET status='PENDING',processed_at=NULL WHERE id=? AND account_id=? AND status='DONE'");
      this.db.raw.transaction(()=>{for(const id of orphaned)revive.run(id,accountId);})();
    }
    return rows.map((row)=>this.getSourceCandidate(row.id,accountId)).filter((candidate):candidate is SourceCandidate=>Boolean(candidate));
  }

  markSourceDone(id: string, threadsPostId?: string): void {
    this.db.raw.prepare("UPDATE sources SET status='DONE',threads_post_id=?,processed_at=? WHERE id=?").run(threadsPostId ?? null, new Date().toISOString(), id);
  }

  recentPromotionSources(accountId: string, limit = 30): Array<{ sourceType: SourceType; sourceKey: string; status: string; metadata: Record<string, unknown>; processedAt?: string }> {
    return this.db.raw.prepare(`SELECT source_type,source_key,status,metadata_json,processed_at FROM sources
      WHERE account_id=? ORDER BY COALESCE(processed_at,created_at) DESC LIMIT ?`).all(accountId, limit).map((row: any) => ({
        sourceType: row.source_type, sourceKey: row.source_key, status: row.status,
        metadata: json(row.metadata_json, {}), processedAt: row.processed_at ?? undefined,
      }));
  }

  recentContentForAgent(accountId: string, limit = 20, includeDrafts = false): Array<{ id: string; sourceType: SourceType; body: string; publishedAt?: string }> {
    return this.db.raw.prepare('SELECT id,source_type,body,published_at FROM posts WHERE account_id=? AND (threads_post_id IS NOT NULL OR ?=1) ORDER BY created_at DESC LIMIT ?').all(accountId, Number(includeDrafts), limit)
      .map((row: any) => ({ id: row.id, sourceType: row.source_type, body: row.body, publishedAt: row.published_at ?? undefined }));
  }

  sourceTypes(accountId: string, limit = 20): SourceType[] {
    return this.db.raw.prepare('SELECT source_type FROM posts WHERE account_id=? AND threads_post_id IS NOT NULL ORDER BY created_at DESC LIMIT ?').all(accountId, limit).map((row: any) => row.source_type);
  }

  successfulPublicationScheduleHistory(accountId:string,localDate:string):{daily:number;promotion:number;today:number} {
    const row=this.db.raw.prepare(`SELECT
      SUM(CASE WHEN source_type='DAILY' THEN 1 ELSE 0 END) daily,
      SUM(CASE WHEN source_type<>'DAILY' THEN 1 ELSE 0 END) promotion,
      SUM(CASE WHEN date(published_at,'localtime')=? THEN 1 ELSE 0 END) today
      FROM posts WHERE account_id=? AND threads_post_id IS NOT NULL AND remote_deleted_at IS NULL`).get(localDate,accountId) as {daily:number|null;promotion:number|null;today:number|null};
    return {daily:Number(row.daily??0),promotion:Number(row.promotion??0),today:Number(row.today??0)};
  }

  enqueueJob(job: Omit<JobRecord, 'status' | 'attempt'>, options: { reviveUserCancelledPublish?:boolean } = {}): boolean {
    const now = new Date().toISOString();
    const current=this.getJob(job.id);
    const preservePromotionOverride=job.kind==='PUBLISH'&&job.payload.contentMode==='PROMOTION'
      &&current?.payload.contentMode==='PROMOTION'&&current.payload.sourceTypeLocked===true
      &&['BLOG','YOUTUBE','COUPANG'].includes(String(current.payload.sourceType));
    const payload=preservePromotionOverride
      ? {...job.payload,sourceType:current!.payload.sourceType,sourceTypeLocked:true}
      : job.payload;
    const result = this.db.raw.prepare(`
      INSERT INTO jobs(id, account_id, kind, status, run_at, attempt, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, 'PENDING', ?, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status='PENDING',run_at=excluded.run_at,attempt=0,payload_json=excluded.payload_json,
        last_error=NULL,updated_at=excluded.updated_at
      WHERE (jobs.status='CANCELLED' AND jobs.last_error IN (?,?,?))
        OR (jobs.status='PENDING' AND (jobs.run_at<>excluded.run_at OR jobs.payload_json<>excluded.payload_json))
        OR (?=1 AND jobs.kind='PUBLISH' AND jobs.status='CANCELLED' AND jobs.last_error='사용자가 예정 Job을 취소했습니다.')
    `).run(job.id, job.accountId, job.kind, job.runAt, JSON.stringify(payload), now, now,
      PROGRAM_EXIT_CANCELLATION_REASON,SCHEDULE_REBUILD_REASON,GLOBAL_AUTOMATION_STOP_REASON,
      options.reviveUserCancelledPublish ? 1 : 0);
    return result.changes === 1;
  }

  getJob(id:string):JobRecord|undefined {
    const row:any=this.db.raw.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    return row ? {id:row.id,accountId:row.account_id,kind:row.kind,status:row.status,runAt:row.run_at,
      attempt:row.attempt,payload:json(row.payload_json,{}),lastError:row.last_error??undefined} : undefined;
  }

  updatePendingPromotionSource(jobId:string,accountId:string,sourceType:Exclude<SourceType,'DAILY'>):JobRecord {
    const current=this.getJob(jobId);
    if(!current||current.accountId!==accountId)throw new Error('변경할 예정 작업을 찾을 수 없습니다.');
    if(current.status!=='PENDING'||current.kind!=='PUBLISH'||current.payload.contentMode!=='PROMOTION')throw new Error('대기 중인 홍보 발행 예약만 변경할 수 있습니다.');
    const payload={...current.payload,sourceType,sourceTypeLocked:true};
    const changed=this.db.raw.prepare("UPDATE jobs SET payload_json=?,updated_at=? WHERE id=? AND account_id=? AND status='PENDING'")
      .run(JSON.stringify(payload),new Date().toISOString(),jobId,accountId).changes;
    if(changed!==1)throw new Error('예약이 이미 실행되었거나 상태가 변경되었습니다. 새로고침 후 다시 확인하세요.');
    return this.getJob(jobId)!;
  }

  claimDueJob(now = new Date().toISOString()): JobRecord | undefined {
    const claim = this.db.raw.transaction(() => {
      const row: any = this.db.raw.prepare("SELECT * FROM jobs WHERE status = 'PENDING' AND run_at <= ? ORDER BY run_at,id LIMIT 1").get(now);
      if (!row) return undefined;
      const updated = this.db.raw.prepare("UPDATE jobs SET status='RUNNING', attempt=attempt+1, updated_at=? WHERE id=? AND status='PENDING'").run(now, row.id);
      if (!updated.changes) return undefined;
      return { id: row.id, accountId: row.account_id, kind: row.kind, status: 'RUNNING', runAt: row.run_at, attempt: row.attempt + 1, payload: json(row.payload_json, {}) } as JobRecord;
    });
    return claim();
  }

  completeJob(id: string, status: 'DONE' | 'FAILED' | 'CANCELLED', lastError?: string): void {
    this.db.raw.prepare('UPDATE jobs SET status=?, last_error=?, updated_at=? WHERE id=?').run(status, lastError ?? null, new Date().toISOString(), id);
  }

  requeueJob(id: string, runAt: string, lastError: string): void {
    this.db.raw.prepare("UPDATE jobs SET status='PENDING', run_at=?, last_error=?, updated_at=? WHERE id=?").run(runAt, lastError, new Date().toISOString(), id);
  }

  pendingJobs(limit = 100): JobRecord[] {
    return this.db.raw.prepare("SELECT * FROM jobs WHERE status='PENDING' ORDER BY run_at LIMIT ?").all(limit).map((row: any) => ({
      id: row.id, accountId: row.account_id, kind: row.kind, status: row.status, runAt: row.run_at,
      attempt: row.attempt, payload: json(row.payload_json, {}), lastError: row.last_error ?? undefined,
    }));
  }

  runningJobs(limit = 20): JobRecord[] {
    return this.db.raw.prepare("SELECT * FROM jobs WHERE status='RUNNING' ORDER BY updated_at DESC LIMIT ?").all(limit).map((row: any) => ({
      id: row.id, accountId: row.account_id, kind: row.kind, status: row.status, runAt: row.run_at,
      attempt: row.attempt, payload: json(row.payload_json, {}), lastError: row.last_error ?? undefined,
    }));
  }

  cancelJob(id: string): boolean {
    return this.db.raw.prepare("UPDATE jobs SET status='CANCELLED',last_error='사용자가 예정 Job을 취소했습니다.',updated_at=? WHERE id=? AND status='PENDING'")
      .run(new Date().toISOString(), id).changes === 1;
  }

  cancelAllActiveWork(): { jobs:number; pipelineRuns:number } {
    const now = new Date().toISOString();
    return this.db.raw.transaction(() => {
      const jobs = this.db.raw.prepare("UPDATE jobs SET status='CANCELLED',last_error='프로그램 종료로 작업이 취소되었습니다.',updated_at=? WHERE status IN ('PENDING','RUNNING')").run(now).changes;
      const pipelineRuns = this.db.raw.prepare("UPDATE pipeline_runs SET status='STOPPED',stage='DONE',progress=100,message='프로그램 종료로 작업이 취소되었습니다.',error_summary='사용자가 프로그램 종료를 확인해 진행 중인 작업을 취소했습니다.',updated_at=?,finished_at=? WHERE status IN ('QUEUED','RUNNING')").run(now, now).changes;
      return { jobs, pipelineRuns };
    })();
  }

  hasExactSource(accountId: string, type: SourceType, key: string): boolean {
    return Boolean(this.db.raw.prepare('SELECT 1 FROM sources WHERE account_id=? AND source_type=? AND source_key=?').get(accountId, type, key));
  }

  savePost(post: PostRecord): void {
    const storedMedia=normalizedMedia(post);
    this.db.raw.prepare(`INSERT INTO posts(id,account_id,source_id,source_type,body,url,image_url,image_urls_json,media_json,threads_post_id,
      coupang_reply_body,coupang_reply_id,coupang_reply_status,coupang_reply_error,coupang_reply_published_at,coupang_reply_deleted_at,
      created_at,published_at)
      VALUES (@id,@accountId,@sourceId,@sourceType,@body,@url,@imageUrl,@imageUrlsJson,@mediaJson,@threadsPostId,
      @coupangReplyBody,@coupangReplyId,@coupangReplyStatus,@coupangReplyError,@coupangReplyPublishedAt,@coupangReplyDeletedAt,
      @createdAt,@publishedAt)`).run({ ...post, body:formatThreadsPostText(post.body), sourceId:post.sourceId ?? null, url:post.url ?? null, imageUrl:storedMedia.imageUrl ?? null,
        imageUrlsJson:JSON.stringify(storedMedia.imageUrls),mediaJson:JSON.stringify(storedMedia.media),
        threadsPostId:post.threadsPostId ?? null, coupangReplyBody:post.coupangReplyBody ?? null,
        coupangReplyId:post.coupangReplyId ?? null, coupangReplyStatus:post.coupangReplyStatus ?? 'NONE',
        coupangReplyError:post.coupangReplyError ?? null, coupangReplyPublishedAt:post.coupangReplyPublishedAt ?? null,
        coupangReplyDeletedAt:post.coupangReplyDeletedAt ?? null, publishedAt:post.publishedAt ?? null });
  }

  updateUnpublishedPostBody(postId:string,accountId:string,body:string):PostRecord {
    const changed=this.db.raw.prepare('UPDATE posts SET body=? WHERE id=? AND account_id=? AND threads_post_id IS NULL')
      .run(formatThreadsPostText(body),postId,accountId).changes;
    if(!changed)throw new Error('본문 형식을 갱신할 미게시 준비본을 찾을 수 없습니다.');
    return this.getPost(postId)!;
  }

  markPreparedPostPublished(postId:string,accountId:string,threadsPostId:string,publishedAt=new Date().toISOString()):PostRecord {
    const changed=this.db.raw.prepare(`UPDATE posts SET threads_post_id=?,published_at=?,remote_deleted_at=NULL,
      coupang_reply_status=CASE WHEN coupang_reply_body IS NULL THEN 'NONE' ELSE 'PENDING' END,
      coupang_reply_id=NULL,coupang_reply_error=NULL,coupang_reply_published_at=NULL,coupang_reply_deleted_at=NULL
      WHERE id=? AND account_id=? AND threads_post_id IS NULL`).run(threadsPostId,publishedAt,postId,accountId).changes;
    if(!changed)throw new Error('발행할 준비본을 찾을 수 없거나 이미 발행된 항목입니다.');
    return this.getPost(postId)!;
  }

  recordCoupangReplyDeleted(postId:string, accountId:string, deletedAt=new Date().toISOString()):PostRecord {
    const changed=this.db.raw.prepare(`UPDATE posts SET coupang_reply_status='DELETED',coupang_reply_deleted_at=?,coupang_reply_error=NULL
      WHERE id=? AND account_id=? AND source_type='COUPANG' AND coupang_reply_id IS NOT NULL`).run(deletedAt,postId,accountId).changes;
    if (!changed) throw new Error('삭제 상태를 기록할 쿠팡 안내 댓글을 찾을 수 없습니다.');
    return this.getPost(postId)!;
  }

  recordCoupangReplyDeleteFailure(postId:string, accountId:string, error:string):PostRecord {
    const changed=this.db.raw.prepare(`UPDATE posts SET coupang_reply_status='DELETE_FAILED',coupang_reply_error=?
      WHERE id=? AND account_id=? AND source_type='COUPANG' AND coupang_reply_id IS NOT NULL`).run(error,postId,accountId).changes;
    if (!changed) throw new Error('삭제 오류를 기록할 쿠팡 안내 댓글을 찾을 수 없습니다.');
    return this.getPost(postId)!;
  }

  createPipelineRun(input: { accountId:string; jobId?:string; mode:'PREVIEW'|'PUBLISH'; message?:string }): PipelineRunView {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.raw.prepare(`INSERT INTO pipeline_runs(id,account_id,job_id,mode,status,stage,progress,message,started_at,updated_at)
      VALUES(?,?,?,?,'RUNNING','QUEUED',0,?,?,?)`).run(id, input.accountId, input.jobId ?? null, input.mode, input.message ?? '작업을 준비하고 있습니다.', now, now);
    const run = this.getPipelineRun(id)!;
    this.pipelineListeners.forEach((listener) => listener(run));
    return run;
  }

  updatePipelineRun(id: string, patch: { status?:PipelineStatus; stage?:PipelineStage; progress?:number; message?:string; errorSummary?:string|null; sourceId?:string|null; postId?:string|null; draftBody?:string|null; quality?:PipelineQualityDecision[]; finishedAt?:string|null }): PipelineRunView {
    const current = this.getPipelineRun(id);
    if (!current) throw new Error('Pipeline 작업을 찾을 수 없습니다.');
    const values = {
      id, status:patch.status ?? current.status, stage:patch.stage ?? current.stage,
      progress:Math.max(0, Math.min(100, patch.progress ?? current.progress)),
      message:(patch.message ?? current.message).slice(0, 1_000),
      errorSummary:patch.errorSummary === undefined ? current.errorSummary ?? null : patch.errorSummary?.slice(0, 1_000) ?? null,
      sourceId:patch.sourceId === undefined ? current.sourceId ?? null : patch.sourceId,
      postId:patch.postId === undefined ? current.postId ?? null : patch.postId,
      draftBody:patch.draftBody === undefined ? current.draftBody ?? null : patch.draftBody?.slice(0, 5_000) ?? null,
      quality:JSON.stringify(patch.quality ?? current.quality), updatedAt:new Date().toISOString(),
      finishedAt:patch.finishedAt === undefined ? current.finishedAt ?? null : patch.finishedAt,
    };
    this.db.raw.prepare(`UPDATE pipeline_runs SET status=@status,stage=@stage,progress=@progress,message=@message,
      error_summary=@errorSummary,source_id=@sourceId,post_id=@postId,draft_body=@draftBody,quality_json=@quality,updated_at=@updatedAt,finished_at=@finishedAt WHERE id=@id`).run(values);
    const run = this.getPipelineRun(id)!;
    this.pipelineListeners.forEach((listener) => listener(run));
    return run;
  }

  getPipelineRun(id: string): PipelineRunView | undefined {
    const row = this.db.raw.prepare(`SELECT r.*,(SELECT p.threads_post_id FROM posts p WHERE p.id=r.post_id) remote_post_id,(SELECT COUNT(*) FROM comments c JOIN posts p ON p.threads_post_id=c.post_id AND p.account_id=c.account_id WHERE p.id=r.post_id) collected_comment_count,(SELECT p.remote_deleted_at FROM posts p WHERE p.id=r.post_id) post_deleted_at,s.source_type,s.source_url,s.published_at source_published_at,s.metadata_json source_metadata_json
      FROM pipeline_runs r LEFT JOIN sources s ON s.id=r.source_id WHERE r.id=?`).get(id);
    return row ? pipelineRunFromRow(row) : undefined;
  }

  listPipelineRuns(accountId?: string, limit = 50, offset = 0): PipelineRunView[] {
    const sql = `SELECT r.*,(SELECT p.threads_post_id FROM posts p WHERE p.id=r.post_id) remote_post_id,(SELECT COUNT(*) FROM comments c JOIN posts p ON p.threads_post_id=c.post_id AND p.account_id=c.account_id WHERE p.id=r.post_id) collected_comment_count,(SELECT p.remote_deleted_at FROM posts p WHERE p.id=r.post_id) post_deleted_at,s.source_type,s.source_url,s.published_at source_published_at,s.metadata_json source_metadata_json
      FROM pipeline_runs r LEFT JOIN sources s ON s.id=r.source_id ${accountId ? 'WHERE r.account_id=?' : ''} ORDER BY COALESCE(r.finished_at,r.updated_at) DESC,r.id DESC LIMIT ? OFFSET ?`;
    const rows = accountId ? this.db.raw.prepare(sql).all(accountId, limit, offset) : this.db.raw.prepare(sql).all(limit, offset);
    return rows.map(pipelineRunFromRow);
  }

  dashboardActivity(accountId: string, from: string, to: string, limit = 50): DashboardActivitySnapshot {
    const runRows = this.db.raw.prepare(`SELECT r.*,(SELECT p.threads_post_id FROM posts p WHERE p.id=r.post_id) remote_post_id,(SELECT COUNT(*) FROM comments c JOIN posts p ON p.threads_post_id=c.post_id AND p.account_id=c.account_id WHERE p.id=r.post_id) collected_comment_count,(SELECT p.remote_deleted_at FROM posts p WHERE p.id=r.post_id) post_deleted_at,s.source_type,s.source_url,s.published_at source_published_at,s.metadata_json source_metadata_json
      FROM pipeline_runs r LEFT JOIN sources s ON s.id=r.source_id
      WHERE r.account_id=? AND COALESCE(r.finished_at,r.updated_at) BETWEEN ? AND ?
      ORDER BY COALESCE(r.finished_at,r.updated_at) DESC LIMIT ?`).all(accountId, from, to, limit);
    const operationalIssues = this.db.raw.prepare(`SELECT * FROM user_logs
      WHERE account_id=? AND run_id IS NULL AND level IN ('WARN','ERROR') AND created_at BETWEEN ? AND ?
      ORDER BY created_at DESC LIMIT ?`).all(accountId, from, to, limit).map((row: any) => ({
        id:row.id, level:row.level, category:row.category, message:row.message,
        detail:row.detail ?? undefined, accountId:row.account_id ?? undefined, runId:row.run_id ?? undefined,
        stage:row.stage ?? undefined, createdAt:row.created_at,
      } as UserLog));
    const counts: any = this.db.raw.prepare(`SELECT
      (SELECT COUNT(*) FROM posts WHERE account_id=? AND threads_post_id IS NOT NULL AND remote_deleted_at IS NULL AND published_at BETWEEN ? AND ?) published,
      (SELECT COUNT(*) FROM pipeline_runs WHERE account_id=? AND mode='PREVIEW' AND status='COMPLETED' AND COALESCE(finished_at,updated_at) BETWEEN ? AND ?) draft_completed,
      (SELECT COUNT(*) FROM pipeline_runs WHERE account_id=? AND status IN ('REJECTED','STOPPED') AND COALESCE(finished_at,updated_at) BETWEEN ? AND ?) +
        (SELECT COUNT(*) FROM user_logs WHERE account_id=? AND run_id IS NULL AND level='WARN' AND created_at BETWEEN ? AND ?) warnings,
      (SELECT COUNT(*) FROM pipeline_runs WHERE account_id=? AND status='FAILED' AND COALESCE(finished_at,updated_at) BETWEEN ? AND ?) +
        (SELECT COUNT(*) FROM user_logs WHERE account_id=? AND run_id IS NULL AND level='ERROR' AND created_at BETWEEN ? AND ?) failed`)
      .get(accountId,from,to, accountId,from,to, accountId,from,to, accountId,from,to, accountId,from,to, accountId,from,to);
    return {
      counts: { published:counts.published, draftCompleted:counts.draft_completed, warnings:counts.warnings, failed:counts.failed },
      runs:runRows.map(pipelineRunFromRow), operationalIssues,
    };
  }

  unprocessedCommentIds(ids: string[]): Set<string> {
    if (!ids.length) return new Set();
    const placeholders = ids.map(() => '?').join(',');
    const terminal = new Set(this.db.raw.prepare(`SELECT id FROM comments
      WHERE id IN (${placeholders}) AND decision IN ('REPLIED','SKIPPED','REPLY_UNCERTAIN')`)
      .all(...ids).map((row: any) => row.id as string));
    return new Set(ids.filter((id) => !terminal.has(id)));
  }

  saveComment(input: { id: string; accountId: string; postId: string; body: string; replyId?: string }): void {
    this.upsertCommentDiscovery(input);
    if (input.replyId) this.recordCommentReplyPublished({ id:input.id, accountId:input.accountId, replyId:input.replyId });
    else this.recordCommentDecision({ id:input.id, accountId:input.accountId, decision:'SKIPPED' });
  }

  upsertCommentDiscovery(input: { id:string; accountId:string; postId:string; body:string; authorUsername?:string; commentedAt?:string }): CommentRecord {
    const now=new Date().toISOString();
    this.db.raw.prepare(`INSERT INTO comments(
      id,account_id,post_id,body,author_username,commented_at,decision,reply_status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'PENDING','NONE',?,?)
    ON CONFLICT(id) DO UPDATE SET post_id=excluded.post_id,body=excluded.body,
      author_username=COALESCE(NULLIF(excluded.author_username,''),comments.author_username),
      commented_at=COALESCE(excluded.commented_at,comments.commented_at),updated_at=excluded.updated_at
    WHERE comments.account_id=excluded.account_id`).run(
      input.id,input.accountId,input.postId,input.body,input.authorUsername ?? '',input.commentedAt ?? null,now,now,
    );
    const stored=this.getComment(input.id,input.accountId);
    if (!stored) throw new Error('댓글을 저장하지 못했습니다. 계정 식별값을 확인하세요.');
    return stored;
  }

  recordCommentDecision(input: { id:string; accountId:string; decision:CommentDecision; reason?:string }): CommentRecord {
    const now=new Date().toISOString();
    const terminal=input.decision === 'REPLIED' || input.decision === 'SKIPPED' || input.decision === 'REPLY_UNCERTAIN';
    this.requireCommentUpdate(this.db.raw.prepare(`UPDATE comments SET decision=?,decision_reason=?,
      processed_at=CASE WHEN ? THEN ? ELSE processed_at END,last_error=NULL,updated_at=? WHERE id=? AND account_id=?`)
      .run(input.decision,input.reason ?? null,Number(terminal),now,now,input.id,input.accountId).changes);
    return this.getComment(input.id,input.accountId)!;
  }

  recordCommentReplyPublished(input: { id:string; accountId:string; replyId:string; replyBody?:string; reason?:string; repliedAt?:string }): CommentRecord {
    const now=input.repliedAt ?? new Date().toISOString();
    this.requireCommentUpdate(this.db.raw.prepare(`UPDATE comments SET decision='REPLIED',decision_reason=COALESCE(?,decision_reason),
      reply_body=COALESCE(?,reply_body),reply_id=?,reply_status='PUBLISHED',processed_at=?,replied_at=?,
      reply_deleted_at=NULL,last_error=NULL,updated_at=?,attempt_count=attempt_count+1 WHERE id=? AND account_id=?`)
      .run(input.reason ?? null,input.replyBody ?? null,input.replyId,now,now,now,input.id,input.accountId).changes);
    return this.getComment(input.id,input.accountId)!;
  }

  recordCommentReplyUncertain(input: { id:string; accountId:string; replyBody:string; reason?:string; error:string }): CommentRecord {
    const now=new Date().toISOString();
    this.requireCommentUpdate(this.db.raw.prepare(`UPDATE comments SET decision='REPLY_UNCERTAIN',decision_reason=?,
      reply_body=?,reply_status='UNCERTAIN',processed_at=?,last_error=?,updated_at=?,attempt_count=attempt_count+1
      WHERE id=? AND account_id=?`).run(input.reason ?? null,input.replyBody,now,input.error,now,input.id,input.accountId).changes);
    return this.getComment(input.id,input.accountId)!;
  }

  recordCommentFailure(input: { id:string; accountId:string; error:string; replyBody?:string; reason?:string }): CommentRecord {
    const now=new Date().toISOString();
    this.requireCommentUpdate(this.db.raw.prepare(`UPDATE comments SET decision='FAILED_RETRYABLE',decision_reason=?,
      reply_body=COALESCE(?,reply_body),reply_status='NONE',last_error=?,updated_at=?,attempt_count=attempt_count+1
      WHERE id=? AND account_id=?`).run(input.reason ?? null,input.replyBody ?? null,input.error,now,input.id,input.accountId).changes);
    return this.getComment(input.id,input.accountId)!;
  }

  recordCommentReplyDeleted(input: { id:string; accountId:string; deletedAt?:string }): CommentRecord {
    const now=input.deletedAt ?? new Date().toISOString();
    this.requireCommentUpdate(this.db.raw.prepare(`UPDATE comments SET reply_status='DELETED',reply_deleted_at=?,
      last_error=NULL,updated_at=? WHERE id=? AND account_id=? AND reply_id IS NOT NULL`)
      .run(now,now,input.id,input.accountId).changes);
    return this.getComment(input.id,input.accountId)!;
  }

  recordCommentReplyDeleteFailure(input: { id:string; accountId:string; error:string }): CommentRecord {
    const now=new Date().toISOString();
    this.requireCommentUpdate(this.db.raw.prepare(`UPDATE comments SET reply_status='DELETE_FAILED',last_error=?,updated_at=?
      WHERE id=? AND account_id=? AND reply_id IS NOT NULL`).run(input.error,now,input.id,input.accountId).changes);
    return this.getComment(input.id,input.accountId)!;
  }

  getComment(id:string, accountId?:string):CommentRecord|undefined {
    const row=accountId
      ? this.db.raw.prepare('SELECT * FROM comments WHERE id=? AND account_id=?').get(id,accountId)
      : this.db.raw.prepare('SELECT * FROM comments WHERE id=?').get(id);
    return row ? commentFromRow(row) : undefined;
  }

  listComments(input:CommentListInput):CommentRecord[] {
    const limit=Math.max(1,Math.min(input.limit ?? 50,200));
    const clauses=['account_id=@accountId'];
    const values:Record<string,unknown>={accountId:input.accountId,limit};
    if(input.postId){clauses.push('post_id=@postId');values.postId=input.postId;}
    if (input.decision) { clauses.push('decision=@decision'); values.decision=input.decision; }
    if (input.replyStatus) { clauses.push('reply_status=@replyStatus'); values.replyStatus=input.replyStatus; }
    if (input.beforeUpdatedAt) { clauses.push('updated_at<@beforeUpdatedAt'); values.beforeUpdatedAt=input.beforeUpdatedAt; }
    return this.db.raw.prepare(`SELECT comments.*,(SELECT p.body FROM posts p WHERE p.account_id=comments.account_id AND p.threads_post_id=comments.post_id) post_body,(SELECT p.published_at FROM posts p WHERE p.account_id=comments.account_id AND p.threads_post_id=comments.post_id) post_published_at FROM comments WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC,id DESC LIMIT @limit`).all(values).map(commentFromRow);
  }

  commentSummary(accountId:string,postId?:string):CommentSummary {
    const row:any=this.db.raw.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN decision='PENDING' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN decision='REPLIED' THEN 1 ELSE 0 END) replied,
      SUM(CASE WHEN decision='SKIPPED' THEN 1 ELSE 0 END) skipped,
      SUM(CASE WHEN decision IN ('REPLY_UNCERTAIN','FAILED_RETRYABLE') OR reply_status='DELETE_FAILED' THEN 1 ELSE 0 END) attention_needed
      FROM comments WHERE account_id=@accountId AND (@postId IS NULL OR post_id=@postId)`).get({accountId,postId:postId??null});
    return { total:row.total, pending:row.pending ?? 0, replied:row.replied ?? 0,
      skipped:row.skipped ?? 0, attentionNeeded:row.attention_needed ?? 0 };
  }

  private requireCommentUpdate(changes:number):void {
    if (!changes) throw new Error('댓글 이력을 찾을 수 없거나 현재 계정에서 처리할 수 없습니다.');
  }

  recentPosts(limit = 10): PostRecord[] {
    return this.db.raw.prepare('SELECT * FROM posts ORDER BY created_at DESC LIMIT ?').all(limit).map(postFromRow);
  }

  recentPublishedPosts(accountId: string, limit = 30): PostRecord[] {
    return this.db.raw.prepare('SELECT * FROM posts WHERE account_id=? AND threads_post_id IS NOT NULL AND remote_deleted_at IS NULL ORDER BY published_at DESC LIMIT ?').all(accountId, limit).map(postFromRow);
  }

  getPost(id:string):PostRecord|undefined {
    const row:any=this.db.raw.prepare('SELECT * FROM posts WHERE id=?').get(id);
    return row ? postFromRow(row) : undefined;
  }

  markPostRemoteDeleted(id:string, deletedAt=new Date().toISOString()):PostRecord {
    const changed=this.db.raw.prepare('UPDATE posts SET remote_deleted_at=? WHERE id=? AND threads_post_id IS NOT NULL').run(deletedAt,id).changes;
    if (!changed) throw new Error('삭제 상태를 기록할 게시물을 찾을 수 없습니다.');
    return this.getPost(id)!;
  }

  createThreadsIntegrationRun(input:{ id?:string; accountId:string; mode?:string; status?:string; stage?:string; message?:string; summary?:string; draftBody?:string; parentId?:string; replyId?:string; nestedReplyId?:string; cleanupNeeded?:boolean; errorSummary?:string; metadata?:Record<string,unknown>; startedAt?:string }):ThreadsIntegrationRunRecord {
    const id=input.id ?? randomUUID();const now=input.startedAt ?? new Date().toISOString();
    this.db.raw.prepare(`INSERT INTO threads_integration_runs(
      id,account_id,mode,status,stage,message,summary,draft_body,parent_id,reply_id,nested_reply_id,cleanup_needed,error_summary,metadata_json,started_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.accountId,input.mode ?? 'full',input.status ?? 'RUNNING',input.stage ?? 'START',
      input.message ?? '',input.summary ?? null,input.draftBody ?? null,input.parentId ?? null,input.replyId ?? null,input.nestedReplyId ?? null,
      Number(input.cleanupNeeded ?? false),input.errorSummary ?? null,JSON.stringify(input.metadata ?? {}),now,now);
    return this.getThreadsIntegrationRun(id)!;
  }

  updateThreadsIntegrationRun(id:string, patch:{ status?:string; stage?:string; message?:string; summary?:string|null; lastError?:string|null; draftBody?:string|null; parentId?:string|null; replyId?:string|null; nestedReplyId?:string|null; cleanupNeeded?:boolean; errorSummary?:string|null; metadata?:Record<string,unknown>; finishedAt?:string|null }):ThreadsIntegrationRunRecord {
    const current=this.getThreadsIntegrationRun(id);
    if (!current) throw new Error('Threads 통합 테스트 실행 이력을 찾을 수 없습니다.');
    const updatedAt=new Date().toISOString();
    this.db.raw.prepare(`UPDATE threads_integration_runs SET status=?,stage=?,message=?,summary=?,last_error=?,draft_body=?,
      parent_id=?,reply_id=?,nested_reply_id=?,cleanup_needed=?,error_summary=?,metadata_json=?,updated_at=?,finished_at=? WHERE id=?`)
      .run(patch.status ?? current.status,patch.stage ?? current.stage,patch.message ?? current.message,
        patch.summary === undefined ? current.summary ?? null : patch.summary,
        patch.lastError === undefined ? current.lastError ?? null : patch.lastError,
        patch.draftBody === undefined ? current.draftBody ?? null : patch.draftBody,
        patch.parentId === undefined ? current.parentId ?? null : patch.parentId,
        patch.replyId === undefined ? current.replyId ?? null : patch.replyId,
        patch.nestedReplyId === undefined ? current.nestedReplyId ?? null : patch.nestedReplyId,
        Number(patch.cleanupNeeded ?? current.cleanupNeeded),
        patch.errorSummary === undefined ? current.errorSummary ?? null : patch.errorSummary,
        JSON.stringify(patch.metadata ?? current.metadata),updatedAt,
        patch.finishedAt === undefined ? current.finishedAt ?? null : patch.finishedAt,id);
    return this.getThreadsIntegrationRun(id)!;
  }

  getThreadsIntegrationRun(id:string):ThreadsIntegrationRunRecord|undefined {
    const row=this.db.raw.prepare('SELECT * FROM threads_integration_runs WHERE id=?').get(id);
    return row ? threadsIntegrationRunFromRow(row) : undefined;
  }

  listThreadsIntegrationRuns(accountId?:string, limit=20):ThreadsIntegrationRunRecord[] {
    const safeLimit=Math.max(1,Math.min(limit,100));
    const rows=accountId
      ? this.db.raw.prepare('SELECT * FROM threads_integration_runs WHERE account_id=? ORDER BY updated_at DESC,id DESC LIMIT ?').all(accountId,safeLimit)
      : this.db.raw.prepare('SELECT * FROM threads_integration_runs ORDER BY updated_at DESC,id DESC LIMIT ?').all(safeLimit);
    return rows.map(threadsIntegrationRunFromRow);
  }

  addThreadsIntegrationEvent(input:{ runId:string; stage:string; level:LogLevel; message:string; detail?:Record<string,unknown>; remoteId?:string; remoteObjectType?:string; remoteObjectId?:string; createdAt?:string }):ThreadsIntegrationEventRecord {
    const createdAt=input.createdAt ?? new Date().toISOString();
    const result=this.db.raw.prepare(`INSERT INTO threads_integration_events(
      run_id,stage,level,message,detail_json,remote_id,remote_object_type,remote_object_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(input.runId,input.stage,input.level,input.message,JSON.stringify(input.detail ?? {}),input.remoteId ?? input.remoteObjectId ?? null,
      input.remoteObjectType ?? null,input.remoteObjectId ?? input.remoteId ?? null,createdAt);
    return threadsIntegrationEventFromRow(this.db.raw.prepare('SELECT * FROM threads_integration_events WHERE id=?').get(result.lastInsertRowid));
  }

  listThreadsIntegrationEvents(runId:string, limit=200):ThreadsIntegrationEventRecord[] {
    const safeLimit=Math.max(1,Math.min(limit,500));
    return this.db.raw.prepare('SELECT * FROM threads_integration_events WHERE run_id=? ORDER BY id LIMIT ?')
      .all(runId,safeLimit).map(threadsIntegrationEventFromRow);
  }

  deleteThreadsIntegrationRun(id:string):boolean {
    return this.db.raw.prepare('DELETE FROM threads_integration_runs WHERE id=?').run(id).changes === 1;
  }

  upsertInsights(postId: string, values: { views?: number; likes?: number; replies?: number; reposts?: number; quotes?: number; shares?: number }): void {
    this.db.raw.prepare(`INSERT INTO insights(post_id,views,likes,replies,reposts,quotes,shares,collected_at)
      VALUES(@postId,@views,@likes,@replies,@reposts,@quotes,@shares,@collectedAt)
      ON CONFLICT(post_id) DO UPDATE SET views=excluded.views,likes=excluded.likes,replies=excluded.replies,
      reposts=excluded.reposts,quotes=excluded.quotes,shares=excluded.shares,collected_at=excluded.collected_at`).run({
      postId, views: values.views ?? 0, likes: values.likes ?? 0, replies: values.replies ?? 0,
      reposts: values.reposts ?? 0, quotes: values.quotes ?? 0, shares: values.shares ?? 0, collectedAt: new Date().toISOString(),
    });
  }

  replaceAffiliatePerformanceByKeyRange(credentialFingerprint:string,keyLabel:string,from:string,to:string,values:Array<{date:string;clicks:number;orders:number;orderAmount:number;revenue:number}>):void {
    const start=from.slice(0,10),end=to.slice(0,10),collectedAt=new Date().toISOString();
    const daily=new Map<string,{clicks:number;orders:number;orderAmount:number;revenue:number}>();
    for(const value of values){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value.date)||value.date<start||value.date>end)continue;
      const total=daily.get(value.date)??{clicks:0,orders:0,orderAmount:0,revenue:0};
      total.clicks+=value.clicks;total.orders+=value.orders;total.orderAmount+=value.orderAmount;total.revenue+=value.revenue;
      daily.set(value.date,total);
    }
    const replace=this.db.raw.transaction(()=>{
      this.db.raw.prepare('DELETE FROM affiliate_performance_by_key WHERE credential_fingerprint=? AND performance_date BETWEEN ? AND ?').run(credentialFingerprint,start,end);
      const insert=this.db.raw.prepare(`INSERT INTO affiliate_performance_by_key(credential_fingerprint,key_label,performance_date,clicks,orders,order_amount,revenue,collected_at)
        VALUES(@credentialFingerprint,@keyLabel,@date,@clicks,@orders,@orderAmount,@revenue,@collectedAt)`);
      for(const [date,value] of daily)insert.run({credentialFingerprint,keyLabel:keyLabel.trim(),date,...value,collectedAt});
    });
    replace();
  }

  lastPublishedPromotionType(accountId:string):SourceType|undefined {
    const row=this.db.raw.prepare("SELECT source_type FROM posts WHERE account_id=? AND source_type<>'DAILY' AND threads_post_id IS NOT NULL AND remote_deleted_at IS NULL ORDER BY published_at DESC,id DESC LIMIT 1").get(accountId) as {source_type:SourceType}|undefined;
    return row?.source_type;
  }

  affiliateReport(connections:Array<{fingerprint:string;keyLabel:string;accountNames:string[]}>,from:string,to:string):AffiliateReportRow[] {
    if(!connections.length)return [];
    const byFingerprint=new Map(connections.map((connection)=>[connection.fingerprint,connection]));
    const fingerprints=[...byFingerprint.keys()];
    const placeholders=fingerprints.map(()=>'?').join(',');
    const rows:any[]=this.db.raw.prepare(`SELECT credential_fingerprint,performance_date,
        SUM(clicks) clicks,SUM(orders) orders,SUM(order_amount) order_amount,SUM(revenue) revenue
      FROM affiliate_performance_by_key
      WHERE credential_fingerprint IN (${placeholders}) AND performance_date BETWEEN date(?) AND date(?)
      GROUP BY credential_fingerprint,performance_date
      ORDER BY performance_date DESC,credential_fingerprint`).all(...fingerprints,from,to);
    return rows.map((row)=>{
      const connection=byFingerprint.get(row.credential_fingerprint)!;
      return {connectionId:row.credential_fingerprint.slice(0,12),keyLabel:connection.keyLabel,accountNames:connection.accountNames,
        date:row.performance_date,clicks:row.clicks,orders:row.orders,orderAmount:row.order_amount,revenue:row.revenue};
    });
  }

  addLog(level: LogLevel, category: string, message: string, detail?: string, accountId?: string, runId?: string, stage?: PipelineStage, threadsIntegrationRunId?: string): UserLog {
    const createdAt = new Date().toISOString();
    const result = this.db.raw.prepare('INSERT INTO user_logs(level,category,message,detail,account_id,run_id,threads_integration_run_id,stage,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(level, category, message, detail ?? null, accountId ?? null, runId ?? null, threadsIntegrationRunId ?? null, stage ?? null, createdAt);
    const log: UserLog = { id:Number(result.lastInsertRowid), level, category, message, detail, accountId, runId, threadsIntegrationRunId, stage, createdAt };
    this.logListeners.forEach((listener) => listener(log));
    return log;
  }

  recentLogs(limit = 200): UserLog[] {
    return this.db.raw.prepare('SELECT * FROM user_logs ORDER BY id DESC LIMIT ?').all(limit).map((row: any) => ({
      id: row.id, level: row.level, category: row.category, message: row.message,
      detail: row.detail ?? undefined, accountId: row.account_id ?? undefined, runId:row.run_id ?? undefined,
      threadsIntegrationRunId:row.threads_integration_run_id ?? undefined,
      stage:row.stage ?? undefined, createdAt: row.created_at,
    }));
  }

  accountRuntimeSummaries(): Record<string, { providers: string[]; todayPosts: number; nextRunAt?: string; hasError: boolean }> {
    const result: Record<string, { providers: string[]; todayPosts: number; nextRunAt?: string; hasError: boolean }> = {};
    for (const account of this.listAccounts()) {
      const row: any = this.db.raw.prepare(`SELECT
        (SELECT COUNT(*) FROM posts WHERE account_id=? AND threads_post_id IS NOT NULL AND remote_deleted_at IS NULL AND date(published_at)=date('now','localtime')) today_posts,
        (SELECT MIN(run_at) FROM jobs WHERE account_id=? AND status='PENDING') next_run_at,
        EXISTS(SELECT 1 FROM user_logs WHERE account_id=? AND level='ERROR' AND created_at>=datetime('now','-1 day')) has_error`).get(account.id, account.id, account.id);
      const providers = this.listProviderConfigs(account.id).filter((config) => config.enabled).map((config) => config.type);
      result[account.id] = { providers, todayPosts: row.today_posts, nextRunAt: row.next_run_at ?? undefined, hasError: Boolean(row.has_error) };
    }
    return result;
  }

  report(accountIds: string[], from: string, to: string): ReportRow[] {
    if (!accountIds.length) return [];
    const placeholders = accountIds.map(() => '?').join(',');
    const rows: any[] = this.db.raw.prepare(`
      SELECT p.id post_id,p.body,p.account_id,a.name account_name,p.source_type,p.published_at,
        COALESCE(i.views,0) views,COALESCE(i.likes,0) likes,COALESCE(i.replies,0) replies,
        COALESCE(i.reposts,0) reposts,COALESCE(i.quotes,0) quotes,COALESCE(i.shares,0) shares
      FROM posts p JOIN accounts a ON a.id=p.account_id LEFT JOIN insights i ON i.post_id=p.id
      WHERE p.account_id IN (${placeholders}) AND p.remote_deleted_at IS NULL AND p.published_at BETWEEN ? AND ? ORDER BY p.published_at DESC
    `).all(...accountIds, from, to);
    return rows.map((r) => ({ postId: r.post_id, body: r.body, accountId: r.account_id, accountName: r.account_name,
      sourceType: r.source_type, publishedAt: r.published_at, views: r.views, likes: r.likes, replies: r.replies,
      reposts: r.reposts, quotes: r.quotes, shares: r.shares }));
  }

  counts(): { accounts: number; automation: number; successToday: number; failed: number; pending: number } {
    const row: any = this.db.raw.prepare(`SELECT
      (SELECT COUNT(*) FROM accounts) accounts,
      (SELECT COUNT(*) FROM accounts WHERE automation_target=1 AND active=1) automation,
      (SELECT COUNT(*) FROM posts WHERE threads_post_id IS NOT NULL AND remote_deleted_at IS NULL AND date(published_at)=date('now','localtime')) successToday,
      (SELECT COUNT(*) FROM jobs WHERE status='FAILED') failed,
      (SELECT COUNT(*) FROM jobs WHERE status='PENDING') pending`).get();
    return row;
  }
}

