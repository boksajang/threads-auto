import type { Account, JobActivity, JobRecord, JobStatus, SourceType } from '../../shared/domain';
import { POLICY } from '../../shared/policy';
import { GLOBAL_AUTOMATION_STOP_REASON, SCHEDULE_REBUILD_REASON, type Repositories } from '../db/repositories';
import { ProviderRequestError, UncertainRemoteOperationError } from '../providers/contracts';
import type { PublishEligibility } from './publish-eligibility';

export interface JobHandler { execute(job: JobRecord, account: Account): Promise<void> }

export interface PlannedPublishSlot {
  accountId: string;
  slot: number;
  runAt: string;
  contentMode: 'DAILY' | 'PROMOTION';
  expiresAt: string;
}

export interface SuccessfulPublicationHistory { daily:number; promotion:number; today:number }
type PromotionSourceType=Exclude<SourceType,'DAILY'>;
const MAX_TIMER_DELAY_MS=2_147_000_000;
const HOUR_MS=60*60_000;

const minutesOfDay = (value: string): number => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
};

const localDayNumber = (date: Date): number => Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);

export function plannedContentMode(account: Account, day: Date, slot: number): 'DAILY' | 'PROMOTION' {
  if (!account.promotionEnabled) return 'DAILY';
  if (!account.dailyEnabled) return 'PROMOTION';
  const cycle = [
    ...Array.from({ length: Math.max(0, account.dailyRatio) }, () => 'DAILY' as const),
    ...Array.from({ length: Math.max(0, account.promotionRatio) }, () => 'PROMOTION' as const),
  ];
  if (!cycle.length) return 'DAILY';
  const index = localDayNumber(day) * Math.max(1, account.dailyPostTarget) + slot;
  return cycle[((index % cycle.length) + cycle.length) % cycle.length];
}

export function plannedModesFromSuccessfulHistory(account:Account,count:number,history:SuccessfulPublicationHistory):Array<'DAILY'|'PROMOTION'> {
  if(!account.promotionEnabled)return Array.from({length:count},()=> 'DAILY' as const);
  if(!account.dailyEnabled)return Array.from({length:count},()=> 'PROMOTION' as const);
  const dailyWeight=Math.max(0,account.dailyRatio);const promotionWeight=Math.max(0,account.promotionRatio);
  if(!promotionWeight)return Array.from({length:count},()=> 'DAILY' as const);
  if(!dailyWeight)return Array.from({length:count},()=> 'PROMOTION' as const);
  const share=promotionWeight/(dailyWeight+promotionWeight);
  // 과거 편차는 반올림 방향에만 반영한다. 오늘의 비율을 무너뜨리는 몰아 보정은 하지 않는다.
  const ideal=(Math.max(0,history.daily)+Math.max(0,history.promotion)+count)*share-Math.max(0,history.promotion);
  const promotionCount=Math.max(Math.floor(count*share),Math.min(Math.ceil(count*share),Math.round(ideal)));
  return [...Array.from({length:count-promotionCount},()=> 'DAILY' as const),...Array.from({length:promotionCount},()=> 'PROMOTION' as const)];
}

/** 비율로 정한 수량은 보존하고 날짜·계정별로 연속 묶음이 적은 순서를 고른다. */
function mixPlannedModes(modes:Array<'DAILY'|'PROMOTION'>,seedText:string):Array<'DAILY'|'PROMOTION'> {
  let seed=2166136261;
  for(const char of seedText)seed=Math.imul(seed^char.charCodeAt(0),16777619)>>>0;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  let best=[...modes],bestScore=Infinity;
  for(let attempt=0;attempt<32;attempt++){
    const candidate=[...modes];
    for(let i=candidate.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[candidate[i],candidate[j]]=[candidate[j],candidate[i]];}
    let score=0,run=0;
    candidate.forEach((mode,i)=>{run=i&&candidate[i-1]===mode?run+1:1;score+=run*run;});
    if(score<bestScore){best=candidate;bestScore=score;}
  }
  return best;
}

/**
 * 오늘의 게시 시각을 한 번에 확정한다. 동일한 운영시간/게시 수를 가진 계정은
 * 각 슬롯 안에서 계정 순서대로 균등 분산되며, 같은 입력은 언제나 같은 시각을 만든다.
 */
export function planDailyPublishSlots(accounts: Account[], day: Date, successfulHistory?:Record<string,SuccessfulPublicationHistory>,notBefore?:Date): PlannedPublishSlot[] {
  const eligible = accounts
    .filter((account) => account.active && account.automationTarget && account.weekdays.includes(day.getDay()))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  return eligible.flatMap((account, accountIndex) => {
    const start = minutesOfDay(account.operationStart);
    const end = minutesOfDay(account.operationEnd);
    if (end <= start || account.dailyPostTarget < 1) return [];
    const slotWidth = (end - start) / account.dailyPostTarget;
    const history=successfulHistory?.[account.id];
    const consumedSlots=Math.min(account.dailyPostTarget,Math.max(0,history?.today??0));
    const offset = (accountIndex + 0.5) / Math.max(1, eligible.length);
    const slotIndexes=Array.from({length:account.dailyPostTarget},(_,slot)=>slot).slice(consumedSlots).filter(slot=>{
      if(!notBefore)return true;
      const at=new Date(day.getFullYear(),day.getMonth(),day.getDate());
      at.setSeconds(Math.round((start+(slot+offset)*slotWidth)*60));
      return at.getTime()>=notBefore.getTime();
    });
    const historyModes=mixPlannedModes(history?plannedModesFromSuccessfulHistory(account,slotIndexes.length,history):slotIndexes.map(slot=>plannedContentMode(account,day,slot)),`${account.id}:${localDayNumber(day)}:${consumedSlots}`);
    return slotIndexes.map((slot,index) => {
      // 계정별로 슬롯 내부의 서로 다른 지점을 사용한다. 단일 계정은 정확히 중앙이다.
      const plannedMinute = start + (slot + offset) * slotWidth;
      const runAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
      runAt.setSeconds(Math.round(plannedMinute * 60));
      const expiresAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
      expiresAt.setMinutes(end);
      return { accountId: account.id, slot, runAt: runAt.toISOString(), expiresAt:expiresAt.toISOString(), contentMode: historyModes?.[index]??plannedContentMode(account, day, slot) };
    });
  }).sort((left, right) => left.runAt.localeCompare(right.runAt) || left.accountId.localeCompare(right.accountId));
}

export function isRetryableJobError(error: unknown): boolean {
  if (error instanceof ProviderRequestError) return error.retryable;
  if (error instanceof UncertainRemoteOperationError) return false;
  const message = error instanceof Error ? error.message : String(error);
  return !/인증|token|불확실|not logged in|unauthorized|\b401\b|codex login|sign[ -]?in/i.test(message);
}


export class AutomationScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private workerBusy = false;
  private recurringAccounts:Account[]=[];
  private scheduleQueue:Promise<void> = Promise.resolve();
  private readonly activityListeners = new Set<(activity: JobActivity) => void>();

  constructor(
    private readonly repositories: Repositories,
    private readonly handler: JobHandler,
    private readonly eligibility: Pick<PublishEligibility, 'hasThreadsToken'> = { hasThreadsToken: async () => false },
  ) {}
  isRunning(): boolean { return this.running; }
  onActivity(listener: (activity: JobActivity) => void): () => void { this.activityListeners.add(listener); return () => this.activityListeners.delete(listener); }

  private serializeSchedule<T>(work:()=>Promise<T>):Promise<T> {
    const result=this.scheduleQueue.then(work,work);
    this.scheduleQueue=result.then(()=>undefined,()=>undefined);
    return result;
  }

  private emitActivity(job: JobRecord, status: JobStatus, message: string): void {
    const createdAt = new Date().toISOString();
    const activity: JobActivity = { id:`${job.id}:${status}:${createdAt}`, jobId:job.id, accountId:job.accountId, kind:job.kind, status, message, attempt:job.attempt, createdAt };
    this.activityListeners.forEach((listener) => listener(activity));
  }

  private clearWakeTimer():void {
    if(this.timer)clearTimeout(this.timer);
    this.timer=undefined;
  }

  private nextRecurringWakeAt(now:Date):number|undefined {
    if(!this.recurringAccounts.length)return undefined;
    const nowMs=now.getTime();
    let next=Math.floor(nowMs/HOUR_MS+1)*HOUR_MS;
    for(const account of this.recurringAccounts){
      const commentIntervalMs=Math.max(1,account.commentIntervalMinutes)*60_000;
      next=Math.min(next,Math.floor(nowMs/commentIntervalMs+1)*commentIntervalMs);
      const coupang=this.repositories.listProviderConfigs(account.id)
        .find((config)=>config.type==='COUPANG'&&config.enabled);
      if(typeof coupang?.config.apiVerifiedAt==='string'&&coupang.config.apiVerifiedAt){
        const nextDay=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1,0,0,0,0).getTime();
        next=Math.min(next,nextDay);
      }
    }
    return next;
  }

  private armNextWake(now=new Date()):void {
    this.clearWakeTimer();
    if(!this.running)return;
    const pendingAt=this.repositories.pendingJobs(1)[0]?.runAt;
    const candidates=[pendingAt?new Date(pendingAt).getTime():undefined,this.nextRecurringWakeAt(now)]
      .filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
    if(!candidates.length)return;
    const delay=Math.min(MAX_TIMER_DELAY_MS,Math.max(0,Math.min(...candidates)-now.getTime()));
    this.timer=setTimeout(()=>{this.timer=undefined;void this.tick();},delay);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.repositories.addLog('INFO', 'SCHEDULER', '자동화를 시작했습니다.');
    void this.tick();
  }

  pause(): void {
    this.running = false;
    this.clearWakeTimer();
    this.recurringAccounts=[];
    this.repositories.addLog('INFO', 'SCHEDULER', '자동화를 일시정지했습니다.');
  }

  resumeAfterSystemWake():void {
    if(!this.running)return;
    this.clearWakeTimer();
    void this.tick();
  }

  async rebuildSchedules(now = new Date(), options:{reviveUserCancelledPublish?:boolean}={}):Promise<{cancelled:number;scheduled:number}> {
    const result=await this.serializeSchedule(async()=>{
      const cancelled=this.repositories.cancelPendingScheduledJobs(undefined,SCHEDULE_REBUILD_REASON);
      const scheduled=await this.scheduleAccounts(now,options);
      this.repositories.addLog('INFO','SCHEDULER',`발행 계획을 다시 생성했습니다. 기존 ${cancelled}건 취소 · 새 계획 ${scheduled}건`);
      return {cancelled,scheduled};
    });
    if(this.running)this.armNextWake();
    return result;
  }

  async startFresh(now = new Date()):Promise<{cancelled:number;scheduled:number}> {
    // 대시보드의 전체 시작은 사용자가 취소했던 남은 예약도 다시 만들겠다는
    // 명시적 요청이다. 일반 재계획과 주기 실행에서는 개별 취소를 계속 존중한다.
    const result=await this.rebuildSchedules(now,{reviveUserCancelledPublish:true});
    if(!this.running)this.start();
    return result;
  }

  async stopAndClearSchedules():Promise<number> {
    this.pause();
    return this.serializeSchedule(async()=>{
      const cancelled=this.repositories.cancelPendingScheduledJobs(undefined,GLOBAL_AUTOMATION_STOP_REASON);
      this.repositories.addLog('INFO','SCHEDULER',`전체 자동화를 중지하고 예정 작업 ${cancelled}건을 취소했습니다.`);
      return cancelled;
    });
  }

  async tick(now = new Date()): Promise<void> {
    if (!this.running || this.workerBusy) return;
    this.clearWakeTimer();
    this.workerBusy = true;
    try {
      await this.serializeSchedule(()=>this.scheduleAccounts(now));
      let job: JobRecord | undefined;
      let latestClaimedRunAt=0;
      while (this.running && (job = this.repositories.claimDueJob(now.toISOString()))) {
        latestClaimedRunAt=Math.max(latestClaimedRunAt,new Date(job.runAt).getTime());
        await this.executeClaimed(job);
      }
      if(this.running&&latestClaimedRunAt){
        const refreshAt=new Date(Math.max(Date.now(),latestClaimedRunAt+1));
        await this.serializeSchedule(()=>this.scheduleAccounts(refreshAt));
      }
    } finally {
      this.workerBusy = false;
      this.armNextWake();
    }
  }

  private async scheduleAccounts(now: Date, options:{reviveUserCancelledPublish?:boolean}={}): Promise<number> {
    const accounts = this.repositories.listAccounts();
    const eligibleAccounts:Account[]=[];
    for (const account of accounts) {
      if (!account.active || !account.automationTarget) continue;
      if (await this.eligibility.hasThreadsToken(account.id)) eligibleAccounts.push(account);
    }
    this.recurringAccounts=eligibleAccounts;
    const day = now.toLocaleDateString('sv-SE');
    const successfulHistory=Object.fromEntries(eligibleAccounts.map((account)=>[account.id,this.repositories.successfulPublicationScheduleHistory(account.id,day)]));
    let scheduled=0;
    const currentPlans=planDailyPublishSlots(eligibleAccounts,now,successfulHistory,now);
    const plans=[...currentPlans];
    // 오늘 남은 슬롯 유무와 관계없이 모든 계정의 다음 운영일을 함께 확보한다.
    // 같은 날짜의 계정을 한 번에 계획해야 accountIndex 오프셋이 적용되어 시간순으로 교차된다.
    const nextPlansByDay=new Map<string,{day:Date;accounts:Account[]}>();
    for(const account of eligibleAccounts){
      for(let offset=1;offset<=7;offset+=1){
        const nextDay=new Date(now.getFullYear(),now.getMonth(),now.getDate()+offset,0,0,0,0);
        if(!account.weekdays.includes(nextDay.getDay()))continue;
        const key=nextDay.toLocaleDateString('sv-SE');
        const group=nextPlansByDay.get(key)??{day:nextDay,accounts:[]};
        group.accounts.push(account);nextPlansByDay.set(key,group);break;
      }
    }
    for(const [scheduleDate,group] of nextPlansByDay){
      const nextHistory=Object.fromEntries(group.accounts.map((account)=>{
        const history=this.repositories.successfulPublicationScheduleHistory(account.id,scheduleDate);
        for(const planned of currentPlans.filter(item=>item.accountId===account.id)){
          if(planned.contentMode==='DAILY')history.daily+=1;else history.promotion+=1;
        }
        return [account.id,history];
      }));
      plans.push(...planDailyPublishSlots(group.accounts,group.day,nextHistory));
    }
    const sourceOptions=new Map<string,PromotionSourceType[]>();
    const manualCoupangCapacity=new Map<string,number>();
    const naverBrandCapacity=new Map<string,number>();
    for(const account of eligibleAccounts){
      const configs=this.repositories.listProviderConfigs(account.id).filter(config=>config.enabled);
      const options=configs.flatMap((config):PromotionSourceType[]=>{
        if(config.type==='BLOG'&&String(config.config.rssUrl??'').trim())return ['BLOG'];
        if(config.type==='YOUTUBE'&&String(config.config.channel??'').trim()
          &&(config.config.includeLongForm!==false||config.config.includeShorts!==false))return ['YOUTUBE'];
        if(config.type==='COUPANG'){
          const prepared=this.repositories.coupangLinkSummary(account.id).byStatus.PREVIEW_READY;
          manualCoupangCapacity.set(account.id,prepared);return prepared>0?['COUPANG']:[];
        }
        if(config.type==='NAVER_BRAND_CONNECT'){
          const prepared=this.repositories.naverBrandLinkSummary(account.id).byStatus.PREVIEW_READY;
          naverBrandCapacity.set(account.id,prepared);return prepared>0?['NAVER_BRAND_CONNECT']:[];
        }
        return [];
      });
      sourceOptions.set(account.id,options);
    }
    const promotionOrdinal=new Map<string,number>(),manualCoupangAssigned=new Map<string,number>(),naverBrandAssigned=new Map<string,number>();
    const lastPromotion=new Map(eligibleAccounts.map(account=>[account.id,this.repositories.lastPublishedPromotionType(account.id)]));
    for (const planned of plans.sort((left,right)=>left.runAt.localeCompare(right.runAt)||left.accountId.localeCompare(right.accountId))) {
      // 앱이 늦게 시작되거나 절전에서 복귀해도 지난 슬롯을 한꺼번에 발행하지 않는다.
      if (new Date(planned.runAt).getTime() < now.getTime()) continue;
      const scheduleDate=new Date(planned.runAt).toLocaleDateString('sv-SE');
      const jobId=`publish:${planned.accountId}:${scheduleDate}:${planned.slot}`;
      const existing=this.repositories.getJob(jobId);
      // 실행 중이거나 재시도 중인 Job의 유형·시각·시도 횟수는 재계획에서 변경하지 않는다.
      if(existing?.status==='RUNNING'||existing?.status==='PENDING'&&existing.attempt>0){
        const type=existing.payload.sourceType as PromotionSourceType|undefined;
        if(existing.payload.contentMode==='PROMOTION'&&type){
          lastPromotion.set(planned.accountId,type);
          if(type==='COUPANG')manualCoupangAssigned.set(planned.accountId,(manualCoupangAssigned.get(planned.accountId)??0)+1);
          if(type==='NAVER_BRAND_CONNECT')naverBrandAssigned.set(planned.accountId,(naverBrandAssigned.get(planned.accountId)??0)+1);
        }
        continue;
      }
      if(existing?.status==='DONE'||existing?.status==='FAILED')continue;
      if(existing?.status==='PENDING'&&['DAILY','PROMOTION'].includes(String(existing.payload.contentMode)))planned.contentMode=existing.payload.contentMode as 'DAILY'|'PROMOTION';
      let sourceType:PromotionSourceType|undefined;
      if(planned.contentMode==='PROMOTION'){
        const key=`${planned.accountId}:${scheduleDate}`,optionsForAccount=sourceOptions.get(planned.accountId)??[];
        const ordinal=promotionOrdinal.get(key)??0;promotionOrdinal.set(key,ordinal+1);
        const lockedType=existing?.payload.sourceTypeLocked===true&&['BLOG','YOUTUBE','COUPANG','NAVER_BRAND_CONNECT'].includes(String(existing.payload.sourceType))
          ? existing.payload.sourceType as PromotionSourceType:undefined;
        if(lockedType){
          sourceType=lockedType;
          if(lockedType==='COUPANG'&&manualCoupangCapacity.has(planned.accountId))manualCoupangAssigned.set(planned.accountId,(manualCoupangAssigned.get(planned.accountId)??0)+1);
          if(lockedType==='NAVER_BRAND_CONNECT'&&naverBrandCapacity.has(planned.accountId))naverBrandAssigned.set(planned.accountId,(naverBrandAssigned.get(planned.accountId)??0)+1);
        }else {
          const available=optionsForAccount.filter(type=>type==='COUPANG'? (manualCoupangAssigned.get(planned.accountId)??0)<(manualCoupangCapacity.get(planned.accountId)??0)
            :type==='NAVER_BRAND_CONNECT'?(naverBrandAssigned.get(planned.accountId)??0)<(naverBrandCapacity.get(planned.accountId)??0):true);
          const alternatives=available.filter(type=>type!==lastPromotion.get(planned.accountId));
          const candidates=alternatives.length?alternatives:available;
          const preferred=existing?.payload.sourceType as PromotionSourceType|undefined;
          const ordered=preferred&&candidates.includes(preferred)?[preferred,...candidates.filter(type=>type!==preferred)]
            :candidates.map((_,offset)=>candidates[(localDayNumber(new Date(planned.runAt))+ordinal+offset)%candidates.length]);
          for(const candidate of ordered){
          if(candidate==='COUPANG'&&manualCoupangCapacity.has(planned.accountId)){
            const used=manualCoupangAssigned.get(planned.accountId)??0;
            if(used>=(manualCoupangCapacity.get(planned.accountId)??0))continue;
            manualCoupangAssigned.set(planned.accountId,used+1);
          }
          if(candidate==='NAVER_BRAND_CONNECT'&&naverBrandCapacity.has(planned.accountId)){
            const used=naverBrandAssigned.get(planned.accountId)??0;
            if(used>=(naverBrandCapacity.get(planned.accountId)??0))continue;
            naverBrandAssigned.set(planned.accountId,used+1);
          }
          sourceType=candidate;break;
          }
        }
        if(sourceType)lastPromotion.set(planned.accountId,sourceType);
      }
      if(this.repositories.enqueueJob({
        id:jobId,
        accountId:planned.accountId,
        kind:'PUBLISH',
        runAt:planned.runAt,
        payload:{ slot:planned.slot, contentMode:planned.contentMode, sourceType, scheduleDate, expiresAt:planned.expiresAt, scheduleVersion:3 },
      },{reviveUserCancelledPublish:options.reviveUserCancelledPublish}))scheduled+=1;
    }
    for (const account of eligibleAccounts) {
      const commentSlot = Math.floor(now.getTime() / (account.commentIntervalMinutes * 60_000));
      if(this.repositories.enqueueJob({ id: `comments:${account.id}:${commentSlot}`, accountId: account.id, kind: 'COMMENTS', runAt: now.toISOString(), payload: {} }))scheduled+=1;
      const insightSlot = now.toISOString().slice(0, 13);
      if(this.repositories.enqueueJob({ id: `insights:${account.id}:${insightSlot}`, accountId: account.id, kind: 'INSIGHTS', runAt: now.toISOString(), payload: {} }))scheduled+=1;
      const coupang = this.repositories.listProviderConfigs(account.id)
        .find((config) => config.type === 'COUPANG' && config.enabled);
      if (typeof coupang?.config.apiVerifiedAt === 'string' && coupang.config.apiVerifiedAt) {
        if(this.repositories.enqueueJob({ id: `coupang-report:${account.id}:${day}`, accountId: account.id, kind: 'COUPANG_REPORT', runAt: now.toISOString(), payload: {} }))scheduled+=1;
      }
    }
    return scheduled;
  }

  private async executeClaimed(job: JobRecord): Promise<void> {
    const account = this.repositories.getAccount(job.accountId);
    if (!account?.active || !account.automationTarget) {
      this.repositories.completeJob(job.id, 'DONE');
      this.emitActivity(job, 'CANCELLED', '자동화 대상에서 제외되어 작업을 건너뛰었습니다.');
      this.repositories.addLog('INFO', 'JOB', '실행 직전 자동화 대상에서 제외되어 Job을 건너뛰었습니다.', undefined, job.accountId);
      return;
    }
    if (job.kind !== 'COUPANG_REPORT' && !await this.eligibility.hasThreadsToken(account.id)) {
      this.repositories.completeJob(job.id, 'CANCELLED', 'Threads 토큰 없음');
      this.emitActivity(job, 'CANCELLED', 'Threads 토큰이 없어 작업을 시작하지 않았습니다.');
      this.repositories.addLog('WARN', 'JOB', 'Threads 토큰이 없어 원격 작업을 시작하지 않았습니다.', undefined, job.accountId);
      return;
    }
    if(job.kind==='PUBLISH'&&typeof job.payload.expiresAt==='string'){
      const current=new Date();
      const scheduledDate=typeof job.payload.scheduleDate==='string'?job.payload.scheduleDate:undefined;
      if((scheduledDate&&current.toLocaleDateString('sv-SE')!==scheduledDate)||current.getTime()>new Date(job.payload.expiresAt).getTime()){
        this.repositories.completeJob(job.id,'CANCELLED','운영시간이 지난 게시 슬롯');
        this.emitActivity(job,'CANCELLED','운영시간이 지난 게시 슬롯이라 발행하지 않았습니다.');
        this.repositories.addLog('WARN','SCHEDULER','운영시간이 지난 게시 슬롯을 안전하게 취소했습니다.',undefined,job.accountId);
        return;
      }
    }
    this.emitActivity(job, 'RUNNING', '작업을 시작했습니다.');
    try {
      await this.handler.execute(job, account);
      this.repositories.completeJob(job.id, 'DONE');
      this.emitActivity(job, 'DONE', '작업을 완료했습니다.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isRetryableJobError(error);
      if (job.attempt < POLICY.jobMaxAttempts && retryable) {
        const delay = error instanceof ProviderRequestError && error.retryAfterMs ? error.retryAfterMs : POLICY.retryBaseMs * 2 ** (job.attempt - 1);
        this.repositories.requeueJob(job.id, new Date(Date.now() + delay).toISOString(), message);
        this.emitActivity(job, 'PENDING', '일시적인 오류로 잠시 후 다시 시도합니다.');
      } else {
        this.repositories.completeJob(job.id, 'FAILED', message);
        this.emitActivity(job, 'FAILED', '작업을 완료하지 못했습니다.');
      }
      this.repositories.addLog('ERROR', 'JOB', '자동화 Job 처리에 실패했습니다.', message, job.accountId);
    }
  }
}
