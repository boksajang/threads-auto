import { z } from 'zod';
import { COUPANG_CATEGORY_OPTIONS, COUPANG_PL_BRAND_OPTIONS } from '../../shared/coupang-catalog';

const coupangCategoryIdSchema=z.string().refine((value)=>value==='ALL'||COUPANG_CATEGORY_OPTIONS.some(([id])=>id===value),'지원하는 쿠팡 카테고리를 선택하세요.');
const coupangPlBrandIdSchema=z.string().refine((value)=>value==='ALL'||COUPANG_PL_BRAND_OPTIONS.some(([id])=>id===value),'지원하는 쿠팡 PL 브랜드를 선택하세요.');

const accountInputShape = {
  id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100), threadsHandle: z.string().trim().max(100),
  topic: z.string().trim().max(500), personality: z.string().max(1000), tone: z.string().max(1000), audience: z.string().max(1000),
  forbiddenTopics: z.string().max(2000), forbiddenExpressions: z.string().max(2000), dailyEnabled: z.boolean(), promotionEnabled: z.boolean(),
  automationTarget: z.boolean(), active: z.boolean(), dailyRatio: z.number().int().min(0).max(100), promotionRatio: z.number().int().min(0).max(100),
  dailyPostTarget: z.number().int().min(1).max(50), operationStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), operationEnd: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), commentIntervalMinutes: z.number().int().min(5).max(1440),
  fixedLinkEnabled: z.boolean(), fixedLinkUrl: z.union([z.literal(''), z.string().url().refine((value) => value.startsWith('https://'), 'HTTPS URL만 허용됩니다.')]),
};
const hasContentMode = <T extends { dailyEnabled: boolean; promotionEnabled: boolean }>(value: T) => value.dailyEnabled || value.promotionEnabled;
const timeValue=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3,5));
export const accountInputSchema = z.object(accountInputShape)
  .refine(hasContentMode, { message: '일상글 또는 홍보글 중 하나 이상을 선택하세요.' })
  .refine((value)=>timeValue(value.operationEnd)>timeValue(value.operationStart),{message:'운영 종료 시각은 시작 시각보다 늦어야 합니다.',path:['operationEnd']});
export const accountSaveSchema = accountInputSchema;
export const threadsRegistrationSchema = z.object({ accessToken:z.string().trim().min(1, 'Threads Access Token을 입력하세요.').max(10_000) }).strict();
export const threadsTokenUpdateSchema = z.object({ accountId:z.string().uuid(), accessToken:z.string().trim().min(1, 'Threads Access Token을 입력하세요.').max(10_000) }).strict();
export const immediatePublishSchema = z.object({
  accountId:z.string().uuid(),
  sourceType:z.enum(['DAILY','YOUTUBE','BLOG','COUPANG','NAVER_BRAND_CONNECT']),
}).strict();
export const preparedDailyPublishSchema = z.object({ accountId:z.string().uuid(), postId:z.string().uuid() }).strict();
export const promotionScheduleUpdateSchema = z.object({
  jobId:z.string().min(1).max(500),
  accountId:z.string().uuid(),
  sourceType:z.enum(['YOUTUBE','BLOG','COUPANG','NAVER_BRAND_CONNECT']),
}).strict();

export const settingsSchema = z.object({
  codex: z.object({ model: z.string().min(1).max(100), reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']), timeoutSeconds: z.number().int().min(30).max(1800) }),
  schedulerEnabled: z.boolean(), launchAtStartup: z.boolean(),
});

export const credentialKeySchema = z.string().refine((value) =>
  ['youtubeApiKey','coupangAccessKey','coupangSecretKey'].includes(value)
  || /^(threadsToken|youtubeApiKey|coupangAccessKey|coupangSecretKey):[0-9a-f-]{36}$/i.test(value),
);
export const writableCredentialKeySchema = z.string().refine((value) =>
  ['youtubeApiKey','coupangAccessKey','coupangSecretKey'].includes(value)
  || /^(youtubeApiKey|coupangAccessKey|coupangSecretKey):[0-9a-f-]{36}$/i.test(value),
);
export const reportQuerySchema = z.object({ accountIds: z.array(z.string().uuid()).max(100), from: z.string().datetime(), to: z.string().datetime() }).refine((value) => value.from <= value.to, '시작일은 종료일보다 늦을 수 없습니다.');
export const dashboardActivityQuerySchema = z.object({ accountId: z.string().uuid(), from: z.string().datetime(), to: z.string().datetime(), limit: z.number().int().min(1).max(100).default(50) })
  .refine((value) => value.from <= value.to, '시작일은 종료일보다 늦을 수 없습니다.');
export const commentListSchema = z.object({ postId:z.string().min(1).max(200).optional(), accountId:z.string().uuid(), limit:z.number().int().min(1).max(200).default(100) }).strict();
export const threadsIntegrationListSchema = z.object({ accountId:z.string().uuid(), limit:z.number().int().min(1).max(20).default(10) }).strict();
export const threadsIntegrationRunSchema = z.object({ runId:z.string().uuid() }).strict();
export const ownedContentDeleteSchema = z.discriminatedUnion('kind', [
  z.object({ kind:z.literal('POST'), accountId:z.string().uuid(), localId:z.string().uuid() }).strict(),
  z.object({ kind:z.literal('REPLY'), accountId:z.string().uuid(), localId:z.string().min(1).max(500) }).strict(),
]);
const providerBase = { id: z.string().uuid().optional(), accountId: z.string().uuid(), enabled: z.boolean() };
export const providerConfigSchema = z.discriminatedUnion('type', [
  z.object({ ...providerBase, type: z.literal('YOUTUBE'), config: z.object({
    channel: z.string().trim().max(500),
    includeLongForm: z.boolean().default(true),
    includeShorts: z.boolean().default(true),
  }).strict().refine((value)=>value.includeLongForm||value.includeShorts,{message:'롱폼 또는 쇼츠 중 하나 이상을 선택하세요.'}) }),
  z.object({ ...providerBase, type: z.literal('BLOG'), config: z.object({ rssUrl: z.union([z.literal(''), z.string().url().max(2000)]) }).strict() }),
  z.object({ ...providerBase, type: z.literal('COUPANG'), config: z.object({
    schemaVersion: z.literal(1).default(1),
    mode: z.enum(['MANUAL_LINKS', 'OPEN_API']),
    keyLabel: z.string().trim().max(100).default(''),
    keywords: z.string().trim().max(1000).default(''),
    rocketOnly: z.boolean().default(false),
    rocketFreshOnly: z.boolean().default(false),
    keywordSearchIncluded:z.boolean().default(true),
    goldBoxIncluded:z.boolean().default(false),
    categoryBestIncluded:z.boolean().default(false),
    categoryId:coupangCategoryIdSchema.default('ALL'),
    coupangPlIncluded:z.boolean().default(false),
    coupangPlBrandId:coupangPlBrandIdSchema.default('ALL'),
    goldBoxOnly:z.boolean().optional(),
    apiVerifiedAt: z.string().datetime().optional(),
    verifiedCredentialUpdatedAt: z.object({ accessKey:z.string().datetime(), secretKey:z.string().datetime() }).strict().optional(),
  }).strict().superRefine((value,context)=>{
    if(value.mode==='OPEN_API'&&!value.keyLabel.trim())context.addIssue({code:'custom',message:'쿠팡 키 구분명을 입력하세요.',path:['keyLabel']});
  }) }),
  z.object({ ...providerBase, type:z.literal('NAVER_BRAND_CONNECT'), config:z.object({ schemaVersion:z.literal(1).default(1) }).strict() }),
]);

export const coupangQueueAddSchema = z.object({
  accountId:z.string().uuid(),
  text:z.string().trim().min(1, '쿠팡 상품 자료를 입력하세요.').max(100_000),
}).strict();
export const coupangProductSearchSchema = z.object({
  accountId:z.string().uuid(),
  keywords:z.string().trim().max(1000),
  rocketOnly:z.boolean().default(false),
  rocketFreshOnly:z.boolean().default(false),
  keywordSearchIncluded:z.boolean().default(true),
  goldBoxIncluded:z.boolean().default(false),
  categoryBestIncluded:z.boolean().default(false),
  categoryId:coupangCategoryIdSchema.default('ALL'),
  coupangPlIncluded:z.boolean().default(false),
  coupangPlBrandId:coupangPlBrandIdSchema.default('ALL'),
}).strict().superRefine((value,context)=>{
  if(!value.keywordSearchIncluded&&!value.goldBoxIncluded&&!value.categoryBestIncluded&&!value.coupangPlIncluded)
    context.addIssue({code:'custom',message:'상품 가져오기 경로를 하나 이상 포함하세요.',path:['keywordSearchIncluded']});
  if(value.keywordSearchIncluded&&!value.keywords.trim())
    context.addIssue({code:'custom',message:'키워드 검색을 포함하려면 검색 키워드를 입력하세요.',path:['keywords']});
});
export const coupangProductStageSchema = z.object({
  accountId:z.string().uuid(),
  candidateIds:z.array(z.string().uuid()).min(1,'상품을 하나 이상 선택하세요.').max(100,'검색 결과는 최대 100개입니다.'),
}).strict();
export const coupangQueueItemSchema = z.object({ accountId:z.string().uuid(), id:z.string().uuid() }).strict();
export const coupangQueuePrepareManySchema=z.object({
  accountId:z.string().uuid(),ids:z.array(z.string().uuid()).min(1,'분석할 상품을 하나 이상 선택하세요.').max(20,'한 번에 최대 20개까지 분석할 수 있습니다.'),
}).strict().refine((value)=>new Set(value.ids).size===value.ids.length,{message:'중복된 상품은 일괄 분석할 수 없습니다.',path:['ids']});
export const coupangQueueUpdateSchema = z.object({
  accountId:z.string().uuid(), id:z.string().uuid(),
  productName:z.string().trim().max(500).optional(), productNote:z.string().trim().max(2_000).optional(),
}).strict();
export const coupangQueueDraftUpdateSchema = z.object({
  accountId:z.string().uuid(),id:z.string().uuid(),expectedUpdatedAt:z.string().datetime(),
  body:z.string().trim().min(1,'본문을 입력하세요.').max(500),
}).strict();
export const coupangQueueImageRemoveSchema = z.object({
  accountId:z.string().uuid(),id:z.string().uuid(),expectedUpdatedAt:z.string().datetime(),
  imageUrl:z.string().url().refine((value)=>value.startsWith('https://'),'HTTPS 이미지만 삭제할 수 있습니다.'),
}).strict();

export const naverBrandQueueAddSchema=z.object({
  accountId:z.string().uuid(),
  text:z.string().trim().min(1,'네이버 브랜드 커넥트 상품 링크를 입력하세요.').max(100_000),
}).strict();
