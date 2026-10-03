import type { JobActivity, PipelineRunView, UserLog } from '../shared/domain';

export function chronologicalHistory(runs: PipelineRunView[], logs: UserLog[]) {
  const rows: Array<{kind:'run';key:string;at:string;run:PipelineRunView}|{kind:'log';key:string;at:string;log:UserLog}> = [
    ...runs.map(run=>({kind:'run' as const,key:`run-${run.id}`,at:run.finishedAt??run.updatedAt,run})),
    ...logs.map(log=>({kind:'log' as const,key:`log-${log.id}`,at:log.createdAt,log})),
  ];
  return rows.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.key.localeCompare(b.key));
}

export type LiveActivityTone = 'progress' | 'success' | 'warning' | 'error';
export type LiveActivitySource = 'pipeline' | 'job' | 'log';

export interface LiveActivityEvent {
  id: string;
  accountId?: string;
  source: LiveActivitySource;
  sourceId?: string;
  createdAt: string;
  status: string;
  label: string;
  message: string;
  tone: LiveActivityTone;
}

const jobLabel = (kind: JobActivity['kind']) => ({
  PUBLISH:'게시물 작성·발행', COMMENTS:'댓글 관리', INSIGHTS:'성과 수집', COUPANG_REPORT:'쿠팡 파트너스 성과 수집',
})[kind];

export function liveEventFromPipeline(run: PipelineRunView): LiveActivityEvent {
  const tone: LiveActivityTone = run.status === 'COMPLETED' ? 'success' : run.status === 'FAILED' ? 'error' : run.status === 'REJECTED' || run.status === 'STOPPED' ? 'warning' : 'progress';
  const status = tone === 'success' ? '성공' : tone === 'error' ? '실패' : tone === 'warning' ? '경고' : '진행';
  return { id:`pipeline:${run.id}:${run.status}:${run.updatedAt}`, accountId:run.accountId, source:'pipeline', sourceId:run.id, createdAt:run.updatedAt, status, label:'콘텐츠 Agent', message:run.errorSummary ?? run.message, tone };
}

export function liveEventFromJob(activity: JobActivity): LiveActivityEvent | undefined {
  if (activity.kind === 'PUBLISH') return undefined;
  const tone: LiveActivityTone = activity.status === 'DONE' ? 'success' : activity.status === 'FAILED' ? 'error' : activity.status === 'PENDING' || activity.status === 'CANCELLED' ? 'warning' : 'progress';
  const status = tone === 'success' ? '성공' : tone === 'error' ? '실패' : tone === 'warning' ? '경고' : '진행';
  return { id:`job:${activity.id}`, accountId:activity.accountId, source:'job', sourceId:activity.jobId, createdAt:activity.createdAt, status, label:jobLabel(activity.kind), message:activity.message, tone };
}

export function liveEventFromLog(log: UserLog): LiveActivityEvent | undefined {
  if (log.runId || log.category === 'JOB') return undefined;
  const tone: LiveActivityTone = log.level === 'ERROR' ? 'error' : log.level === 'WARN' ? 'warning' : /완료|성공|가져왔습니다|저장했습니다/.test(log.message) ? 'success' : 'progress';
  const status = tone === 'success' ? '성공' : tone === 'error' ? '실패' : tone === 'warning' ? '경고' : '진행';
  return { id:`log:${log.id}`, accountId:log.accountId, source:'log', createdAt:log.createdAt, status, label:logCategoryLabel(log.category), message:log.message, tone };
}

export function appendLiveActivity(current: LiveActivityEvent[], next: LiveActivityEvent | undefined, limit = 30): LiveActivityEvent[] {
  if (!next) return current;
  return [next, ...current.filter((item) => item.id !== next.id)].slice(0, limit);
}

function logCategoryLabel(category: string): string {
  return ({ SOURCE:'자료 수집', CONNECTION:'연결 확인', SCHEDULER:'자동화', COMMENTS:'댓글 관리', REPORT:'성과 수집', COUPANG:'쿠팡 파트너스 작업', PREVIEW:'초안 생성' } as Record<string,string>)[category] ?? '시스템';
}
