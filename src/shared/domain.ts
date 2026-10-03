export const SOURCE_TYPES = ['DAILY', 'YOUTUBE', 'BLOG', 'COUPANG', 'NAVER_BRAND_CONNECT'] as const;
export const PRODUCT_QUEUE_PROVIDERS = ['COUPANG', 'NAVER_BRAND_CONNECT'] as const;
export const JOB_STATUSES = ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'] as const;
export const LOG_LEVELS = ['INFO', 'WARN', 'ERROR', 'DEBUG'] as const;
export const AGENT_ROLES = ['orchestrator', 'topic', 'writer', 'reviewer'] as const;
export const QUALITY_VETOES = [
  'UNSUPPORTED_EPISODE', 'INVENTED_DIALOGUE', 'SCRIPTED_ARC', 'PUNCHLINE_CLOSURE', 'AGE_STEREOTYPE',
  'AI_ABSTRACT_LEXICON', 'AWKWARD_COLLOQUIAL_WORDING', 'LOW_RESONANCE', 'NO_PUBLISH_VALUE',
  'TOPIC_TUNNEL_VISION', 'FORCED_ENGAGEMENT', 'FILLER_COMPLETION', 'EXPLANATORY_STACKING',
  'SAFE_REACTION_CLOSURE', 'FORMULAIC_OBSERVATION', 'PROFILE_INTERCHANGEABLE',
  'UNCLEAR_REFERENT', 'ACTION_CAUSALITY_GAP', 'CONTRIVED_SCENARIO', 'EMPTY_CONTRAST',
  'PROMO_BROCHURE_CTA', 'MECHANICAL_ENUMERATION', 'SOURCE_OUTLINE_REPACKAGING', 'ABSTRACT_REPORT_STYLE',
  'REDUNDANT_SUMMARY', 'UNSUPPORTED_CLAIM', 'INVENTED_EXPERIENCE', 'HEDGED_RECOMMENDATION', 'META_EVIDENCE_AS_BENEFIT',
  'WEAK_OPENING_HOOK', 'NON_NATIVE_THREADS_VOICE', 'USER_PROFILE_CONFLICT',
] as const;
export const PIPELINE_STATUSES = ['QUEUED', 'RUNNING', 'STOPPED', 'REJECTED', 'FAILED', 'COMPLETED'] as const;
export const PIPELINE_STAGES = ['QUEUED', 'DISCOVER', 'SOURCE', 'TOPIC', 'WRITER', 'REVIEWER', 'ORCHESTRATOR', 'PUBLISH', 'DONE'] as const;
export const COUPANG_MODES = ['MANUAL_LINKS', 'OPEN_API'] as const;
export const COUPANG_INPUT_TYPES = ['PLAIN_LINK', 'IFRAME', 'BLOG_ANCHOR_IMAGE'] as const;
export const COUPANG_METADATA_STATUSES = ['PENDING', 'READY', 'INFORMATION_REQUIRED', 'FAILED'] as const;
export const COUPANG_LINK_QUEUE_STATUSES = ['INFORMATION_REQUIRED', 'QUEUED', 'PROCESSING', 'PREVIEW_READY', 'REVIEW_REQUIRED', 'COMPLETED', 'FAILED'] as const;
export const COUPANG_REPLY_STATUSES = ['NONE', 'PENDING', 'PUBLISHED', 'FAILED', 'UNCERTAIN', 'DELETED', 'DELETE_FAILED'] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];
export type ProductQueueProvider = (typeof PRODUCT_QUEUE_PROVIDERS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type AgentRole = (typeof AGENT_ROLES)[number];
export type QualityVeto = (typeof QUALITY_VETOES)[number];
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type CoupangMode = (typeof COUPANG_MODES)[number];
export type CoupangInputType = (typeof COUPANG_INPUT_TYPES)[number];
export type CoupangMetadataStatus = (typeof COUPANG_METADATA_STATUSES)[number];
export type CoupangLinkQueueStatus = (typeof COUPANG_LINK_QUEUE_STATUSES)[number];
export type CoupangReplyStatus = (typeof COUPANG_REPLY_STATUSES)[number];

export interface MediaAsset {
  type: 'IMAGE';
  url: string;
  position: number;
  altText?: string;
  source?: 'COUPANG_GALLERY' | 'COUPANG_TAG' | 'NAVER_GALLERY' | 'PROVIDER' | 'USER';
}

export interface CoupangReviewEvidence {
  id?: string;
  text: string;
  rating?: number;
  option?: string;
  reviewedAt?: string;
}

export interface Account {
  id: string;
  threadsUserId?: string;
  threadsTokenIssuedAt?: string;
  threadsTokenExpiresAt?: string;
  threadsTokenDataAccessExpiresAt?: string;
  threadsTokenCheckedAt?: string;
  threadsTokenCheckFailedAt?: string;
  threadsTokenScopes?: string[];
  threadsTokenValid?: boolean;
  threadsTokenLastRefreshedAt?: string;
  name: string;
  threadsHandle: string;
  topic: string;
  personality: string;
  tone: string;
  audience: string;
  forbiddenTopics: string;
  forbiddenExpressions: string;
  dailyEnabled: boolean;
  promotionEnabled: boolean;
  automationTarget: boolean;
  active: boolean;
  dailyRatio: number;
  promotionRatio: number;
  dailyPostTarget: number;
  operationStart: string;
  operationEnd: string;
  weekdays: number[];
  commentIntervalMinutes: number;
  fixedLinkEnabled: boolean;
  fixedLinkUrl: string;
  createdAt: string;
  updatedAt: string;
}

export type AccountInput = Omit<Account, 'id' | 'threadsUserId' | 'threadsTokenIssuedAt' | 'threadsTokenExpiresAt' | 'threadsTokenDataAccessExpiresAt' | 'threadsTokenCheckFailedAt' | 'threadsTokenCheckedAt' | 'threadsTokenScopes' | 'threadsTokenValid' | 'threadsTokenLastRefreshedAt' | 'createdAt' | 'updatedAt'> & { id?: string };
export type AccountSaveInput = AccountInput;

export interface ThreadsTokenStatus {
  accountId: string;
  stored: boolean;
  valid?: boolean;
  issuedAt?: string;
  expiresAt?: string;
  dataAccessExpiresAt?: string;
  checkedAt?: string;
  fresh: boolean;
  estimated?: boolean;
  scopes: string[];
  missingScopes: string[];
  lastRefreshedAt?: string;
  refreshAvailableAt?: string;
  daysRemaining?: number;
  canRefresh: boolean;
  state: 'CHECK_FAILED' | 'UNKNOWN' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'INVALID';
  message: string;
  warning?: string;
}

export interface ThreadsTokenDebugResult {
  valid: boolean;
  userId?: string;
  issuedAt?: string;
  expiresAt?: string;
  dataAccessExpiresAt?: string;
  scopes: string[];
  application?: string;
  checkedAt: string;
}

export interface ThreadsProfile {
  id: string;
  username: string;
  name: string;
}

export interface ThreadsPostSummary {
  id: string;
  ownerId?: string;
  username?: string;
  text?: string;
  permalink?: string;
  timestamp?: string;
  mediaProductType?: string;
  mediaType?: string;
  isReply?: boolean;
  isReplyOwnedByMe?: boolean;
  hasReplies?: boolean;
  rootPostId?: string;
  repliedToId?: string;
}

export interface ProviderConfig {
  id: string;
  accountId: string;
  type: Exclude<SourceType, 'DAILY'>;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface CoupangProviderConfig {
  schemaVersion: 1;
  mode: CoupangMode;
  keyLabel?: string;
  keywords?: string;
  rocketOnly?: boolean;
  rocketFreshOnly?: boolean;
  keywordSearchIncluded?: boolean;
  goldBoxIncluded?: boolean;
  categoryBestIncluded?: boolean;
  categoryId?: string;
  coupangPlIncluded?: boolean;
  coupangPlBrandId?: string;
  /** @deprecated 이전 설정을 새 포함 방식으로 이관할 때만 읽습니다. */
  goldBoxOnly?: boolean;
  apiVerifiedAt?: string;
  verifiedCredentialUpdatedAt?: { accessKey: string; secretKey: string };
}

export interface CoupangProductQueueItem {
  id: string;
  accountId: string;
  providerType?: ProductQueueProvider;
  originalInputType: CoupangInputType;
  affiliateUrl: string;
  urlFingerprint: string;
  productName?: string;
  productNote: string;
  imageUrl?: string;
  imageUrls: string[];
  media: MediaAsset[];
  productFacts: string[];
  researchSourceUrls: string[];
  reviewEvidence: CoupangReviewEvidence[];
  researchVersion: number;
  reviewCount: number;
  reviewCollectedAt?: string;
  metadataStatus: CoupangMetadataStatus;
  researchVerified: boolean;
  sortOrder: number;
  status: CoupangLinkQueueStatus;
  attemptCount: number;
  activeSourceId?: string;
  draftPostId?: string;
  draftBody?: string;
  draftReplyBody?: string;
  draftReplyStatus?: CoupangReplyStatus;
  activeRunId?: string;
  lastError?: string;
  claimedAt?: string;
  previewedAt?: string;
  completedAt?: string;
  researchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoupangProductQueueSummary {
  total: number;
  byStatus: Record<CoupangLinkQueueStatus, number>;
  metadataReady: number;
  metadataAttention: number;
}

export interface SourceCandidate {
  id: string;
  accountId: string;
  sourceType: SourceType;
  sourceKey: string;
  sourceUrl: string;
  publishedAt?: string;
  title: string;
  summary?: string;
  imageUrl?: string;
  imageUrls?: string[];
  media?: MediaAsset[];
  reviewEvidence?: CoupangReviewEvidence[];
  researchVersion?: number;
  reviewCount?: number;
  reviewCollectedAt?: string;
  metadata: Record<string, unknown>;
}

export interface PostRecord {
  id: string;
  accountId: string;
  sourceId?: string;
  sourceType: SourceType;
  body: string;
  url?: string;
  imageUrl?: string;
  imageUrls?: string[];
  media?: MediaAsset[];
  threadsPostId?: string;
  coupangReplyBody?: string;
  coupangReplyId?: string;
  coupangReplyStatus?: CoupangReplyStatus;
  coupangReplyError?: string;
  coupangReplyPublishedAt?: string;
  coupangReplyDeletedAt?: string;
  createdAt: string;
  publishedAt?: string;
  remoteDeletedAt?: string;
}

export interface CommentRecord {
  postBody?: string;
  postPublishedAt?: string;
  id: string;
  accountId: string;
  postId: string;
  body: string;
  authorUsername?: string;
  commentedAt?: string;
  decision: 'PENDING' | 'REPLIED' | 'SKIPPED' | 'REPLY_UNCERTAIN' | 'FAILED_RETRYABLE';
  decisionReason?: string;
  replyId?: string;
  replyBody?: string;
  replyStatus: 'NONE' | 'PUBLISHED' | 'UNCERTAIN' | 'DELETED' | 'DELETE_FAILED';
  repliedAt?: string;
  replyDeletedAt?: string;
  lastError?: string;
  attemptCount: number;
  processedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommentSummary {
  total: number;
  pending: number;
  replied: number;
  skipped: number;
  attentionNeeded: number;
}

export interface ThreadsIntegrationEvent {
  id: number;
  runId: string;
  stage: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
  remoteId?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

export interface ThreadsIntegrationRun {
  id: string;
  accountId: string;
  status: 'RUNNING' | 'PASS' | 'FAILED' | 'CLEANUP_REQUIRED';
  stage: string;
  message: string;
  draftBody?: string;
  parentId?: string;
  replyId?: string;
  nestedReplyId?: string;
  cleanupNeeded: boolean;
  errorSummary?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  events?: ThreadsIntegrationEvent[];
}

export interface JobRecord {
  id: string;
  accountId: string;
  kind: 'PUBLISH' | 'COMMENTS' | 'INSIGHTS' | 'COUPANG_REPORT';
  status: JobStatus;
  runAt: string;
  attempt: number;
  payload: Record<string, unknown>;
  lastError?: string;
}

export interface JobActivity {
  id: string;
  jobId: string;
  accountId: string;
  kind: JobRecord['kind'];
  status: JobStatus;
  message: string;
  attempt: number;
  createdAt: string;
}

export interface UserLog {
  id: number;
  level: LogLevel;
  category: string;
  message: string;
  detail?: string;
  diagnosticSummary?: string;
  accountId?: string;
  runId?: string;
  threadsIntegrationRunId?: string;
  stage?: PipelineStage;
  createdAt: string;
}

export interface PipelineQualityDecision {
  stage: 'REVIEWER' | 'ORCHESTRATOR' | 'CORE';
  decision: 'PASS' | 'REJECT';
  reason: string;
  vetoes: QualityVeto[];
}

export interface PipelineRunView {
  collectedCommentCount?: number;
  threadsPostId?: string;
  postDeletedAt?: string;
  id: string;
  accountId: string;
  jobId?: string;
  postId?: string;
  mode: 'PREVIEW' | 'PUBLISH';
  status: PipelineStatus;
  stage: PipelineStage;
  progress: number;
  message: string;
  errorSummary?: string;
  sourceId?: string;
  source?: Pick<SourceCandidate, 'id' | 'sourceType' | 'title' | 'sourceUrl' | 'imageUrl' | 'imageUrls' | 'media' | 'publishedAt'>;
  draftBody?: string;
  quality: PipelineQualityDecision[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface CodexSettings {
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  timeoutSeconds: number;
}

export interface AppSettings {
  codex: CodexSettings;
  schedulerEnabled: boolean;
  launchAtStartup: boolean;
}

export type CredentialKey =
  | 'youtubeApiKey'
  | 'coupangAccessKey'
  | 'coupangSecretKey'
  | `${'threadsToken' | 'youtubeApiKey' | 'coupangAccessKey' | 'coupangSecretKey'}:${string}`;

export interface AccountCredentialStatus {
  threads: boolean;
  youtube: boolean;
  coupang: boolean;
}

export interface AccountRuntimeSummary {
  providers: string[];
  todayPosts: number;
  nextRunAt?: string;
  hasError: boolean;
  credentials: AccountCredentialStatus;
  providerConfiguration?: { blog: boolean; youtube: boolean; coupang: boolean; naverBrandConnect?: boolean };
  coupang?: {
    mode: CoupangMode;
    ready: boolean;
    message: string;
    queued: number;
    prepared: number;
    attention: number;
  };
  naverBrand?: {
    ready: boolean;
    message: string;
    queued: number;
    prepared: number;
    attention: number;
  };
}

export interface CodexHealth {
  installed: boolean;
  failure?: 'NOT_FOUND' | 'EXECUTION_FAILED';
  version?: string;
  message: string;
}

export interface CodexUsageStatus {
  routineTokens: number;
  weeklyRemainingPercent?: number;
  resetsAt?: string;
  checkedAt?: string;
  available: boolean;
}

export interface DashboardSnapshot {
  automationRunning: boolean;
  accountCount: number;
  automationAccountCount: number;
  todaySuccessCount: number;
  failedJobCount: number;
  pendingJobCount: number;
  recentPosts: PostRecord[];
  recentErrors: UserLog[];
  codex: CodexHealth;
  usage: CodexUsageStatus;
  apiStatus: Record<'Threads' | 'YouTube' | 'Coupang', { ready: boolean; message: string }>;
}

export interface AutomationScheduleMutationResult {
  running: boolean;
  cancelled: number;
  scheduled: number;
  pendingJobCount: number;
}

export interface DashboardActivitySnapshot {
  counts: {
    published: number;
    draftCompleted: number;
    warnings: number;
    failed: number;
  };
  runs: PipelineRunView[];
  operationalIssues: UserLog[];
}

export interface ReportRow {
  postId: string;
  body: string;
  accountId: string;
  accountName: string;
  sourceType: SourceType;
  publishedAt: string;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  shares: number;
}

export interface AffiliateReportRow {
  connectionId: string;
  keyLabel: string;
  accountNames: string[];
  date: string;
  clicks: number;
  orders: number;
  orderAmount: number;
  revenue: number;
}

export interface PerformanceReport {
  posts: ReportRow[];
  coupang: AffiliateReportRow[];
  warnings: string[];
}

export interface AgentResult {
  decision: 'PASS' | 'REJECT' | 'SKIP';
  reason: string;
  vetoes: QualityVeto[];
  content?: string;
  topic?: string;
  angle?: string;
  sourceUrls: string[];
  imageUrl?: string;
  imageUrls?: string[];
  media?: MediaAsset[];
  sameMeaningAs?: string;
}

export interface AppSnapshot {
  dashboard: DashboardSnapshot;
  accounts: Account[];
  logs: UserLog[];
  settings: AppSettings;
  pendingJobs: JobRecord[];
  runningJobs: JobRecord[];
  accountRuntime: Record<string, AccountRuntimeSummary>;
  pipelineRuns: PipelineRunView[];
}
