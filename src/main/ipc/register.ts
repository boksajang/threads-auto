import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import path from 'node:path';
import { prepareExtensionInstallation } from '../services/extension-installation';
import type { CoupangProductQueueItem, CoupangProviderConfig, CredentialKey, SourceCandidate, SourceType } from '../../shared/domain';
import { COUPANG_CATEGORY_OPTIONS } from '../../shared/coupang-catalog';
import { POLICY } from '../../shared/policy';
import type { Repositories } from '../db/repositories';
import type { CoupangProvider, ProviderRegistry, ThreadsProvider } from '../providers/contracts';
import type { AutomationScheduler } from '../services/scheduler';
import type { CredentialManager, SettingsManager } from '../services/settings';
import type { CodexRateLimitClient } from '../codex/rate-limits';
import type { CodexRunner } from '../codex/runner';
import type { PublishEligibility } from '../services/publish-eligibility';
import type { AutomationPipeline } from '../services/pipeline';
import type { ThreadsIntegrationRuntime } from '../services/threads-integration-runtime';
import type { ThreadsOwnedContentService } from '../services/threads-owned-content';
import { redactForUi } from '../services/redaction';
import { assertCompleteAccount, normalizeAccountDefaults } from '../services/account-completeness';
import type { ThreadsAccountService } from '../services/threads-account';
import { CoupangProductResearchResolver } from '../services/coupang-product-research';
import { hasChromeCollectorInstalled, CoupangChromeCollectorError, type CoupangChromeCollectorService } from '../services/coupang-chrome-collector';
import { coupangUrlFingerprint, parseCoupangProductInput } from '../services/coupang-link-input';
import { assertCoupangPostCompliance } from '../services/coupang-compliance';
import { assertNaverBrandPostCompliance } from '../services/naver-brand-compliance';
import { parseNaverBrandProductInput } from '../services/naver-brand-link-input';
import { selectCoupangProductCandidates } from '../services/coupang-product-selection';
import { accountSaveSchema, commentListSchema, coupangProductSearchSchema, coupangProductStageSchema, coupangQueueAddSchema, coupangQueueDraftUpdateSchema, coupangQueueImageRemoveSchema, coupangQueueItemSchema, coupangQueuePrepareManySchema, coupangQueueUpdateSchema, credentialKeySchema, dashboardActivityQuerySchema, immediatePublishSchema, naverBrandQueueAddSchema, ownedContentDeleteSchema, preparedDailyPublishSchema, promotionScheduleUpdateSchema, providerConfigSchema, reportQuerySchema, settingsSchema, threadsIntegrationListSchema, threadsIntegrationRunSchema, threadsRegistrationSchema, threadsTokenUpdateSchema, writableCredentialKeySchema } from './schemas';

interface Dependencies {
  window: BrowserWindow; repositories: Repositories; settings: SettingsManager; credentials: CredentialManager;
  scheduler: AutomationScheduler; codex: CodexRunner; usage: CodexRateLimitClient; registry: ProviderRegistry;
  threads: ThreadsProvider; coupang: CoupangProvider; eligibility: PublishEligibility; pipeline:AutomationPipeline; safeUiTestMode?: boolean;
  threadsIntegration:ThreadsIntegrationRuntime; ownedContent:ThreadsOwnedContentService; threadsAccounts:ThreadsAccountService;
  coupangCollector:CoupangChromeCollectorService;
}

const accountCredentialKeys = (accountId: string): CredentialKey[] => [
  `threadsToken:${accountId}`,
  `youtubeApiKey:${accountId}`, `coupangAccessKey:${accountId}`, `coupangSecretKey:${accountId}`,
];

const scheduleFields = ['automationTarget','active','dailyEnabled','promotionEnabled','dailyRatio','promotionRatio','dailyPostTarget','commentIntervalMinutes','operationStart','operationEnd','weekdays'] as const;

function trusted(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (event.senderFrame !== window.webContents.mainFrame) throw new Error('허용되지 않은 IPC 호출입니다.');
}

export function registerIpc(deps: Dependencies): void {
  const candidateCache = new Map<string, SourceCandidate[]>();
  const coupangProductCache = new Map<string, SourceCandidate[]>();
  const threadsAccounts = deps.threadsAccounts;
  const assertThreadsPublishReady = async (accountId: string): Promise<void> => {
    await deps.eligibility.assertAccountReady(accountId);
    const tokenStatus = await threadsAccounts.tokenStatus(accountId);
    if (!tokenStatus.stored) throw new Error('Threads Access Token이 없습니다. 계정 관리에서 토큰을 연결하세요.');
    if (tokenStatus.valid === false || tokenStatus.state === 'INVALID') throw new Error('Threads Access Token이 유효하지 않습니다. 새 장기 토큰을 연결하세요.');
    if (tokenStatus.state === 'CHECK_FAILED') throw new Error('Threads 토큰 확인에 실패했습니다. 계정 관리에서 연결 확인을 다시 실행하세요.');
    if (tokenStatus.state === 'EXPIRED') throw new Error('Threads 토큰 또는 데이터 접근 기간이 만료되었습니다. 계정 관리에서 새 토큰을 연결하세요.');
    if (tokenStatus.missingScopes.length) throw new Error(`Threads 토큰에 필수 권한이 없습니다: ${tokenStatus.missingScopes.join(', ')}`);
  };
  const coupangResearch = new CoupangProductResearchResolver();
  const resolveCoupangPageResearch=async(input:ReturnType<typeof parseCoupangProductInput>)=>{
    const redirectBase=input.originalInputType==='IFRAME'
      ?await coupangResearch.resolve(input)
      :{...input,metadataStatus:'READY' as const,researchedAt:new Date().toISOString(),lastError:undefined as string|undefined};
    const redirectResearch={...redirectBase,imageUrls:redirectBase.imageUrl?[redirectBase.imageUrl]:[],
      media:redirectBase.imageUrl?[{type:'IMAGE' as const,url:redirectBase.imageUrl,position:0,source:'COUPANG_TAG' as const}]:[],
      reviewEvidence:[],researchVersion:1,reviewCount:0,reviewCollectedAt:undefined as string|undefined};
    if(redirectResearch.metadataStatus!=='READY')return redirectResearch;
    try {
      const page=await deps.coupangCollector.research({sourceUrl:redirectResearch.affiliateUrl,maxImages:20,maxReviews:8});
      const identityFacts=[`productId=${page.productId}`,...(page.itemId?[`itemId=${page.itemId}`]:[]),...(page.vendorItemId?[`vendorItemId=${page.vendorItemId}`]:[])];
      return {...redirectResearch,productName:page.productTitleRaw??redirectResearch.productName,imageUrl:page.imageUrls[0],imageUrls:page.imageUrls,
        media:page.imageUrls.map((url,position)=>({type:'IMAGE' as const,url,position,source:'COUPANG_GALLERY' as const})),
        productFacts:[...new Set([...redirectResearch.productFacts,...identityFacts,...(page.productTitleRaw?[`상품명 원문=${page.productTitleRaw}`]:[])])],
        researchSourceUrls:[...new Set([...redirectResearch.researchSourceUrls,page.finalUrl])],
        reviewEvidence:page.reviews.map((review,index)=>({id:`page-review-${index+1}`,text:review.reviewTextRaw,
          ...(review.optionTextRaw?{option:review.optionTextRaw}:{}),...(review.rating?{rating:review.rating}:{})})),
        researchVersion:2,reviewCount:page.reviews.length,reviewCollectedAt:page.collectedAt,
        metadataStatus:'READY' as const,researchedAt:page.collectedAt,lastError:undefined};
    } catch(error) {
      const message=error instanceof CoupangChromeCollectorError?error.message:'Chrome 쿠팡 수집기에서 상품 페이지를 확인하는 중 오류가 발생했습니다.';
      return {...redirectResearch,metadataStatus:'FAILED' as const,lastError:message,researchedAt:new Date().toISOString()};
    }
  };
  const refreshCoupangQueueResearch=async(accountId:string,id:string):Promise<CoupangProductQueueItem>=>{
    const current=deps.repositories.getCoupangLink(id,accountId);
    if(!current)throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
    const research=await resolveCoupangPageResearch(parseCoupangProductInput(current.affiliateUrl));
    const refreshed=deps.repositories.applyCoupangLinkResearch(id,accountId,{
      ...research,
      productName:research.productName??current.productName,
      imageUrl:research.imageUrl??current.imageUrl,imageUrls:research.imageUrls??current.imageUrls,media:research.media??current.media,
      reviewEvidence:research.reviewEvidence??current.reviewEvidence,researchVersion:research.researchVersion??current.researchVersion,
      reviewCount:research.reviewCount??current.reviewCount,reviewCollectedAt:research.reviewCollectedAt??current.reviewCollectedAt,
      productFacts:[...new Set([...current.productFacts.filter((fact)=>/^(?:(?:productId|pageKey|itemId|vendorItemId)=\d+|subId=[A-Za-z0-9_-]{1,100})$/i.test(fact)),...research.productFacts])],
      researchSourceUrls:[...new Set([...current.researchSourceUrls,...research.researchSourceUrls])],
    });
    if(refreshed.metadataStatus!=='READY')throw new Error(refreshed.lastError||'상품 링크에서 상품 식별 정보를 확인하지 못했습니다.');
    return refreshed;
  };
  const prepareCoupangQueueItem=async(accountId:string,id:string):Promise<CoupangProductQueueItem>=>{
    const current=deps.repositories.getCoupangLink(id,accountId);
    if(!current)throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
    if(current.metadataStatus!=='READY'||current.status==='INFORMATION_REQUIRED'||current.researchVersion<2||current.imageUrls.length===0)
      await refreshCoupangQueueResearch(accountId,id);
    await deps.pipeline.prepareManualCoupang(accountId,id);
    const prepared=deps.repositories.getCoupangLink(id,accountId);
    if(!prepared)throw new Error('분석한 쿠팡 상품을 다시 불러오지 못했습니다.');
    return prepared;
  };
  const resolveNaverBrandResearch=async(affiliateUrl:string)=>{
    try{
      const page=await deps.coupangCollector.researchNaverBrand({sourceUrl:affiliateUrl,maxImages:20,maxReviews:8});
      return {affiliateUrl,urlFingerprint:parseNaverBrandProductInput(affiliateUrl).urlFingerprint,
        productName:page.productTitleRaw,imageUrl:page.imageUrls[0],imageUrls:page.imageUrls,
        media:page.imageUrls.map((url,position)=>({type:'IMAGE' as const,url,position,source:'NAVER_GALLERY' as const})),
        productFacts:[...new Set([`productKey=${page.productKey}`,...(page.productTitleRaw?[`상품명 원문=${page.productTitleRaw}`]:[]),...page.productFacts])],researchSourceUrls:[page.finalUrl,affiliateUrl],
        reviewEvidence:page.reviews.map((review,index)=>({id:`naver-review-${index+1}`,text:review.reviewTextRaw,...(review.rating?{rating:review.rating}:{})})),
        researchVersion:1,reviewCount:page.reviews.length,reviewCollectedAt:page.collectedAt,
        metadataStatus:'READY' as const,researchedAt:page.collectedAt,lastError:undefined};
    }catch(error){return {affiliateUrl,urlFingerprint:parseNaverBrandProductInput(affiliateUrl).urlFingerprint,
      productFacts:[],researchSourceUrls:[affiliateUrl],reviewEvidence:[],researchVersion:1,reviewCount:0,
      metadataStatus:'FAILED' as const,researchedAt:new Date().toISOString(),lastError:error instanceof Error?error.message:String(error)};}
  };
  const refreshNaverBrandQueueResearch=async(accountId:string,id:string):Promise<CoupangProductQueueItem>=>{
    const current=deps.repositories.getNaverBrandLink(id,accountId);if(!current)throw new Error('네이버 브랜드 커넥트 상품 링크를 찾을 수 없습니다.');
    const research=await resolveNaverBrandResearch(current.affiliateUrl);
    const refreshed=deps.repositories.applyCoupangLinkResearch(id,accountId,{...research,productName:research.productName??current.productName,
      imageUrl:research.imageUrl??current.imageUrl,imageUrls:research.imageUrls??current.imageUrls,media:research.media??current.media});
    if(refreshed.metadataStatus!=='READY')throw new Error(refreshed.lastError||'네이버 상품 정보를 확인하지 못했습니다.');return refreshed;
  };
  const prepareNaverBrandQueueItem=async(accountId:string,id:string):Promise<CoupangProductQueueItem>=>{
    const current=deps.repositories.getNaverBrandLink(id,accountId);if(!current)throw new Error('네이버 브랜드 커넥트 상품 링크를 찾을 수 없습니다.');
    if(current.metadataStatus!=='READY'||current.status==='INFORMATION_REQUIRED'||current.imageUrls.length===0)await refreshNaverBrandQueueResearch(accountId,id);
    await deps.pipeline.prepareManualNaverBrand(accountId,id);
    const prepared=deps.repositories.getNaverBrandLink(id,accountId);if(!prepared)throw new Error('분석한 네이버 상품을 다시 불러오지 못했습니다.');return prepared;
  };
  const runProductSources=async(tasks:Array<()=>Promise<SourceCandidate[]>>,concurrency=4):Promise<SourceCandidate[][]>=>{
    const results:SourceCandidate[][]=[];
    for(let index=0;index<tasks.length;index+=concurrency)results.push(...await Promise.all(tasks.slice(index,index+concurrency).map((task)=>task())));
    return results;
  };
  const invalidateCoupangApiVerification = (accountId:string):void => {
    const existing=deps.repositories.listProviderConfigs(accountId).find((entry)=>entry.type==='COUPANG');
    if(!existing)return;
    const config={...existing.config};
    delete config.apiVerifiedAt;
    delete config.verifiedCredentialUpdatedAt;
    deps.repositories.saveProviderConfig({...existing,config});
  };
  const handle = <T>(channel: string, schema: z.ZodType<T> | undefined, handler: (input: T) => unknown) => {
    ipcMain.handle(channel, async (event, raw) => { trusted(event, deps.window); return handler(schema ? schema.parse(raw) : raw as T); });
  };

  handle('app:snapshot', undefined, async () => {
    const counts = deps.repositories.counts();
    const accounts = deps.repositories.listAccounts();
    const credentialStatus = await deps.credentials.status(accounts.flatMap((account) => accountCredentialKeys(account.id)));
    const runtimeBase = deps.repositories.accountRuntimeSummaries();
    const accountRuntime = Object.fromEntries(accounts.map((account) => {
      const providers = runtimeBase[account.id]?.providers ?? [];
      const providerConfigs = deps.repositories.listProviderConfigs(account.id).filter((config) => config.enabled);
      const blogConfig = providerConfigs.find((config) => config.type === 'BLOG');
      const youtubeConfig = providerConfigs.find((config) => config.type === 'YOUTUBE');
      const coupangConfig = providerConfigs.find((config) => config.type === 'COUPANG');
      const naverBrandConfig = providerConfigs.find((config) => config.type === 'NAVER_BRAND_CONNECT');
      const scoped = (name: string) => Boolean(credentialStatus[`${name}:${account.id}`]?.stored);
      const coupangKeys = { accessKey:credentialStatus[`coupangAccessKey:${account.id}`], secretKey:credentialStatus[`coupangSecretKey:${account.id}`] };
      const configuredMode = coupangConfig?.config?.mode;
      const coupangMode = configuredMode === 'OPEN_API' || configuredMode === 'MANUAL_LINKS'
        ? configuredMode : coupangKeys.accessKey?.stored && coupangKeys.secretKey?.stored ? 'OPEN_API' : 'MANUAL_LINKS';
      const verifiedAt = coupangConfig?.config?.verifiedCredentialUpdatedAt as CoupangProviderConfig['verifiedCredentialUpdatedAt'];
      const coupangApiReady = Boolean(coupangConfig?.config?.apiVerifiedAt
        && coupangKeys.accessKey?.stored && coupangKeys.secretKey?.stored
        && verifiedAt?.accessKey === coupangKeys.accessKey.updatedAt && verifiedAt?.secretKey === coupangKeys.secretKey.updatedAt);
      const queue = deps.repositories.coupangLinkSummary(account.id);
      const prepared = queue.byStatus.PREVIEW_READY;
      const queueReady = queue.byStatus.QUEUED + queue.byStatus.PROCESSING + queue.byStatus.PREVIEW_READY;
      const queueAttention = queue.metadataAttention + queue.byStatus.REVIEW_REQUIRED + queue.byStatus.FAILED;
      const coupangReady = coupangMode === 'OPEN_API' ? coupangApiReady : prepared > 0;
      const coupangMessage = coupangMode === 'OPEN_API'
        ? coupangApiReady ? 'Open API 연결 완료' : '필요한 정보 · Open API 연결 확인'
        : prepared > 0 ? `발행 준비 상품 ${prepared}건${queueAttention ? ` · 확인 ${queueAttention}건` : ''}`
          : queueReady > 0 ? `상품 ${queueReady}건 준비 중${queueAttention ? ` · 확인 ${queueAttention}건` : ''}`
          : queueAttention > 0 ? `필요한 정보 · 상품 확인 ${queueAttention}건` : '필요한 정보 · 상품 자료 등록';
      const naverQueue=deps.repositories.naverBrandLinkSummary(account.id);
      const naverPrepared=naverQueue.byStatus.PREVIEW_READY;
      const naverQueued=naverQueue.byStatus.QUEUED+naverQueue.byStatus.PROCESSING+naverPrepared;
      const naverAttention=naverQueue.metadataAttention+naverQueue.byStatus.REVIEW_REQUIRED+naverQueue.byStatus.FAILED;
      const naverMessage=naverPrepared>0?`발행 준비 상품 ${naverPrepared}건${naverAttention?` · 확인 ${naverAttention}건`:''}`
        :naverQueued>0?`상품 ${naverQueued}건 준비 중${naverAttention?` · 확인 ${naverAttention}건`:''}`
          :naverAttention>0?`필요한 정보 · 상품 확인 ${naverAttention}건`:'필요한 정보 · 상품 링크 등록';
      return [account.id, { ...runtimeBase[account.id], credentials: {
        threads: Boolean(account.threadsUserId) && scoped('threadsToken'),
        youtube: scoped('youtubeApiKey'),
        coupang: coupangApiReady,
      }, providerConfiguration: {
        blog: Boolean(String(blogConfig?.config?.rssUrl ?? '').trim()),
        youtube: Boolean(String(youtubeConfig?.config?.channel ?? '').trim())
          &&(youtubeConfig?.config?.includeLongForm!==false||youtubeConfig?.config?.includeShorts!==false),
        coupang: Boolean(coupangConfig), naverBrandConnect:Boolean(naverBrandConfig),
      }, coupang:{ mode:coupangMode, ready:coupangReady, message:coupangMessage, queued:queueReady, prepared, attention:queueAttention },
        naverBrand:{ready:naverPrepared>0,message:naverMessage,queued:naverQueued,prepared:naverPrepared,attention:naverAttention},providers }];
    }));
    const targets = accounts.filter((account) => account.active && account.automationTarget);
    const readyTargets = targets.filter((account) => accountRuntime[account.id]?.credentials.threads);
    const youtubeAccounts = accounts.filter((account) => accountRuntime[account.id]?.providers.includes('YOUTUBE'));
    const coupangAccounts = accounts.filter((account) => accountRuntime[account.id]?.providers.includes('COUPANG'));
    const youtubeReady = youtubeAccounts.filter((account) => accountRuntime[account.id]?.credentials.youtube).length;
    const coupangReady = coupangAccounts.filter((account) => accountRuntime[account.id]?.coupang?.ready).length;
    const diagnosticLogs = deps.repositories.recentLogs(200)
      .filter((log) => log.level === 'WARN' || log.level === 'ERROR')
      .map((log) => ({ ...log, detail:undefined, diagnosticSummary:redactForUi(log.detail) }));
    return { accounts, logs: diagnosticLogs, settings: await deps.settings.read(), pendingJobs: deps.repositories.pendingJobs(), runningJobs:deps.repositories.runningJobs(), pipelineRuns:deps.repositories.listPipelineRuns(undefined, 100), dashboard: {
      automationRunning: deps.scheduler.isRunning(), accountCount: counts.accounts, automationAccountCount: counts.automation,
      todaySuccessCount: counts.successToday, failedJobCount: counts.failed, pendingJobCount: counts.pending,
      recentPosts: deps.repositories.recentPosts(100), recentErrors: diagnosticLogs.filter((log) => log.level === 'ERROR').slice(0,20),
      codex: await deps.codex.health(), usage: deps.usage.current(), apiStatus: {
        Threads: { ready: targets.length > 0 && readyTargets.length === targets.length, message: targets.length ? `${readyTargets.length}/${targets.length}개 발행 준비` : '자동화 계정 없음' },
        YouTube: { ready: youtubeAccounts.length > 0 && youtubeReady === youtubeAccounts.length, message: youtubeAccounts.length ? `${youtubeReady}/${youtubeAccounts.length}개 Key 준비` : '사용 계정 없음' },
        Coupang: { ready: coupangAccounts.length > 0 && coupangReady === coupangAccounts.length, message: coupangAccounts.length ? `${coupangReady}/${coupangAccounts.length}개 계정 준비` : '사용 계정 없음' },
      },
    }, accountRuntime };
  });
  handle('accounts:register-threads', threadsRegistrationSchema, ({ accessToken }) => threadsAccounts.register(accessToken));
  handle('accounts:update-threads-token', threadsTokenUpdateSchema, ({ accountId, accessToken }) => threadsAccounts.updateToken(accountId, accessToken));
  handle('accounts:verify-threads', z.string().uuid(), (accountId) => threadsAccounts.verifyStoredToken(accountId));
  handle('accounts:threads-token-status', z.string().uuid(), (accountId) => threadsAccounts.tokenStatus(accountId));
  handle('accounts:refresh-threads-token', z.string().uuid(), async (accountId) => {
    if (deps.safeUiTestMode) throw new Error('안전 UI 테스트 모드에서는 Threads 토큰을 연장할 수 없습니다.');
    try {
      const status = await threadsAccounts.refreshStoredToken(accountId);
      deps.repositories.addLog('INFO', 'THREADS_TOKEN', 'Threads 장기 토큰을 연장했습니다.', undefined, accountId);
      return status;
    } catch (error) {
      const detail = error instanceof Error ? error.message : '알 수 없는 오류';
      deps.repositories.addLog('ERROR', 'THREADS_TOKEN', 'Threads 장기 토큰을 연장하지 못했습니다.', detail, accountId);
      throw error;
    }
  });
  handle('accounts:save', accountSaveSchema, async (input) => {
    const normalizedAccountInput = normalizeAccountDefaults(input);
    const tokenKey = normalizedAccountInput.id ? `threadsToken:${normalizedAccountInput.id}` as CredentialKey : undefined;
    const storedToken = tokenKey ? Boolean((await deps.credentials.status([tokenKey]))[tokenKey]?.stored) : false;
    if (normalizedAccountInput.automationTarget) assertCompleteAccount(normalizedAccountInput, storedToken);
    if (normalizedAccountInput.automationTarget && !normalizedAccountInput.id) throw new Error('계정을 먼저 저장하고 Threads 토큰을 등록한 뒤 자동화 대상으로 설정하세요.');
    if (!normalizedAccountInput.id) throw new Error('Threads Access Token으로 계정을 먼저 등록하세요.');
    const previous=deps.repositories.getAccount(normalizedAccountInput.id);
    const saved=deps.repositories.saveAccount(normalizedAccountInput);
    const scheduleChanged=!previous||scheduleFields.some((key)=>JSON.stringify(previous[key])!==JSON.stringify(saved[key]));
    if(scheduleChanged){
      const currentSettings=await deps.settings.read();
      if(currentSettings.schedulerEnabled)await deps.settings.save({...currentSettings,schedulerEnabled:false});
      await deps.scheduler.stopAndClearSchedules();
      deps.repositories.addLog('INFO','SCHEDULER','계정 자동화 설정이 변경되어 전체 스케줄을 중지했습니다. 대시보드에서 다시 시작하면 저장된 최신 설정으로 계획을 생성합니다.',undefined,saved.id);
    }
    return saved;
  });
  handle('accounts:delete', z.string().uuid(), async (id) => {
    for (const key of accountCredentialKeys(id)) await deps.credentials.delete(key);
    deps.repositories.deleteAccount(id);
  });
  handle('providers:list', z.string().uuid(), (accountId) => deps.repositories.listProviderConfigs(accountId));
  handle('providers:save', providerConfigSchema, (input) => deps.repositories.saveProviderConfig(input));
  handle('providers:delete', z.object({ accountId:z.string().uuid(), type:z.enum(['YOUTUBE','BLOG','COUPANG','NAVER_BRAND_CONNECT']) }), ({ accountId, type }) => deps.repositories.deleteProviderConfig(accountId, type));
  handle('coupang-products:search', coupangProductSearchSchema, async ({accountId,keywords,rocketOnly,rocketFreshOnly,keywordSearchIncluded,goldBoxIncluded,categoryBestIncluded,categoryId,coupangPlIncluded,coupangPlBrandId}) => {
    const account=deps.repositories.getAccount(accountId);
    if(!account?.active)throw new Error('활성 Threads 계정을 선택하세요.');
    const config=deps.repositories.listProviderConfigs(accountId).find((entry)=>entry.type==='COUPANG'&&entry.enabled);
    if(config?.config.mode!=='OPEN_API')throw new Error('계정관리에서 쿠팡 최종 승인 완료 방식을 저장하세요.');
    if(!config.config.apiVerifiedAt)throw new Error('계정관리에서 쿠팡 Open API 연결 확인을 완료하세요.');
    const terms=[...new Set(keywords.split(/[,\r\n]+/).map((value)=>value.trim()).filter(Boolean))].slice(0,10);
    const tasks:Array<()=>Promise<SourceCandidate[]>>=[];
    if(keywordSearchIncluded)for(const keyword of terms)tasks.push(()=>deps.coupang.search(account,rocketFreshOnly?`${keyword} 로켓프레시`:keyword));
    if(goldBoxIncluded)tasks.push(()=>deps.coupang.goldbox(account));
    if(categoryBestIncluded){
      const categoryIds=categoryId==='ALL'?COUPANG_CATEGORY_OPTIONS.map(([id])=>id):[categoryId];
      for(const selectedCategoryId of categoryIds)tasks.push(()=>deps.coupang.bestCategory(account,selectedCategoryId));
    }
    if(coupangPlIncluded)tasks.push(()=>deps.coupang.coupangPl(account,coupangPlBrandId==='ALL'?undefined:coupangPlBrandId));
    const batches=await runProductSources(tasks);
    const registeredProductIds=new Set(deps.repositories.listCoupangLinks(accountId).flatMap((item)=>item.productFacts
      .map((fact)=>/^productId=(\d+)$/i.exec(fact)?.[1]).filter((value):value is string=>Boolean(value))));
    const candidates=selectCoupangProductCandidates(batches.flat(),{keywords:terms,rocketOnly,rocketFreshOnly,limit:100,excludedSourceKeys:registeredProductIds});
    coupangProductCache.set(accountId,candidates);
    deps.repositories.addLog('INFO','COUPANG',`등록·발행 이력을 제외한 쿠팡 상품 후보 ${candidates.length}건을 불러왔습니다.`,undefined,accountId);
    return candidates;
  });
  handle('coupang-products:stage', coupangProductStageSchema, async ({accountId,candidateIds}) => {
    const account=deps.repositories.getAccount(accountId);
    if(!account?.active)throw new Error('활성 Threads 계정을 선택하세요.');
    const config=deps.repositories.listProviderConfigs(accountId).find((entry)=>entry.type==='COUPANG'&&entry.enabled);
    if(config?.config.mode!=='OPEN_API'||!config.config.apiVerifiedAt)throw new Error('쿠팡 Open API 연결 상태를 먼저 확인하세요.');
    const cached=coupangProductCache.get(accountId)??[];
    const selected=candidateIds.map((id)=>cached.find((candidate)=>candidate.id===id));
    if(selected.some((candidate)=>!candidate))throw new Error('상품 검색 결과가 만료되었습니다. 다시 검색하세요.');
    const staged:CoupangProductQueueItem[]=[];
    for(const candidate of selected as SourceCandidate[]){
      const productId=String(candidate.sourceKey);
      const affiliateUrl=await deps.coupang.deepLink(accountId,candidate.sourceUrl);
      const imageUrl=candidate.imageUrl?.trim();
      if(!imageUrl)throw new Error(`${candidate.title} 상품의 대표 이미지를 API에서 확인하지 못했습니다.`);
      try{
        staged.push(deps.repositories.createCoupangLink({
          accountId,originalInputType:'PLAIN_LINK',affiliateUrl,urlFingerprint:coupangUrlFingerprint(affiliateUrl),
          productName:candidate.title,imageUrl,imageUrls:[imageUrl],media:[{type:'IMAGE',url:imageUrl,position:0,source:'PROVIDER'}],
          productFacts:[`productId=${productId}`],researchSourceUrls:[candidate.sourceUrl,affiliateUrl,imageUrl],
          researchVersion:1,reviewCount:0,metadataStatus:'READY',researchedAt:new Date().toISOString(),
        }));
      }catch(error){
        if(!/UNIQUE constraint failed/i.test(error instanceof Error?error.message:String(error)))throw error;
      }
    }
    if(!staged.length)throw new Error('선택한 상품이 이미 이 Threads 계정의 상품 목록에 등록되어 있습니다.');
    deps.repositories.addLog('INFO','COUPANG',`선택한 API 상품 ${staged.length}건을 분석 대기 목록에 추가했습니다.`,undefined,accountId);
    return staged;
  });
  handle('coupang-queue:list', z.string().uuid(), (accountId) => deps.repositories.listPendingCoupangLinks(accountId));
  handle('coupang-queue:add', coupangQueueAddSchema, async ({ accountId, text }) => {
    const config=deps.repositories.listProviderConfigs(accountId).find((entry)=>entry.type==='COUPANG'&&entry.enabled);
    if(config?.config?.mode!=='MANUAL_LINKS')throw new Error('쿠팡 운영 방식을 ‘최종 승인 전’으로 저장한 뒤 상품 자료를 등록하세요.');
    const trimmed=text.trim();
    const entries=/^\s*</.test(trimmed)?[trimmed]:trimmed.split(/\r?\n/).map((value)=>value.trim()).filter(Boolean);
    if(entries.length>100)throw new Error('쿠팡 상품 자료는 한 번에 최대 100개까지 등록할 수 있습니다.');
    const parsed=entries.map(parseCoupangProductInput);
    const created:CoupangProductQueueItem[]=[];
    const failures:string[]=[];
    for(const item of parsed){
      const research=await resolveCoupangPageResearch(item);
      if(research.metadataStatus!=='READY'){
        failures.push(research.lastError||'상품 페이지의 이미지와 상품 정보를 확인하지 못했습니다.');
        continue;
      }
      let queued:CoupangProductQueueItem|undefined;
      try {
        queued=deps.repositories.createCoupangLink({accountId,originalInputType:item.originalInputType,productNote:'',...research});
        await deps.pipeline.prepareManualCoupang(accountId,queued.id);
        const prepared=deps.repositories.getCoupangLink(queued.id,accountId);
        if(prepared?.status!=='PREVIEW_READY'||!prepared.draftPostId)throw new Error('이미지와 최종 발행 본문 준비가 완료되지 않았습니다.');
        created.push(prepared);
      } catch(error) {
        if(queued)deps.repositories.abortNewCoupangRegistration(queued.id,accountId);
        const message=error instanceof Error?error.message:String(error);
        failures.push(/UNIQUE constraint failed/i.test(message)?'이미 등록된 쿠팡 상품 링크입니다.':message);
      }
    }
    if(failures.length){
      const summary=created.length
        ? `${created.length}건은 등록했고 ${failures.length}건은 준비 실패로 등록하지 않았습니다.`
        : '상품 자료 준비에 실패해 계정관리 목록에 등록하지 않았습니다.';
      deps.repositories.addLog('WARN','COUPANG',summary,failures.join('\n'),accountId);
      throw new Error(`${summary} ${failures[0]}`);
    }
    const results=deps.repositories.listCoupangLinks(accountId).filter((item)=>created.some((createdItem)=>createdItem.id===item.id));
    deps.repositories.addLog('INFO','COUPANG',
      `쿠팡 상품 자료 ${results.length}건을 분석했습니다. 이미지와 최종 발행 본문을 저장했습니다.`,undefined,accountId);
    return results;
  });
  handle('coupang-queue:update', coupangQueueUpdateSchema, ({accountId,id,...patch}) => deps.repositories.updateCoupangLinkDetails(id,accountId,patch));
  handle('coupang-queue:update-draft', coupangQueueDraftUpdateSchema, ({accountId,id,body,expectedUpdatedAt}) => {
    const current=deps.repositories.getCoupangLink(id,accountId);
    if(!current)throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
    assertCoupangPostCompliance(body,current.affiliateUrl);
    return deps.repositories.updatePreparedCoupangCopy(id,accountId,body,expectedUpdatedAt);
  });
  handle('coupang-queue:remove-image', coupangQueueImageRemoveSchema, ({accountId,id,imageUrl,expectedUpdatedAt}) =>
    deps.repositories.removePreparedCoupangImage(id,accountId,imageUrl,expectedUpdatedAt));
  handle('coupang-queue:delete', coupangQueueItemSchema, ({accountId,id}) => {
    if(!deps.repositories.deleteCoupangLink(id,accountId))throw new Error('처리 중이거나 발행 완료된 상품은 대기열에서 삭제할 수 없습니다.');
    return true;
  });
  handle('coupang-queue:prepare', coupangQueueItemSchema, async ({accountId,id}) => {
    return prepareCoupangQueueItem(accountId,id);
  });
  handle('coupang-queue:prepare-many', coupangQueuePrepareManySchema, async ({accountId,ids}) => {
    const prepared:string[]=[];const failed:Array<{id:string;message:string}>=[];
    for(const id of ids){
      const item=deps.repositories.getCoupangLink(id,accountId);
      if(!item||!['QUEUED','INFORMATION_REQUIRED'].includes(item.status)){failed.push({id,message:'일괄 분석 가능한 준비 대기 상품이 아닙니다.'});continue;}
      try{await prepareCoupangQueueItem(accountId,id);prepared.push(id);}catch(error){failed.push({id,message:error instanceof Error?error.message:String(error)});}
    }
    deps.repositories.addLog(failed.length?'WARN':'INFO','COUPANG',`쿠팡 상품 일괄 분석 ${prepared.length}건 완료${failed.length?` · ${failed.length}건 실패`:''}.`,failed.map((item)=>item.message).join('\n')||undefined,accountId);
    return {prepared,failed};
  });
  handle('coupang-queue:retry', coupangQueueItemSchema, async ({accountId,id}) => {
    const current=deps.repositories.getCoupangLink(id,accountId);
    if(!current)throw new Error('쿠팡 상품 링크를 찾을 수 없습니다.');
    // 사용자가 명시적으로 다시 준비를 요청한 경우에는 기존 조사 버전이 최신이어도
    // Chrome의 현재 페이지에서 이미지와 후기 근거를 다시 수집한다. 확장 프로그램이나
    // 상품 페이지 DOM이 갱신된 뒤에도 reviewCount=0인 과거 결과가 재사용되는 일을 막는다.
    deps.repositories.retryCoupangLink(id,accountId);
    await refreshCoupangQueueResearch(accountId,id);
    await deps.pipeline.prepareManualCoupang(accountId,id);
    return deps.repositories.getCoupangLink(id,accountId);
  });
  handle('coupang-queue:summary', z.string().uuid(), (accountId) => deps.repositories.coupangLinkSummary(accountId));
  handle('naver-brand-queue:list', z.string().uuid(), (accountId) => deps.repositories.listPendingNaverBrandLinks(accountId));
  handle('naver-brand-queue:add', naverBrandQueueAddSchema, async ({accountId,text})=>{
    const config=deps.repositories.listProviderConfigs(accountId).find((entry)=>entry.type==='NAVER_BRAND_CONNECT'&&entry.enabled);
    if(!config)throw new Error('계정관리에서 네이버 브랜드 커넥트 사용을 먼저 저장하세요.');
    const entries=[...new Set(text.split(/\r?\n/).map((value)=>value.trim()).filter(Boolean))];
    if(entries.length>100)throw new Error('네이버 브랜드 커넥트 상품 링크는 한 번에 최대 100개까지 등록할 수 있습니다.');
    const created:CoupangProductQueueItem[]=[];const failures:string[]=[];
    for(const entry of entries){
      let queued:CoupangProductQueueItem|undefined;
      try{
        const parsed=parseNaverBrandProductInput(entry);const research=await resolveNaverBrandResearch(parsed.affiliateUrl);
        if(research.metadataStatus!=='READY')throw new Error(research.lastError||'네이버 상품 페이지에서 이미지와 상품 정보를 확인하지 못했습니다.');
        queued=deps.repositories.createCoupangLink({accountId,providerType:'NAVER_BRAND_CONNECT',originalInputType:'PLAIN_LINK',productNote:'',...research});
        await deps.pipeline.prepareManualNaverBrand(accountId,queued.id);
        const prepared=deps.repositories.getNaverBrandLink(queued.id,accountId);
        if(prepared?.status!=='PREVIEW_READY'||!prepared.draftPostId)throw new Error('이미지와 최종 발행 본문 준비가 완료되지 않았습니다.');
        created.push(prepared);
      }catch(error){if(queued)deps.repositories.abortNewCoupangRegistration(queued.id,accountId);const message=error instanceof Error?error.message:String(error);failures.push(/UNIQUE constraint failed/i.test(message)?'이미 등록된 네이버 브랜드 커넥트 상품 링크입니다.':message);}
    }
    if(failures.length){const summary=created.length?`${created.length}건은 등록했고 ${failures.length}건은 준비 실패로 등록하지 않았습니다.`:'상품 자료 준비에 실패해 대기열에 등록하지 않았습니다.';deps.repositories.addLog('WARN','NAVER_BRAND_CONNECT',summary,failures.join('\n'),accountId);throw new Error(`${summary} ${failures[0]}`);}
    deps.repositories.addLog('INFO','NAVER_BRAND_CONNECT',`네이버 브랜드 커넥트 상품 ${created.length}건의 이미지와 최종 발행 본문을 저장했습니다.`,undefined,accountId);return created;
  });
  handle('naver-brand-queue:update-draft', coupangQueueDraftUpdateSchema, ({accountId,id,body,expectedUpdatedAt})=>{
    const current=deps.repositories.getNaverBrandLink(id,accountId);if(!current)throw new Error('네이버 브랜드 커넥트 상품 링크를 찾을 수 없습니다.');
    assertNaverBrandPostCompliance(body,current.affiliateUrl);return deps.repositories.updatePreparedNaverBrandCopy(id,accountId,body,expectedUpdatedAt);
  });
  handle('naver-brand-queue:remove-image', coupangQueueImageRemoveSchema, ({accountId,id,imageUrl,expectedUpdatedAt})=>deps.repositories.removePreparedCoupangImage(id,accountId,imageUrl,expectedUpdatedAt));
  handle('naver-brand-queue:delete', coupangQueueItemSchema, ({accountId,id})=>{if(!deps.repositories.deleteCoupangLink(id,accountId))throw new Error('처리 중이거나 발행 완료된 상품은 대기열에서 삭제할 수 없습니다.');return true;});
  handle('naver-brand-queue:prepare', coupangQueueItemSchema, ({accountId,id})=>prepareNaverBrandQueueItem(accountId,id));
  handle('naver-brand-queue:retry', coupangQueueItemSchema, async ({accountId,id})=>{const current=deps.repositories.getNaverBrandLink(id,accountId);if(!current)throw new Error('네이버 브랜드 커넥트 상품 링크를 찾을 수 없습니다.');deps.repositories.retryCoupangLink(id,accountId);await refreshNaverBrandQueueResearch(accountId,id);await deps.pipeline.prepareManualNaverBrand(accountId,id);return deps.repositories.getNaverBrandLink(id,accountId);});
  handle('naver-brand-queue:summary', z.string().uuid(), (accountId)=>deps.repositories.naverBrandLinkSummary(accountId));
  handle('coupang-collector:status', undefined, async () => { const status=deps.coupangCollector.status();return {...status,installed:status.connected||await hasChromeCollectorInstalled()}; });
  handle('coupang-collector:acknowledge-prompt', undefined, () => deps.coupangCollector.acknowledgePrompt());
  const extensionInstallation = () => app.isPackaged
    ? prepareExtensionInstallation(path.join(process.resourcesPath, 'chrome-extension'), path.join(app.getPath('userData'), 'extensions', 'chrome-extension'))
    : prepareExtensionInstallation(path.join(app.getAppPath(), 'chrome-extension'));
  handle('coupang-collector:installation', undefined, extensionInstallation);
  handle('coupang-collector:open-folder', undefined, async () => {
    const installation = await extensionInstallation();
    const error = await shell.openPath(installation.directory);
    if (error) throw new Error('폴더를 열지 못했습니다. 표시된 경로를 복사해서 직접 열어 주세요.');
    return installation;
  });
  handle('coupang-collector:open-store', undefined, async () => {
    const status=deps.coupangCollector.status();
    await shell.openExternal(status.webStoreUrl);
    return status;
  });
  handle('settings:save', settingsSchema, async (input) => {
    if (input.schedulerEnabled && deps.safeUiTestMode) throw new Error('안전 UI 테스트 모드에서는 자동화를 시작할 수 없습니다.');
    if (input.schedulerEnabled) await deps.eligibility.assertAutomationReady();
    await deps.settings.save(input);
    app.setLoginItemSettings({ openAtLogin: input.launchAtStartup });
    if(input.schedulerEnabled){
      if(deps.scheduler.isRunning())await deps.scheduler.rebuildSchedules();
      else await deps.scheduler.startFresh();
    }else await deps.scheduler.stopAndClearSchedules();
    return input;
  });
  handle('credentials:status', z.array(credentialKeySchema).max(100), (keys) => deps.credentials.status(keys as CredentialKey[]));
  handle('credentials:save', z.object({ key: writableCredentialKeySchema, value: z.string().min(1).max(10_000) }), async ({ key, value }) => {
    await deps.credentials.set(key as CredentialKey, value);
    const match=/^coupang(?:Access|Secret)Key:([0-9a-f-]{36})$/i.exec(key);
    if(match)invalidateCoupangApiVerification(match[1]);
  });
  handle('credentials:delete', credentialKeySchema, async (key) => {
    const match = /^threadsToken:([0-9a-f-]{36})$/i.exec(key);
    if (match) await deps.eligibility.removeThreadsAccess(match[1]);
    else {
      await deps.credentials.delete(key as CredentialKey);
      const coupangMatch=/^coupang(?:Access|Secret)Key:([0-9a-f-]{36})$/i.exec(key);
      if(coupangMatch)invalidateCoupangApiVerification(coupangMatch[1]);
    }
    return true;
  });
  handle('connections:test', z.object({ type: z.enum(['THREADS','YOUTUBE','BLOG','COUPANG']), accountId: z.string().uuid().optional(), config: z.record(z.string(), z.unknown()).default({}) }), async ({ type, accountId, config }) => {
    let result;
    if (type === 'THREADS') {
      if (!accountId) throw new Error('Threads 계정을 선택하세요.');
      const account = await threadsAccounts.verifyStoredToken(accountId);
      result = { ok:true, message:`Threads 연결에 성공했습니다. (${account.name} · @${account.threadsHandle})` };
    }
    else if (type === 'COUPANG') {
      if (!accountId) throw new Error('쿠팡 계정을 선택하세요.');
      const existing=deps.repositories.listProviderConfigs(accountId).find((entry)=>entry.type==='COUPANG'&&entry.enabled);
      if(existing?.config.mode!=='OPEN_API')throw new Error('쿠팡 최종 승인 완료(Open API) 방식을 먼저 저장하세요.');
      result = await deps.coupang.test(accountId);
      if(result.ok){
        const accessKey=`coupangAccessKey:${accountId}` as CredentialKey;
        const secretKey=`coupangSecretKey:${accountId}` as CredentialKey;
        const status=await deps.credentials.status([accessKey,secretKey]);
        const accessUpdatedAt=status[accessKey]?.updatedAt;
        const secretUpdatedAt=status[secretKey]?.updatedAt;
        if(!accessUpdatedAt||!secretUpdatedAt)throw new Error('쿠팡 Open API 키 두 개를 모두 저장한 뒤 연결을 확인하세요.');
        deps.repositories.saveProviderConfig({...existing,config:{...existing.config,schemaVersion:1,mode:'OPEN_API',apiVerifiedAt:new Date().toISOString(),verifiedCredentialUpdatedAt:{accessKey:accessUpdatedAt,secretKey:secretUpdatedAt}}});
      }
    }
    else { const provider = deps.registry.discovery(type); if (!provider || !accountId) throw new Error('Provider 설정을 확인하세요.'); result = await provider.test(accountId, config); }
    deps.repositories.addLog(result.ok ? 'INFO' : 'WARN', 'CONNECTION', result.message, undefined, accountId);
    return result;
  });
  handle('automation:set', z.boolean(), async (enabled) => {
    if (enabled && deps.safeUiTestMode) throw new Error('안전 UI 테스트 모드에서는 자동화를 시작할 수 없습니다.');
    if (enabled) await deps.eligibility.assertAutomationReady();
    const current = await deps.settings.read();
    await deps.settings.save({ ...current, schedulerEnabled: enabled });
    let cancelled:number;let scheduled=0;
    if(enabled){
      const result=await deps.scheduler.startFresh();
      cancelled=result.cancelled;scheduled=result.scheduled;
    }else cancelled=await deps.scheduler.stopAndClearSchedules();
    return {running:deps.scheduler.isRunning(),cancelled,scheduled,pendingJobCount:deps.repositories.pendingJobs().length};
  });
  handle('automation:cancel', z.string().min(1).max(500), (id) => deps.repositories.cancelJob(id));
  handle('automation:update-promotion-type', promotionScheduleUpdateSchema, async ({jobId,accountId,sourceType}) => {
    const account=deps.repositories.getAccount(accountId);
    if(!account)throw new Error('예약 계정을 찾을 수 없습니다.');
    const config=deps.repositories.listProviderConfigs(accountId).find(entry=>entry.type===sourceType&&entry.enabled);
    if(!config)throw new Error(`${sourceType==='YOUTUBE'?'YouTube':sourceType==='BLOG'?'블로그':'쿠팡'} 콘텐츠가 이 계정에서 사용 설정되지 않았습니다.`);
    if(sourceType==='BLOG'&&!String(config.config.rssUrl??'').trim())throw new Error('블로그 주소를 먼저 설정하세요.');
    if(sourceType==='YOUTUBE'){
      if(!String(config.config.channel??'').trim())throw new Error('YouTube 채널을 먼저 설정하세요.');
      if(config.config.includeLongForm===false&&config.config.includeShorts===false)throw new Error('YouTube 롱폼 또는 쇼츠 중 하나 이상을 선택하세요.');
      const key=`youtubeApiKey:${accountId}` as CredentialKey;
      if(!(await deps.credentials.status([key]))[key]?.stored)throw new Error('YouTube Data API Key를 먼저 저장하세요.');
    }
    if(sourceType==='COUPANG'){
      const prepared=deps.repositories.coupangLinkSummary(accountId).byStatus.PREVIEW_READY;
      const reserved=deps.repositories.pendingJobs(1_000).filter(job=>job.id!==jobId&&job.accountId===accountId
        &&job.kind==='PUBLISH'&&job.payload.contentMode==='PROMOTION'&&job.payload.sourceType==='COUPANG').length;
      if(reserved>=prepared)throw new Error(`발행 준비 완료된 쿠팡 상품은 ${prepared}건이며 이미 ${reserved}건이 다른 예약에 배정되어 있습니다.`);
    }
    if(sourceType==='NAVER_BRAND_CONNECT'){
      const prepared=deps.repositories.naverBrandLinkSummary(accountId).byStatus.PREVIEW_READY;
      const reserved=deps.repositories.pendingJobs(1_000).filter(job=>job.id!==jobId&&job.accountId===accountId&&job.kind==='PUBLISH'&&job.payload.contentMode==='PROMOTION'&&job.payload.sourceType==='NAVER_BRAND_CONNECT').length;
      if(reserved>=prepared)throw new Error(`발행 준비 완료된 네이버 브랜드 커넥트 상품은 ${prepared}건이며 이미 ${reserved}건이 다른 예약에 배정되어 있습니다.`);
    }
    return deps.repositories.updatePendingPromotionSource(jobId,accountId,sourceType);
  });
  handle('pipeline:list', z.object({ accountId:z.string().uuid().optional(), limit:z.number().int().min(1).max(100).default(50), offset:z.number().int().min(0).max(1_000_000).default(0) }), ({ accountId, limit, offset }) => deps.repositories.listPipelineRuns(accountId, limit, offset));
  handle('content:post', z.object({accountId:z.string().uuid(),postId:z.string().uuid()}).strict(), ({accountId,postId}) => {
    const post=deps.repositories.getPost(postId);
    if(!post||post.accountId!==accountId)throw new Error('이 계정의 게시 이력을 찾을 수 없습니다.');
    return post;
  });
  handle('comments:list', commentListSchema, ({ accountId, limit, postId }) => ({
    summary:deps.repositories.commentSummary(accountId,postId), items:deps.repositories.listComments({accountId,limit,postId}),
  }));
  handle('threads-integration:list', threadsIntegrationListSchema, ({ accountId, limit }) => deps.threadsIntegration.list(accountId,limit));
  handle('threads-integration:get', threadsIntegrationRunSchema, ({ runId }) => deps.threadsIntegration.get(runId));
  handle('threads-integration:recover', threadsIntegrationRunSchema, ({ runId }) => deps.threadsIntegration.recover(runId));
  handle('threads-integration:start', z.object({accountId:z.string().uuid()}).strict(), async ({accountId}) => {
    if (deps.safeUiTestMode) throw new Error('안전 UI 테스트 모드에서는 실제 Threads 통합 테스트를 실행할 수 없습니다.');
    return deps.threadsIntegration.start(accountId);
  });
  handle('threads-content:delete', ownedContentDeleteSchema, ({kind,accountId,localId}) => kind==='POST'
    ? deps.ownedContent.deletePost(accountId,localId)
    : deps.ownedContent.deleteReply(accountId,localId));
  handle('dashboard:activity', dashboardActivityQuerySchema, ({ accountId, from, to, limit }) => {
    const result = deps.repositories.dashboardActivity(accountId, from, to, limit);
    return { ...result, operationalIssues:result.operationalIssues.map((log) => ({ ...log, detail:undefined, diagnosticSummary:redactForUi(log.detail) })) };
  });
  handle('content:discover', z.object({ accountId:z.string().uuid(), type:z.enum(['YOUTUBE','BLOG']) }), async ({ accountId, type }) => {
    const account = deps.repositories.getAccount(accountId);
    if (!account?.active) throw new Error('활성 계정을 선택하세요.');
    const config = deps.repositories.listProviderConfigs(accountId).find((entry) => entry.type === type && entry.enabled);
    const provider = deps.registry.discovery(type);
    if (!config || !provider) throw new Error(`${type === 'YOUTUBE' ? 'YouTube' : '블로그'} 연동 설정이 활성화되지 않았습니다.`);
    deps.repositories.addLog('INFO', 'SOURCE', `${type === 'YOUTUBE' ? 'YouTube' : '블로그'} 자료를 가져오고 있습니다.`, undefined, accountId);
    try {
      const candidates = (await provider.discover(account, config.config)).reverse().slice(0, 20);
      candidateCache.set(accountId, candidates);
      deps.repositories.addLog('INFO', 'SOURCE', `자료 ${candidates.length}개를 가져왔습니다.`, undefined, accountId);
      return candidates;
    } catch (error) {
      deps.repositories.addLog('ERROR', 'SOURCE', '자료를 가져오지 못했습니다.', error instanceof Error ? error.message : String(error), accountId);
      throw error;
    }
  });
  handle('content:preview', z.object({ accountId:z.string().uuid(), sourceId:z.string().uuid().optional() }), async ({ accountId, sourceId }) => {
    const account = deps.repositories.getAccount(accountId);
    if (!account?.active) throw new Error('활성 계정을 선택하세요.');
    const active = deps.repositories.listPipelineRuns(accountId, 10).find((run) => run.status === 'RUNNING' || run.status === 'QUEUED');
    if (active) throw new Error('이 계정에서 이미 Agent 작업이 진행 중입니다.');
    const source = sourceId ? candidateCache.get(accountId)?.find((candidate) => candidate.id === sourceId) : undefined;
    if (sourceId && !source) throw new Error('자료 목록을 다시 불러온 뒤 선택하세요.');
    if (!sourceId && !account.dailyEnabled) throw new Error('이 계정의 일상 콘텐츠가 활성화되지 않았습니다.');
    const previewAccount = source ? { ...account, dailyEnabled:false, promotionEnabled:true, automationTarget:false } : { ...account, promotionEnabled:false, dailyEnabled:true, automationTarget:false };
    const post = await deps.pipeline.preview(previewAccount, source);
    return { post, run:deps.repositories.listPipelineRuns(accountId, 1)[0] };
  });
  handle('content:publish-now', immediatePublishSchema, async ({accountId,sourceType}) => {
    if(deps.safeUiTestMode)throw new Error('안전 UI 테스트 모드에서는 실제 Threads 즉시 발행을 실행할 수 없습니다.');
    const account=deps.repositories.getAccount(accountId);
    if(!account)throw new Error('즉시 발행할 계정을 찾을 수 없습니다.');
    if(!account.active)throw new Error(`${account.name} 계정이 비활성 상태입니다. 계정 운영을 활성화하세요.`);
    const providerConfigs=deps.repositories.listProviderConfigs(accountId).filter((entry)=>entry.enabled);
    const provider=sourceType==='DAILY'?undefined:providerConfigs.find((entry)=>entry.type===sourceType);
    if(sourceType==='DAILY'&&!account.dailyEnabled)throw new Error('이 계정에서 일상 콘텐츠를 선택하지 않았습니다.');
    if(sourceType!=='DAILY'&&!provider)throw new Error(`이 계정에서 ${sourceType==='YOUTUBE'?'YouTube':sourceType==='BLOG'?'블로그':sourceType==='COUPANG'?'쿠팡':'네이버 브랜드 커넥트'} 콘텐츠를 선택하지 않았습니다.`);
    const active=deps.repositories.listPipelineRuns(accountId,10).find((run)=>run.status==='RUNNING'||run.status==='QUEUED');
    if(active)throw new Error('이 계정에서 이미 Agent 작업이 진행 중입니다. 현재 작업이 끝난 뒤 다시 시도하세요.');
    await assertThreadsPublishReady(accountId);
    const health=await deps.codex.health();
    if(!health.installed)throw new Error(health.message);
    if(sourceType==='YOUTUBE'){
      const channel=String(provider?.config.channel??'').trim();
      const key=`youtubeApiKey:${accountId}` as CredentialKey;
      const keyStatus=(await deps.credentials.status([key]))[key];
      const formatsEnabled=provider?.config.includeLongForm!==false||provider?.config.includeShorts!==false;
      const missing=[!channel&&'YouTube 채널',!formatsEnabled&&'롱폼 또는 쇼츠 선택',!keyStatus?.stored&&'YouTube Data API Key'].filter(Boolean);
      if(missing.length)throw new Error(`YouTube 즉시 발행에 필요한 항목이 없습니다: ${missing.join(', ')}`);
    }
    if(sourceType==='BLOG'&&!String(provider?.config.rssUrl??'').trim())throw new Error('블로그 즉시 발행에 필요한 블로그 주소가 없습니다.');
    if(sourceType==='COUPANG'){
      const mode=provider?.config.mode;
      if(mode==='MANUAL_LINKS'){
        const prepared=deps.repositories.coupangLinkSummary(accountId).byStatus.PREVIEW_READY;
        if(prepared<1)throw new Error('발행 준비가 완료된 쿠팡 상품이 없습니다. 계정 관리에서 상품 링크를 등록하고 자료 분석 후 등록을 완료하세요.');
      }else if(mode==='OPEN_API'){
        const accessKey=`coupangAccessKey:${accountId}` as CredentialKey;
        const secretKey=`coupangSecretKey:${accountId}` as CredentialKey;
        const status=await deps.credentials.status([accessKey,secretKey]);
        const verified=provider?.config.apiVerifiedAt
          ? provider.config.verifiedCredentialUpdatedAt as {accessKey:string;secretKey:string}|undefined
          : undefined;
        const current=verified&&verified.accessKey===status[accessKey]?.updatedAt&&verified.secretKey===status[secretKey]?.updatedAt;
        if(!status[accessKey]?.stored||!status[secretKey]?.stored||!current)throw new Error('쿠팡 Open API 키가 없거나 연결 확인이 완료되지 않았습니다.');
      }else throw new Error('쿠팡 운영 방식을 계정 관리에서 선택하세요.');
    }
    if(sourceType==='NAVER_BRAND_CONNECT'&&deps.repositories.naverBrandLinkSummary(accountId).byStatus.PREVIEW_READY<1)throw new Error('발행 준비가 완료된 네이버 브랜드 커넥트 상품이 없습니다. 네이버 브랜드 커넥트 메뉴에서 상품 링크를 분석해 주세요.');
    deps.repositories.addLog('INFO','PUBLISH',`${sourceType==='YOUTUBE'?'YouTube':sourceType==='BLOG'?'블로그':sourceType==='COUPANG'?'쿠팡':sourceType==='NAVER_BRAND_CONNECT'?'네이버 브랜드 커넥트':'일상'} 즉시 발행을 시작합니다.`,undefined,accountId);
    return deps.pipeline.publishNow(account,sourceType as SourceType);
  });
  handle('content:publish-prepared-daily', preparedDailyPublishSchema, async ({accountId,postId}) => {
    if(deps.safeUiTestMode)throw new Error('안전 UI 테스트 모드에서는 실제 Threads 발행을 실행할 수 없습니다.');
    const account=deps.repositories.getAccount(accountId);
    if(!account?.active)throw new Error('활성 계정을 선택하세요.');
    const active=deps.repositories.listPipelineRuns(accountId,10).find((run)=>run.status==='RUNNING'||run.status==='QUEUED');
    if(active)throw new Error('이 계정에서 이미 Agent 작업이 진행 중입니다. 현재 작업이 끝난 뒤 다시 시도하세요.');
    await assertThreadsPublishReady(accountId);
    deps.repositories.addLog('INFO','PUBLISH','확인된 미게시 일상 초안의 동일 본문 발행을 시작합니다.',undefined,accountId);
    return deps.pipeline.publishPreparedDaily(account,postId);
  });
  handle('reports:query', reportQuerySchema, async (input) => {
    const warnings:string[]=[];
    const connections=new Map<string,{fingerprint:string;keyLabel:string;accountIds:string[];accountNames:string[]}>();
    for(const accountId of input.accountIds){
      const account=deps.repositories.getAccount(accountId);
      const config=deps.repositories.listProviderConfigs(accountId).find((entry)=>entry.type==='COUPANG');
      if(!account||typeof config?.config.apiVerifiedAt!=='string'||!config.config.apiVerifiedAt)continue;
      const accessKey=`coupangAccessKey:${accountId}` as CredentialKey;
      const secretKey=`coupangSecretKey:${accountId}` as CredentialKey;
      const status=await deps.credentials.status([accessKey,secretKey]);
      if(!status[accessKey]?.stored||!status[secretKey]?.stored){
        warnings.push(`${account.name}: 쿠팡 API 키가 없어 최신 성과를 가져올 수 없습니다.`);continue;
      }
      const fingerprint=await deps.coupang.connectionFingerprint(accountId);
      const configuredLabel=String(config.config.keyLabel??'').trim();
      const keyLabel=configuredLabel||`구분명 미설정 · 키 ${fingerprint.slice(0,4).toUpperCase()}`;
      if(!configuredLabel)warnings.push(`${account.name}: 계정 설정에서 쿠팡 키 구분명을 입력하세요.`);
      const existing=connections.get(fingerprint);
      if(existing){
        existing.accountIds.push(accountId);existing.accountNames.push(account.name);
        if(configuredLabel&&existing.keyLabel!==configuredLabel)warnings.push(`동일한 쿠팡 키에 서로 다른 구분명이 저장되어 있습니다: ${existing.keyLabel}, ${configuredLabel}`);
      }else connections.set(fingerprint,{fingerprint,keyLabel,accountIds:[accountId],accountNames:[account.name]});
    }
    const duplicateLabels=new Map<string,string[]>();
    for(const connection of connections.values()){
      const key=connection.keyLabel.toLocaleLowerCase('ko-KR');
      duplicateLabels.set(key,[...(duplicateLabels.get(key)??[]),connection.fingerprint]);
    }
    for(const fingerprints of duplicateLabels.values())if(fingerprints.length>1){
      for(const fingerprint of fingerprints){const connection=connections.get(fingerprint)!;connection.keyLabel=`${connection.keyLabel} · 키 ${fingerprint.slice(0,4).toUpperCase()}`;}
      warnings.push('서로 다른 쿠팡 키에 같은 구분명이 사용되어 키 식별값을 함께 표시합니다.');
    }
    for(const connection of connections.values()){
      const accountId=connection.accountIds[0];
      try{
        let cursor=new Date(input.from);const last=new Date(input.to);
        while(cursor<=last){
          const chunkTo=new Date(cursor);chunkTo.setDate(chunkTo.getDate()+29);if(chunkTo>last)chunkTo.setTime(last.getTime());
          const rows=await deps.coupang.performance(accountId,cursor,chunkTo);
          deps.repositories.replaceAffiliatePerformanceByKeyRange(connection.fingerprint,connection.keyLabel,cursor.toISOString(),chunkTo.toISOString(),rows);
          cursor=new Date(chunkTo);cursor.setDate(cursor.getDate()+1);cursor.setHours(0,0,0,0);
        }
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        deps.repositories.addLog('WARN','REPORT','쿠팡 파트너스 성과를 갱신하지 못했습니다.',message,accountId);
        warnings.push(`${connection.keyLabel}: 쿠팡 최신 성과를 가져오지 못해 저장된 값을 표시합니다.`);
      }
    }
    return {posts:deps.repositories.report(input.accountIds,input.from,input.to),coupang:deps.repositories.affiliateReport([...connections.values()].map((connection)=>({fingerprint:connection.fingerprint,keyLabel:connection.keyLabel,accountNames:[...new Set(connection.accountNames)]})),input.from,input.to),warnings};
  });
  handle('external:open', z.string().url(), async (value) => {
    const url = new URL(value);
    if (!POLICY.externalProtocols.has(url.protocol as 'https:') || url.username || url.password) throw new Error('허용되지 않은 외부 URL입니다.');
    await shell.openExternal(url.toString());
  });
  deps.usage.onUpdate((status) => { if (!deps.window.isDestroyed()) deps.window.webContents.send('usage:updated', status); });
  deps.repositories.onPipelineRun((run) => { if (!deps.window.isDestroyed()) deps.window.webContents.send('pipeline:updated', run); });
  deps.scheduler.onActivity((activity) => { if (!deps.window.isDestroyed()) deps.window.webContents.send('job:updated', activity); });
  deps.repositories.onLog((log) => { if (!deps.window.isDestroyed()) deps.window.webContents.send('log:created', { ...log, detail:undefined, diagnosticSummary:redactForUi(log.detail) }); });
  deps.coupangCollector.onStatus((status)=>{if(!deps.window.isDestroyed())deps.window.webContents.send('coupang-collector:status-changed',status);});
}
