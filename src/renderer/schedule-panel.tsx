import { useMemo, useState } from 'react';
import type { AppSnapshot, JobRecord, SourceType } from '../shared/domain';

type PromotionSourceType=Exclude<SourceType,'DAILY'>;
type ScheduleView='time'|'account';

const sourceLabel=(type:SourceType)=>(type==='DAILY'?'일상':type==='YOUTUBE'?'YouTube':type==='BLOG'?'블로그':type==='COUPANG'?'쿠팡 파트너스':'네이버 브랜드 커넥트');
const jobLabel=(kind:JobRecord['kind'])=>({PUBLISH:'게시 생성·발행',COMMENTS:'댓글 확인·답변',INSIGHTS:'Threads 성과 수집',COUPANG_REPORT:'쿠팡 파트너스 성과 수집'} as const)[kind];
const fmtDate=(value:string)=>new Intl.DateTimeFormat('ko-KR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));

function promotionOptions(snapshot:AppSnapshot,accountId:string):PromotionSourceType[]{
  const runtime=snapshot.accountRuntime[accountId];
  if(!runtime)return [];
  return [
    runtime.providers.includes('BLOG')&&runtime.providerConfiguration?.blog?'BLOG':undefined,
    runtime.providers.includes('YOUTUBE')&&runtime.providerConfiguration?.youtube&&runtime.credentials.youtube?'YOUTUBE':undefined,
    runtime.providers.includes('COUPANG')&&(runtime.coupang?.prepared??0)>0?'COUPANG':undefined,
    runtime.providers.includes('NAVER_BRAND_CONNECT')&&runtime.naverBrand?.ready?'NAVER_BRAND_CONNECT':undefined,
  ].filter((value):value is PromotionSourceType=>Boolean(value));
}

function ScheduleJobRow({job,snapshot,busy,onCancel,onSave}:{job:JobRecord;snapshot:AppSnapshot;busy:boolean;onCancel:(id:string)=>Promise<void>;onSave:(job:JobRecord,type:PromotionSourceType)=>Promise<void>}){
  const account=snapshot.accounts.find(item=>item.id===job.accountId);
  const current=['BLOG','YOUTUBE','COUPANG','NAVER_BRAND_CONNECT'].includes(String(job.payload.sourceType))?job.payload.sourceType as PromotionSourceType:undefined;
  const available=promotionOptions(snapshot,job.accountId);
  const choices=[...new Set([...(current?[current]:[]),...available])];
  const [selected,setSelected]=useState<PromotionSourceType|''>(current??available[0]??'');
  const [saving,setSaving]=useState(false);const [error,setError]=useState('');
  const save=async()=>{if(!selected)return;setSaving(true);setError('');try{await onSave(job,selected);}catch(value){setError(String(value).replace(/^(?:Error:\s*)+/,'').replace(/^Error invoking remote method '[^']+': /,''));}finally{setSaving(false);}};
  const contentMode=job.payload.contentMode;
  return <div className="schedule-job-row">
    <time>{fmtDate(job.runAt)}</time>
    <span className="schedule-account-badge" title={account?.threadsHandle?`@${account.threadsHandle.replace(/^@/,'')}`:undefined}>{account?.name??'삭제된 계정'}</span>
    <strong>{jobLabel(job.kind)}</strong>
    <div className="schedule-content-cell">
      {job.kind!=='PUBLISH'?<span className="badge muted">운영</span>:contentMode==='DAILY'?<span className="badge success">일상</span>:<>
        <span className="badge warning">홍보</span>
        {choices.length?<select aria-label={`${account?.name??'계정'} 홍보 콘텐츠 유형`} value={selected} disabled={busy||saving} onChange={event=>setSelected(event.target.value as PromotionSourceType)}>{choices.map(type=><option key={type} value={type} disabled={!available.includes(type)}>{sourceLabel(type)}{!available.includes(type)?type==='COUPANG'&&snapshot.accountRuntime[job.accountId]?.providers.includes('COUPANG')?' · 발행 준비 상품 없음':' · 현재 설정 확인 필요':''}</option>)}</select>:<span className="badge danger">발행 유형 설정 필요</span>}
        {choices.length>0&&(choices.length>1||selected!==current)&&<button type="button" className="schedule-save-button" disabled={busy||saving||!selected||selected===current} onClick={()=>void save()}>{saving?'저장 중…':'저장'}</button>}
        {job.payload.sourceTypeLocked===true&&<small>사용자 지정</small>}
      </>}
      {error&&<small className="schedule-row-error" role="alert">{error}</small>}
    </div>
    <button type="button" className="schedule-cancel-button" disabled={busy||saving} onClick={()=>void onCancel(job.id)}>취소</button>
  </div>;
}

export function SchedulePanel({snapshot,busy,onCancel,onSave}:{snapshot:AppSnapshot;busy:boolean;onCancel:(id:string)=>Promise<void>;onSave:(job:JobRecord,type:PromotionSourceType)=>Promise<void>}){
  const [view,setView]=useState<ScheduleView>('time');const [accountFilter,setAccountFilter]=useState('all');
  // 댓글·성과 수집은 스케줄 시작 직후 실행되는 운영 작업이다. 예약 패널에는 실제 발행 계획만 표시한다.
  const jobs=useMemo(()=>snapshot.pendingJobs.filter(job=>job.kind==='PUBLISH'&&(accountFilter==='all'||job.accountId===accountFilter))
    .sort((left,right)=>left.runAt.localeCompare(right.runAt)||left.accountId.localeCompare(right.accountId)),[snapshot.pendingJobs,accountFilter]);
  const groups=useMemo(()=>snapshot.accounts.map(account=>({account,jobs:jobs.filter(job=>job.accountId===account.id)})).filter(group=>group.jobs.length),[snapshot.accounts,jobs]);
  const next=jobs[0]?.runAt;
  const rows=(items:JobRecord[])=>items.map(job=><ScheduleJobRow key={`${job.id}:${String(job.payload.sourceType??'')}:${job.payload.sourceTypeLocked===true}:${promotionOptions(snapshot,job.accountId).join('|')}`} job={job} snapshot={snapshot} busy={busy} onCancel={onCancel} onSave={onSave}/>);
  return <section className="panel pending-strip schedule-status-panel" aria-live="polite">
    <header className="section-heading schedule-panel-heading"><div><h2>전체 예정 작업</h2><p>자동화 계정 전체의 예약입니다. 다음 예정 {next?fmtDate(next):'-'}</p></div><div className="schedule-controls"><div className="schedule-view-toggle" role="group" aria-label="예정 작업 정렬"><button type="button" className={view==='time'?'active':''} aria-pressed={view==='time'} onClick={()=>setView('time')}>시간순</button><button type="button" className={view==='account'?'active':''} aria-pressed={view==='account'} onClick={()=>setView('account')}>계정별</button></div><select aria-label="예정 작업 계정 필터" value={accountFilter} onChange={event=>setAccountFilter(event.target.value)}><option value="all">전체 계정</option>{snapshot.accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select><span className={`badge ${snapshot.dashboard.automationRunning?(jobs.length?'success':'warning'):'muted'}`}>{snapshot.dashboard.automationRunning?(jobs.length?`${jobs.length}건 예약`:'실행 중 · 예약 없음'):'전체 자동화 중지'}</span></div></header>
    {jobs.length?<div className="schedule-list">{view==='time'?rows(jobs):groups.map(group=><section className="schedule-account-group" key={group.account.id}><header><strong>{group.account.name}</strong><span>{group.jobs.length}건</span></header>{rows(group.jobs)}</section>)}</div>:<div className="schedule-empty">{!snapshot.dashboard.automationRunning?'전체 자동화가 중지되어 예정 작업이 없습니다.':accountFilter==='all'?'자동화 대상 계정의 예약이 없습니다. 계정 설정과 발행 가능 시간을 확인하세요.':'선택한 계정의 예약 작업이 없습니다.'}</div>}
  </section>;
}
