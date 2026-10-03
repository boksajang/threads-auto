import type { Account, ThreadsIntegrationEvent, ThreadsIntegrationRun } from '../../shared/domain';
import type { ThreadsProvider } from '../providers/contracts';
import { UncertainRemoteOperationError } from '../providers/contracts';
import { isThreadsRemoteObjectMissing } from '../providers/threads-error-classification';
import type { Repositories, ThreadsIntegrationEventRecord, ThreadsIntegrationRunRecord } from '../db/repositories';
import type { AutomationPipeline } from './pipeline';
import { ThreadsIntegrationService, type ThreadsIntegrationJournalEntry } from './threads-integration';

const eventView = (event: ThreadsIntegrationEventRecord): ThreadsIntegrationEvent => ({
  id:event.id, runId:event.runId, stage:event.stage, level:event.level === 'DEBUG' ? 'INFO' : event.level, message:event.message,
  remoteId:event.remoteObjectId, detail:event.detail, createdAt:event.createdAt,
});

const runView = (run: ThreadsIntegrationRunRecord, events?: ThreadsIntegrationEventRecord[]): ThreadsIntegrationRun => {
  const ids = (run.metadata.remoteIds ?? {}) as Record<string, unknown>;
  return {
    id:run.id, accountId:run.accountId,
    status:run.status === 'PASSED' ? 'PASS' : run.status === 'CLEANUP_NEEDED' ? 'CLEANUP_REQUIRED' : run.status === 'RUNNING' ? 'RUNNING' : 'FAILED',
    stage:run.stage, message:run.message || run.summary || 'Threads 통합 테스트 기록',
    draftBody:run.draftBody ?? (typeof run.metadata.draftBody === 'string' ? run.metadata.draftBody : undefined),
    parentId:run.parentId ?? (typeof ids.parentId === 'string' ? ids.parentId : undefined),
    replyId:run.replyId ?? (typeof ids.replyId === 'string' ? ids.replyId : undefined),
    nestedReplyId:run.nestedReplyId ?? (typeof ids.nestedId === 'string' ? ids.nestedId : undefined),
    cleanupNeeded:run.cleanupNeeded || Boolean(run.metadata.cleanupNeeded), errorSummary:run.errorSummary ?? run.lastError,
    startedAt:run.startedAt, updatedAt:run.updatedAt, finishedAt:run.finishedAt,
    events:events?.map(eventView),
  };
};

export class ThreadsIntegrationRuntime {
  private readonly drafts = new Map<string, string>();
  private readonly service: ThreadsIntegrationService;

  constructor(
    private readonly repositories: Repositories,
    pipeline: AutomationPipeline,
    provider: ThreadsProvider,
    private readonly assertIdle: (accountId: string) => void,
  ) {
    this.service = new ThreadsIntegrationService({
      provider,
      supplyDailyDraft:async ({ accountId, runId, maxBodyLength }) => {
        const account=this.account(accountId);
        const previewAccount:Account={...account,dailyEnabled:true,promotionEnabled:false,automationTarget:false};
        for(let attempt=1;attempt<=2;attempt+=1){
          const post=await pipeline.preview(previewAccount);
          if(post?.body.trim()){
            if (post.body.trim().length > maxBodyLength) throw new Error(`생성 본문이 테스트 표식을 포함한 Threads 글자 제한을 초과합니다. (${post.body.trim().length}/${maxBodyLength}자)`);
            this.drafts.set(runId,post.body.trim());
            return { body:post.body.trim(), mode:'DAILY', generatedBy:'AGENT', draftId:post.id };
          }
          if(attempt===1)this.repositories.addLog('WARN','THREADS_TEST','첫 초안이 독립 품질 검수에서 반려되어 Agent 생성을 1회만 다시 시도합니다.',undefined,accountId,undefined,undefined,runId);
        }
        throw new Error('Agent가 2회 모두 실제 통합 테스트에 사용할 일상 본문을 만들지 못했습니다. 품질 반려 이력을 확인하세요.');
      },
      journal:(entry) => this.record(entry),
      isNotFound:isThreadsRemoteObjectMissing,
      isUncertain:(error) => error instanceof UncertainRemoteOperationError,
    });
  }

  private account(accountId:string):Account & { threadsUserId:string } {
    const account=this.repositories.getAccount(accountId);
    if (!account?.active) throw new Error('활성 Threads 계정을 선택하세요.');
    if (!account.threadsUserId) throw new Error('연결 확인이 완료된 Threads 계정을 선택하세요.');
    return account as Account & { threadsUserId:string };
  }

  private record(entry:ThreadsIntegrationJournalEntry):void {
    const metadata={ remoteIds:entry.remoteIds, cleanupNeeded:entry.cleanupNeeded, draftBody:this.drafts.get(entry.runId) };
    const existing=this.repositories.getThreadsIntegrationRun(entry.runId);
    if (!existing) this.repositories.createThreadsIntegrationRun({ id:entry.runId, accountId:entry.accountId, mode:'ACTUAL_API',
      status:'RUNNING', stage:entry.phase, message:entry.message, summary:entry.message, metadata, startedAt:entry.createdAt });
    const terminal=entry.phase==='RUN' && entry.status!=='STARTED';
    const status=terminal ? entry.status : entry.status==='CLEANUP_NEEDED' ? 'CLEANUP_NEEDED' : 'RUNNING';
    this.repositories.updateThreadsIntegrationRun(entry.runId,{ status, stage:entry.phase, message:entry.message, summary:entry.message,
      lastError:entry.status==='FAILED'||entry.status==='UNCERTAIN'||entry.status==='CLEANUP_NEEDED'?entry.message:null,
      draftBody:this.drafts.get(entry.runId) ?? null, parentId:entry.remoteIds.parentId ?? null, replyId:entry.remoteIds.replyId ?? null,
      nestedReplyId:entry.remoteIds.nestedId ?? null, cleanupNeeded:entry.cleanupNeeded,
      errorSummary:entry.status==='FAILED'||entry.status==='CLEANUP_NEEDED'?entry.message:null, metadata, finishedAt:terminal?entry.createdAt:null });
    const level=entry.status==='FAILED'||entry.status==='CLEANUP_NEEDED'?'ERROR':entry.status==='WARNING'||entry.status==='UNCERTAIN'?'WARN':'INFO';
    const explicitId=entry.message.match(/\b\d{10,}\b/)?.[0];
    const remoteId=explicitId ?? entry.remoteIds.nestedId ?? entry.remoteIds.replyId ?? entry.remoteIds.parentId;
    this.repositories.addThreadsIntegrationEvent({ runId:entry.runId, stage:entry.phase, level, message:entry.message,
      detail:{ status:entry.status,cleanupNeeded:entry.cleanupNeeded }, remoteObjectId:remoteId, createdAt:entry.createdAt });
    this.repositories.addLog(level,'THREADS_TEST',entry.message,undefined,entry.accountId,undefined,undefined,entry.runId);
    if (terminal) this.drafts.delete(entry.runId);
  }

  async start(accountId:string):Promise<ThreadsIntegrationRun> {
    this.assertIdle(accountId);
    const account=this.account(accountId);
    const result=await this.service.run({accountId,threadsUserId:account.threadsUserId});
    return this.get(result.runId)!;
  }

  async recover(runId:string):Promise<ThreadsIntegrationRun> {
    const run=this.repositories.getThreadsIntegrationRun(runId);
    if (!run?.parentId||!run.draftBody) throw new Error('정리할 실제 통합 테스트 이력이나 본문이 없습니다.');
    this.assertIdle(run.accountId);
    const account=this.account(run.accountId);
    this.drafts.set(runId,run.draftBody);
    await this.service.recover({accountId:run.accountId,threadsUserId:account.threadsUserId,runId,draftBody:run.draftBody,
      parentId:run.parentId,replyId:run.replyId,nestedId:run.nestedReplyId});
    return this.get(runId)!;
  }

  list(accountId:string, limit=10):ThreadsIntegrationRun[] {
    return this.repositories.listThreadsIntegrationRuns(accountId,limit).map((run)=>runView(run));
  }

  get(runId:string):ThreadsIntegrationRun|undefined {
    const run=this.repositories.getThreadsIntegrationRun(runId);
    return run ? runView(run,this.repositories.listThreadsIntegrationEvents(runId)) : undefined;
  }
}
