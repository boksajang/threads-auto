import type { Account, ThreadsTokenStatus } from './domain';

export function threadsAuthLabel(status: ThreadsTokenStatus): string {
  const expired=[status.expiresAt,status.dataAccessExpiresAt].some(value=>value && Date.parse(value)<=Date.now());
  if (!status.stored || status.valid === false || status.state === 'INVALID' || status.state === 'EXPIRED' || expired) return 'Threads 재인증 필요';
  if (status.state === 'CHECK_FAILED') return 'Threads 확인 실패';
  if (status.missingScopes.length) return 'Threads 재인증 필요';
  if (status.valid === true && status.checkedAt && status.fresh) return 'Threads 인증 확인됨';
  return 'Threads 인증 확인 필요';
}

export const REQUIRED_THREADS_SCOPES = [
  'threads_basic','threads_content_publish','threads_read_replies','threads_manage_replies',
  'threads_delete','threads_manage_insights',
] as const;

export function threadsAccountAuthLabel(account: Account, stored: boolean): string {
  return threadsAuthLabel({accountId:account.id,stored:stored&&Boolean(account.threadsUserId),valid:account.threadsTokenValid,
    checkedAt:account.threadsTokenCheckedAt,expiresAt:account.threadsTokenExpiresAt,dataAccessExpiresAt:account.threadsTokenDataAccessExpiresAt,
    fresh:Boolean(account.threadsTokenCheckedAt&&Date.now()-Date.parse(account.threadsTokenCheckedAt)<=86_400_000),
    state:account.threadsTokenCheckFailedAt?'CHECK_FAILED':'UNKNOWN',canRefresh:false,message:'',scopes:account.threadsTokenScopes??[],
    missingScopes:account.threadsTokenScopes?REQUIRED_THREADS_SCOPES.filter(scope=>!account.threadsTokenScopes!.includes(scope)):[]});
}
