import type { ThreadsTokenStatus } from '../shared/domain';

export type TokenExpiryTone='success'|'warning'|'danger'|'muted';

export interface TokenExpiryView {
  label:string;
  detail:string;
  tone:TokenExpiryTone;
}

const DAY_MS=86_400_000;

export function tokenExpiryView(expiresAt?:string,now=Date.now()):TokenExpiryView {
  if(!expiresAt)return {label:'만료일 확인 필요',detail:'연장하면 새 만료일을 확인할 수 있습니다.',tone:'muted'};
  const expires=new Date(expiresAt);
  if(Number.isNaN(expires.getTime()))return {label:'만료일 확인 필요',detail:'저장된 만료일을 확인할 수 없습니다.',tone:'muted'};
  const days=Math.ceil((expires.getTime()-now)/DAY_MS);
  if(days<0)return {label:'토큰 만료',detail:`${Math.abs(days)}일 전에 만료됨`,tone:'danger'};
  if(days===0)return {label:'오늘 만료',detail:'오늘 안에 토큰을 연장하세요.',tone:'danger'};
  if(days<=7)return {label:`${days}일 남음`,detail:'발행 중단을 막으려면 지금 연장하세요.',tone:'danger'};
  if(days<=30)return {label:`${days}일 남음`,detail:'만료 전에 토큰을 연장하는 것이 좋습니다.',tone:'warning'};
  return {label:`${days}일 남음`,detail:'현재 토큰을 정상적으로 사용할 수 있습니다.',tone:'success'};
}

export function shouldShowTokenRefresh(status:ThreadsTokenStatus):boolean {
  return Boolean(
    status.valid===true
      && status.state!=='EXPIRED'
      && status.state!=='INVALID'
      && status.canRefresh
      && status.expiresAt
      && typeof status.daysRemaining==='number'
      && status.daysRemaining>=0
      && status.daysRemaining<=30,
  );
}
