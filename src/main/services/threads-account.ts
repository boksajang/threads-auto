import type { Account, AccountInput, ThreadsProfile, ThreadsTokenDebugResult, ThreadsTokenStatus } from '../../shared/domain';
import type { Repositories } from '../db/repositories';
import { TokenInspectionUnavailableError, type ThreadsProvider } from '../providers/contracts';
import type { CredentialManager } from './settings';

const registeredAccountDefaults = (profile: ThreadsProfile): AccountInput & { threadsUserId:string } => ({
  name:profile.name || profile.username, threadsHandle:profile.username, threadsUserId:profile.id, topic:'', personality:'[표준]', tone:'[표준]', audience:'',
  forbiddenTopics:'', forbiddenExpressions:'', dailyEnabled:true, promotionEnabled:false, automationTarget:false, active:true,
  dailyRatio:3, promotionRatio:1, dailyPostTarget:1, operationStart:'09:00', operationEnd:'21:00', weekdays:[0,1,2,3,4,5,6],
  commentIntervalMinutes:10, fixedLinkEnabled:false, fixedLinkUrl:'',
});

export const REQUIRED_THREADS_SCOPES = [
  'threads_basic','threads_content_publish','threads_read_replies','threads_manage_replies',
  'threads_delete','threads_manage_insights',
] as const;
const DAY_MS = 86_400_000;

export interface StartupTokenMaintenanceResult {
  checked: number;
  inspected: number;
  estimated: number;
  refreshed: number;
  skipped: number;
  failures: Array<{ accountId:string; accountName:string; reason:string }>;
}

export interface OrphanedTokenRecoveryResult {
  checked: number;
  recovered: number;
  skipped: number;
  failures: Array<{ credentialKey:string; reason:string }>;
}

export class ThreadsAccountService {
  constructor(
    private readonly repositories: Repositories,
    private readonly credentials: CredentialManager,
    private readonly threads: ThreadsProvider,
    private readonly now: () => number = Date.now,
  ) {}

  private saveVerifiedProfile(account: Account, profile: ThreadsProfile): Account {
    if (account.threadsUserId && account.threadsUserId !== profile.id) throw new Error(`입력한 토큰은 현재 계정(@${account.threadsHandle})의 토큰이 아닙니다.`);
    const duplicate = this.repositories.getAccountByThreadsUserId(profile.id);
    if (duplicate && duplicate.id !== account.id) throw new Error(`이미 등록된 Threads 계정입니다: @${profile.username}`);
    return this.repositories.updateThreadsProfile(account.id, profile);
  }

  private assertInspection(profile: ThreadsProfile, inspection: ThreadsTokenDebugResult): void {
    if (!inspection.valid) throw new Error('유효하지 않은 Threads Access Token입니다. 새 장기 토큰을 발급해 연결하세요.');
    if (!inspection.userId || inspection.userId !== profile.id) throw new Error('Threads 프로필과 토큰 진단의 사용자 ID가 일치하지 않습니다.');
    if (!inspection.issuedAt || !inspection.expiresAt) throw new Error('Threads 토큰의 발급일 또는 만료일을 확인할 수 없습니다.');
  }

  private async inspectIfAvailable(accessToken:string):Promise<ThreadsTokenDebugResult|undefined> {
    try { return await this.threads.debugAccessToken(accessToken); }
    catch(error) {
      if(error instanceof TokenInspectionUnavailableError) return undefined;
      throw error;
    }
  }

  private saveInspection(accountId: string, inspection: ThreadsTokenDebugResult, lastRefreshedAt?: string): Account {
    if (!inspection.expiresAt) throw new Error('Threads 토큰 만료일을 저장할 수 없습니다.');
    return this.repositories.updateThreadsTokenMetadata(accountId, {
      issuedAt:inspection.issuedAt, expiresAt:inspection.expiresAt, dataAccessExpiresAt:inspection.dataAccessExpiresAt,
      checkedAt:inspection.checkedAt, scopes:inspection.scopes, valid:inspection.valid, lastRefreshedAt,
    });
  }

  private statusFrom(account: Account, stored: boolean, fresh: boolean, warning?: string, estimated=false): ThreadsTokenStatus {
    const scopes=account.threadsTokenScopes ?? [];
    const missingScopes=account.threadsTokenScopes ? REQUIRED_THREADS_SCOPES.filter((scope)=>!scopes.includes(scope)) : [];
    if (!stored) return {accountId:account.id,stored:false,fresh,estimated,scopes,missingScopes,canRefresh:false,state:'UNKNOWN',message:'저장된 Threads Access Token이 없습니다.',warning};
    if (account.threadsTokenValid === false) return {accountId:account.id,stored:true,valid:false,issuedAt:account.threadsTokenIssuedAt,expiresAt:account.threadsTokenExpiresAt,
      dataAccessExpiresAt:account.threadsTokenDataAccessExpiresAt,checkedAt:account.threadsTokenCheckedAt,lastRefreshedAt:account.threadsTokenLastRefreshedAt,
      fresh,estimated,scopes,missingScopes,canRefresh:false,state:'INVALID',message:'Threads Access Token이 유효하지 않습니다. 새 장기 토큰을 연결하세요.',warning};
    const expiryTimes=[account.threadsTokenExpiresAt,account.threadsTokenDataAccessExpiresAt].map((value)=>value?Date.parse(value):Number.NaN).filter(Number.isFinite);
    if (!account.threadsTokenExpiresAt || !account.threadsTokenIssuedAt || !expiryTimes.length) return {accountId:account.id,stored:true,valid:account.threadsTokenValid,
      issuedAt:account.threadsTokenIssuedAt,expiresAt:account.threadsTokenExpiresAt,dataAccessExpiresAt:account.threadsTokenDataAccessExpiresAt,
      checkedAt:account.threadsTokenCheckedAt,lastRefreshedAt:account.threadsTokenLastRefreshedAt,fresh,estimated,scopes,missingScopes,canRefresh:false,state:'UNKNOWN',
      message:'토큰의 발급일 또는 만료일을 아직 확인하지 못했습니다.',warning};
    const tokenExpiry=Date.parse(account.threadsTokenExpiresAt);
    const effectiveExpiry=Math.min(...expiryTimes);
    const remainingMs=effectiveExpiry-this.now();
    const daysRemaining=Math.max(0,Math.ceil(remainingMs/DAY_MS));
    const expired=remainingMs<=0;
    const tokenDaysRemaining=Math.max(0,Math.ceil((tokenExpiry-this.now())/DAY_MS));
    const refreshBasis=Math.max(Date.parse(account.threadsTokenIssuedAt),account.threadsTokenLastRefreshedAt?Date.parse(account.threadsTokenLastRefreshedAt):0);
    const refreshAvailableMs=refreshBasis+DAY_MS;
    const refreshAvailableAt=new Date(refreshAvailableMs).toISOString();
    const withinRefreshWindow=!expired&&tokenDaysRemaining<=30&&missingScopes.length===0;
    const canRefresh=withinRefreshWindow&&this.now()>=refreshAvailableMs;
    const state:ThreadsTokenStatus['state']=expired?'EXPIRED':daysRemaining<=30?'EXPIRING':'ACTIVE';
    const message=expired?'Threads 토큰 또는 데이터 접근 기간이 만료되어 새 토큰 발급이 필요합니다.'
      :missingScopes.length?`필수 권한 ${missingScopes.length}개가 없습니다. 권한이 포함된 토큰을 다시 연결하세요.`
        :withinRefreshWindow&&!canRefresh?`발급 또는 직전 연장 후 24시간이 지나야 합니다. 토큰 연장은 ${new Date(refreshAvailableMs).toLocaleString('ko-KR')}부터 가능합니다.`
          :withinRefreshWindow?`Threads 장기 토큰이 ${daysRemaining}일 후 만료됩니다.`:'Threads 토큰과 필수 권한이 정상입니다.';
    return {accountId:account.id,stored:true,valid:true,issuedAt:account.threadsTokenIssuedAt,
      expiresAt:account.threadsTokenExpiresAt,dataAccessExpiresAt:account.threadsTokenDataAccessExpiresAt,checkedAt:account.threadsTokenCheckedAt,
      lastRefreshedAt:account.threadsTokenLastRefreshedAt,refreshAvailableAt,daysRemaining,canRefresh,state,message,fresh,estimated,scopes,missingScopes,warning};
  }

  async register(accessToken: string): Promise<Account> {
    const profile = await this.threads.verifyAccessToken(accessToken);
    const inspection = await this.inspectIfAvailable(accessToken);
    if(inspection)this.assertInspection(profile,inspection);
    if (this.repositories.getAccountByThreadsUserId(profile.id)) throw new Error(`이미 등록된 Threads 계정입니다: @${profile.username}`);
    let saved: Account;
    try { saved = this.repositories.saveAccount(registeredAccountDefaults(profile)); }
    catch (error) {
      if (this.repositories.getAccountByThreadsUserId(profile.id)) throw new Error(`이미 등록된 Threads 계정입니다: @${profile.username}`, { cause:error });
      throw error;
    }
    try {
      await this.credentials.set(`threadsToken:${saved.id}`, accessToken);
      return inspection?this.saveInspection(saved.id,inspection):saved;
    } catch (error) {
      this.repositories.deleteAccount(saved.id);
      throw error;
    }
  }

  async updateToken(accountId: string, accessToken: string): Promise<Account> {
    const account = this.repositories.getAccount(accountId);
    if (!account) throw new Error('수정할 계정을 찾을 수 없습니다.');
    const profile = await this.threads.verifyAccessToken(accessToken);
    const inspection = await this.inspectIfAvailable(accessToken);
    if(inspection)this.assertInspection(profile,inspection);
    if (account.threadsUserId && account.threadsUserId !== profile.id) throw new Error(`입력한 토큰은 현재 계정(@${account.threadsHandle})의 토큰이 아닙니다.`);
    const duplicate = this.repositories.getAccountByThreadsUserId(profile.id);
    if (duplicate && duplicate.id !== account.id) throw new Error(`이미 등록된 Threads 계정입니다: @${profile.username}`);
    const key = `threadsToken:${account.id}` as const;
    const previousToken = await this.credentials.get(key);
    await this.credentials.set(key, accessToken);
    try {
      const updated = this.repositories.updateThreadsProfile(account.id, profile);
      this.repositories.clearThreadsTokenMetadata(account.id);
      return inspection?this.saveInspection(updated.id,inspection):updated;
    }
    catch (error) {
      if (previousToken) await this.credentials.set(key, previousToken);
      else await this.credentials.delete(key);
      throw error;
    }
  }

  async verifyStoredToken(accountId: string): Promise<Account> {
    const account = this.repositories.getAccount(accountId);
    if (!account) throw new Error('확인할 계정을 찾을 수 없습니다.');
    const token = await this.credentials.get(`threadsToken:${account.id}`);
    if (!token) throw new Error('저장된 Threads Access Token이 없습니다.');
    const profile=await this.threads.verifyAccessToken(token);
    const inspection=await this.inspectIfAvailable(token);
    if(inspection)this.assertInspection(profile,inspection);
    const updated=this.saveVerifiedProfile(account,profile);
    return inspection?this.saveInspection(updated.id,inspection):updated;
  }

  async tokenStatus(accountId: string): Promise<ThreadsTokenStatus> {
    const account = this.repositories.getAccount(accountId);
    if (!account) throw new Error('확인할 계정을 찾을 수 없습니다.');
    const key = `threadsToken:${account.id}` as const;
    const credentialStatus = (await this.credentials.status([key]))[key];
    const stored = Boolean(credentialStatus?.stored);
    if (!stored) return this.statusFrom(account,false,true);
    if(account.threadsTokenIssuedAt&&account.threadsTokenExpiresAt){
      const checkedMs=account.threadsTokenCheckedAt?Date.parse(account.threadsTokenCheckedAt):Number.NaN;
      const fresh=Number.isFinite(checkedMs)&&this.now()-checkedMs<=DAY_MS;
      const warning=!fresh&&account.threadsTokenCheckedAt?'저장된 마지막 토큰 확인 정보를 표시합니다. 다음 프로그램 시작 시 다시 확인합니다.':undefined;
      return this.statusFrom(account,true,fresh,warning);
    }
    if(credentialStatus?.updatedAt){
      const issuedMs=Date.parse(credentialStatus.updatedAt);
      if(Number.isFinite(issuedMs)){
        const estimatedAccount:Account={...account,threadsTokenIssuedAt:new Date(issuedMs).toISOString(),threadsTokenExpiresAt:new Date(issuedMs+60*DAY_MS).toISOString(),threadsTokenValid:true};
        const estimatedStatus=this.statusFrom(estimatedAccount,true,false,'계정관리 화면에서는 Meta API를 반복 호출하지 않습니다. 연결 확인 또는 연장 시 토큰 정보를 다시 확인합니다.',true);
        return {...estimatedStatus,message:'토큰 저장 시각부터 60일을 예상 만료일로 표시합니다.'};
      }
    }
    return this.statusFrom(account,true,false,'토큰 정보는 연결 확인 또는 연장 시 다시 확인합니다.');
  }

  async refreshStoredToken(accountId: string): Promise<ThreadsTokenStatus> {
    const account = this.repositories.getAccount(accountId);
    if (!account) throw new Error('갱신할 계정을 찾을 수 없습니다.');
    const key = `threadsToken:${account.id}` as const;
    const currentStatus = await this.tokenStatus(account.id);
    if (!currentStatus.stored) throw new Error('저장된 Threads Access Token이 없습니다.');
    if (currentStatus.state === 'EXPIRED') throw new Error('Threads 장기 토큰이 만료되어 연장할 수 없습니다. 새 장기 토큰을 발급해 연결하세요.');
    if (currentStatus.state === 'INVALID') throw new Error('유효하지 않은 Threads Access Token입니다. 새 장기 토큰을 발급해 연결하세요.');
    if (!currentStatus.canRefresh) throw new Error(currentStatus.message);

    const previousToken = await this.credentials.get(key);
    if (!previousToken) throw new Error('저장된 Threads Access Token이 없습니다.');
    const refreshed = await this.threads.refreshAccessToken(account.id);
    const profile = await this.threads.verifyAccessToken(refreshed.accessToken);
    if (account.threadsUserId && account.threadsUserId !== profile.id) {
      throw new Error(`갱신된 토큰은 현재 계정(@${account.threadsHandle})의 토큰이 아닙니다.`);
    }
    const duplicate = this.repositories.getAccountByThreadsUserId(profile.id);
    if (duplicate && duplicate.id !== account.id) throw new Error(`이미 등록된 Threads 계정입니다: @${profile.username}`);
    const refreshedInspection=await this.inspectIfAvailable(refreshed.accessToken);
    if(refreshedInspection)this.assertInspection(profile,refreshedInspection);

    if (refreshed.tokenChanged) await this.credentials.set(key, refreshed.accessToken);
    try {
      this.repositories.updateThreadsProfile(account.id,profile);
      if(refreshedInspection)this.saveInspection(account.id,refreshedInspection,refreshed.refreshedAt);
      else this.repositories.updateThreadsTokenMetadata(account.id,{issuedAt:refreshed.refreshedAt,expiresAt:refreshed.expiresAt,
        dataAccessExpiresAt:account.threadsTokenDataAccessExpiresAt,scopes:account.threadsTokenScopes,valid:true,lastRefreshedAt:refreshed.refreshedAt});
    } catch (error) {
      if (refreshed.tokenChanged) await this.credentials.set(key, previousToken);
      throw error;
    }
    return this.tokenStatus(account.id);
  }

  async maintainStoredTokensOnStartup(): Promise<StartupTokenMaintenanceResult> {
    const accounts=this.repositories.listAccounts();
    const keys=accounts.map((account)=>`threadsToken:${account.id}` as const);
    const stored=await this.credentials.status(keys);
    const result:StartupTokenMaintenanceResult={checked:0,inspected:0,estimated:0,refreshed:0,skipped:0,failures:[]};
    for(const account of accounts){
      if(!stored[`threadsToken:${account.id}`]?.stored)continue;
      result.checked+=1;
      try{
        const token=await this.credentials.get(`threadsToken:${account.id}`);
        if(!token)throw new Error('저장된 Threads Access Token이 없습니다.');
        const inspection=await this.inspectIfAvailable(token);
        if(inspection){
          if(!inspection.valid)throw new Error('유효하지 않은 Threads Access Token입니다. 새 장기 토큰을 발급해 연결하세요.');
          if(!inspection.userId||(account.threadsUserId&&inspection.userId!==account.threadsUserId))throw new Error('저장된 토큰의 Threads User ID가 현재 계정과 다릅니다.');
          if(!inspection.issuedAt||!inspection.expiresAt)throw new Error('Threads 토큰의 발급일 또는 만료일을 확인할 수 없습니다.');
          this.saveInspection(account.id,inspection,account.threadsTokenLastRefreshedAt);
          result.inspected+=1;
        }else result.estimated+=1;
        const status=await this.tokenStatus(account.id);
        if(status.state==='EXPIRED'||status.state==='INVALID'){
          result.failures.push({accountId:account.id,accountName:account.name,reason:status.message});
          continue;
        }
        if(!status.canRefresh){result.skipped+=1;continue;}
        await this.refreshStoredToken(account.id);
        result.refreshed+=1;
      }catch(error){
        result.failures.push({accountId:account.id,accountName:account.name,reason:error instanceof Error?error.message:'토큰 점검 중 알 수 없는 오류가 발생했습니다.'});
      }
    }
    return result;
  }

  async recoverOrphanedTokensOnStartup(): Promise<OrphanedTokenRecoveryResult> {
    const accounts=this.repositories.listAccounts();
    const orphaned=await this.credentials.orphanedThreadsTokenKeys(accounts.map((account)=>account.id));
    const result:OrphanedTokenRecoveryResult={checked:0,recovered:0,skipped:0,failures:[]};
    for(const sourceKey of orphaned){
      result.checked+=1;
      try{
        const token=await this.credentials.get(sourceKey);
        if(!token)throw new Error('암호화된 토큰 값을 찾을 수 없습니다.');
        const profile=await this.threads.verifyAccessToken(token);
        const target=this.repositories.getAccountByThreadsUserId(profile.id)
          ??accounts.find((account)=>account.threadsHandle.toLocaleLowerCase()===profile.username.toLocaleLowerCase());
        if(!target){result.skipped+=1;continue;}
        const targetKey=`threadsToken:${target.id}` as const;
        const moved=await this.credentials.moveIfTargetMissing(sourceKey,targetKey);
        if(!moved){result.skipped+=1;continue;}
        this.saveVerifiedProfile(target,profile);
        result.recovered+=1;
      }catch(error){
        result.failures.push({credentialKey:sourceKey,reason:error instanceof Error?error.message:'토큰 복구 중 알 수 없는 오류가 발생했습니다.'});
      }
    }
    return result;
  }
}
