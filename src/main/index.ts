import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, powerMonitor } from 'electron';
import started from 'electron-squirrel-startup';
import type { CredentialKey } from '../shared/domain';
import { POLICY } from '../shared/policy';
import { CodexRateLimitClient } from './codex/rate-limits';
import { CodexRunner } from './codex/runner';
import { AppDatabase } from './db/database';
import { Repositories } from './db/repositories';
import { registerIpc } from './ipc/register';
import { BlogProvider } from './providers/blog';
import { CoupangPartnersProvider } from './providers/coupang';
import { ProviderRegistry } from './providers/contracts';
import { MetaThreadsProvider } from './providers/threads';
import { YouTubeProvider } from './providers/youtube';
import { AutomationPipeline } from './services/pipeline';
import { AutomationScheduler } from './services/scheduler';
import { CredentialManager, SettingsManager } from './services/settings';
import { PublishEligibility } from './services/publish-eligibility';
import { ThreadsIntegrationRuntime } from './services/threads-integration-runtime';
import { ThreadsOwnedContentService } from './services/threads-owned-content';
import { ThreadsAccountService } from './services/threads-account';
import { CoupangChromeCollectorService } from './services/coupang-chrome-collector';
import { collectorPipePath } from './services/collector-platform';
import { runYouTubePreview } from './services/youtube-preview-runner';
import { loadMainRenderer } from './services/main-window-loader';
import { enforceStoppedAutomationOnStartup } from './services/startup-automation';
import { projectDataDirectory, projectStorageRoot } from './services/storage-paths';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// 일부 Windows VM/원격 데스크톱 환경에서는 Chromium GPU 프로세스가 시작되지
// 못한다. 이 앱은 2D 관리 UI이므로 CPU 렌더링으로 안정적으로 동작시킨다.
app.disableHardwareAcceleration();

if (started) app.quit();

const safeUiTestMode = process.argv.includes('--safe-ui-test') || process.env.THREADS_AUTO_SAFE_UI_TEST === '1';
const safeUiSmallMode = safeUiTestMode && (process.argv.includes('--small-window') || process.env.THREADS_AUTO_SMALL_UI_TEST === '1');
const automationTestLock = process.env.THREADS_AUTO_DISABLE_AUTOMATION === '1';
const actualThreadsTestMode = process.env.THREADS_AUTO_ACTUAL_API_TEST === '1';
const developmentRun = !app.isPackaged && Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL);
const projectRoot = projectStorageRoot(app.getAppPath(), process.execPath, app.isPackaged, app.getPath('userData'));
const projectData = projectDataDirectory(projectRoot, safeUiTestMode, process.pid);
// ready 및 단일 인스턴스 잠금 전에 Chromium을 포함한 모든 앱 저장 경로를 지정한다.
for (const directory of [projectData, path.join(projectData, 'logs'), path.join(projectData, 'Crashpad'), path.join(projectData, 'tmp')]) {
  mkdirSync(directory, { recursive: true });
}
app.setPath('appData', projectData);
app.setPath('userData', projectData);
app.setPath('sessionData', projectData);
app.setPath('temp', path.join(projectData, 'tmp'));
app.setPath('crashDumps', path.join(projectData, 'Crashpad'));
app.setAppLogsPath(path.join(projectData, 'logs'));
const primaryInstance=safeUiTestMode||app.requestSingleInstanceLock();
if(!primaryInstance)app.quit();

let mainWindow: BrowserWindow | undefined;
let quitting = false;
app.on('second-instance',()=>{if(!mainWindow)return;mainWindow.show();if(mainWindow.isMinimized())mainWindow.restore();mainWindow.focus();});

async function createApplication(): Promise<void> {
  const userData = app.getPath('userData');
  const databaseDirectory = userData;
  mkdirSync(databaseDirectory, { recursive: true });
  const databasePath = path.join(databaseDirectory, POLICY.databaseFileName);
  console.log(`THREADS_AUTO_DATASTORE=${JSON.stringify({ userData, databaseDirectory, databasePath, developmentRun })}`);
  const database = new AppDatabase(databasePath);
  const repositories = new Repositories(database);
  console.log(`THREADS_AUTO_DATASTORE_READY=${JSON.stringify({ accountCount: repositories.listAccounts().length })}`);
  if (safeUiTestMode && repositories.listAccounts().length === 0) {
    const uiAccount=repositories.saveAccount({
      name:'UI 검증 계정', threadsHandle:'', topic:'', personality:'[표준]', tone:'[표준]', audience:'', forbiddenTopics:'', forbiddenExpressions:'',
      dailyEnabled:true, promotionEnabled:false, automationTarget:false, active:true, dailyRatio:3, promotionRatio:1, dailyPostTarget:1,
      operationStart:'09:00', operationEnd:'21:00', weekdays:[0,1,2,3,4,5,6], commentIntervalMinutes:10, fixedLinkEnabled:false, fixedLinkUrl:'',
    });
    repositories.saveProviderConfig({accountId:uiAccount.id,type:'COUPANG',enabled:true,config:{schemaVersion:1,mode:'MANUAL_LINKS',keywords:'개발자 책상, 생활용품',rocketOnly:true,rocketFreshOnly:false,goldBoxOnly:false}});
    const publishedAt=new Date().toISOString();
    repositories.savePost({id:'00000000-0000-4000-8000-000000000099',accountId:uiAccount.id,sourceType:'DAILY',body:'UI 검증용 게시물',threadsPostId:'ui-test-post',createdAt:publishedAt,publishedAt});
    repositories.upsertInsights('00000000-0000-4000-8000-000000000099',{views:120,likes:14,replies:3,reposts:2,quotes:1,shares:4});
    repositories.upsertCommentDiscovery({id:'ui-test-comment',accountId:uiAccount.id,postId:'ui-test-post',body:'이 게시물에 공감해요.',authorUsername:'ui_reader',commentedAt:publishedAt});
    const uiRun=repositories.createPipelineRun({accountId:uiAccount.id,mode:'PUBLISH'});
    repositories.updatePipelineRun(uiRun.id,{status:'COMPLETED',stage:'DONE',progress:100,postId:'00000000-0000-4000-8000-000000000099',draftBody:'UI 검증용 게시물',finishedAt:publishedAt,quality:[{stage:'REVIEWER',decision:'PASS',reason:'UI 검증용 품질판정 기록',vetoes:[]}]});
  }
  const settings = new SettingsManager(userData);
  if (!existsSync(path.join(userData, POLICY.configFileName))) await settings.save(await settings.read());
  if (!existsSync(path.join(userData, POLICY.credentialsFileName))) {
    writeFileSync(path.join(userData, POLICY.credentialsFileName), '{}', { flag: 'wx', mode: 0o600 });
  }
  const credentials = new CredentialManager(userData);
  await credentials.migrateLegacyThreadsToken(repositories.listAccounts().map((account) => account.id));
  await credentials.purgeDeprecatedThreadsAppCredentials();
  const eligibility = new PublishEligibility(repositories, credentials);
  const codex = new CodexRunner(path.join(userData, 'agent-work'), userData);
  try { await codex.initialize(); } catch { repositories.addLog('WARN', 'CODEX', 'Codex CLI를 찾지 못했습니다. 설치 후 다시 확인하세요.'); }
  let executable: string | undefined;
  try { executable = await codex.executablePath(); } catch { /* 상태 영역에서 설치 안내 */ }
  const usage = new CodexRateLimitClient(executable ?? 'codex');
  if (executable) void usage.start().catch(() => repositories.addLog('WARN', 'CODEX', '주간 사용가능량을 확인할 수 없습니다.'));
  const registry = new ProviderRegistry();
  registry.registerDiscovery(new YouTubeProvider(credentials));
  registry.registerDiscovery(new BlogProvider());
  const threads = new MetaThreadsProvider(credentials, fetch, Date.now, (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const threadsAccounts = new ThreadsAccountService(repositories,credentials,threads);
  const coupang = new CoupangPartnersProvider(credentials);
  const pipeline = new AutomationPipeline(repositories, settings, codex, usage, registry, threads, coupang, eligibility);
  const scheduler = new AutomationScheduler(repositories, pipeline, eligibility);
  const resumeScheduler=()=>scheduler.resumeAfterSystemWake();
  powerMonitor.on('resume',resumeScheduler);
  const startupAutomation=await enforceStoppedAutomationOnStartup(settings,scheduler);
  if(startupAutomation.settingsChanged||startupAutomation.cancelled>0)repositories.addLog('INFO','SCHEDULER',
    `프로그램 시작 정책에 따라 전체 자동화를 정지했습니다. 이전 예약 ${startupAutomation.cancelled}건 취소`);
  const threadsIntegration = new ThreadsIntegrationRuntime(repositories,pipeline,threads,(accountId) => {
    if (scheduler.isRunning()) throw new Error('실제 Threads 통합 테스트 전에 전체 자동화를 일시정지하세요.');
    if (repositories.runningJobs().some((job)=>job.accountId===accountId)
      || repositories.listPipelineRuns(accountId,20).some((run)=>run.status==='RUNNING'||run.status==='QUEUED')) {
      throw new Error('이 계정의 진행 중인 작업이 끝난 뒤 실제 Threads 통합 테스트를 실행하세요.');
    }
  });
  const ownedContent = new ThreadsOwnedContentService(repositories,threads);
  const coupangHostExecutable=app.isPackaged
    ?path.join(process.resourcesPath,process.platform==='win32'?'ThreadsAuto.NativeHost.exe':'host.cjs')
    :process.platform==='win32'?path.join(projectRoot,'native-host','bin','ThreadsAuto.NativeHost.exe'):path.join(projectRoot,'native-host','host.cjs');
  const coupangCollector=new CoupangChromeCollectorService({
    userData,hostExecutablePath:coupangHostExecutable,registerHost:!safeUiTestMode,
    pipePath:safeUiTestMode?collectorPipePath(`-ui-${process.pid}`):undefined,
  });
  await coupangCollector.start();

  if (actualThreadsTestMode) {
    const accounts=repositories.listAccounts();
    const credentialStatus=await credentials.status(accounts.map((account)=>`threadsToken:${account.id}` as CredentialKey));
    const available=accounts.filter((account)=>account.threadsUserId&&credentialStatus[`threadsToken:${account.id}`]?.stored);
    const requestedId=process.env.THREADS_AUTO_TEST_ACCOUNT_ID?.trim();
    const selected=requestedId?available.find((account)=>account.id===requestedId):available.length===1?available[0]:undefined;
    if (!selected) {
      console.log(`THREADS_ACTUAL_API_TEST=${JSON.stringify({status:'NEEDS_ACCOUNT_SELECTION',accounts:available.map(({id,name,threadsHandle})=>({id,name,username:threadsHandle}))})}`);
    } else {
      const recoverRunId=process.env.THREADS_AUTO_RECOVER_RUN_ID?.trim();
      const inspectRunId=process.env.THREADS_AUTO_INSPECT_RUN_ID?.trim();
      if (recoverRunId) {
        const result=await threadsIntegration.recover(recoverRunId);
        console.log(`THREADS_ACTUAL_API_RECOVERY=${JSON.stringify(result)}`);
      } else if (inspectRunId) {
        const run=repositories.getThreadsIntegrationRun(inspectRunId);
        if (!run||run.accountId!==selected.id||!run.parentId) throw new Error('현재 계정의 통합 테스트 이력을 찾을 수 없습니다.');
        const safeCall=async<T>(load:()=>Promise<T>,id?:string)=>{try{return await load();}catch(error){
          const causes:Array<{name:string;message:string;status?:number}>=[];
          let current:unknown=error;
          for(let depth=0;depth<5&&current instanceof Error;depth+=1){
            causes.push({name:current.name,message:current.message,status:'status' in current?Number((current as any).status)||undefined:undefined});
            current=current.cause;
          }
          return {id,error:error instanceof Error?error.message:String(error),causes};
        }};
        const safeRead=(id?:string)=>id?safeCall(()=>threads.getPost(selected.id,id),id):Promise.resolve(undefined);
        const result={run:{id:run.id,parentId:run.parentId,replyId:run.replyId,nestedReplyId:run.nestedReplyId},
          parent:await safeRead(run.parentId),reply:await safeRead(run.replyId),nested:await safeRead(run.nestedReplyId),
          replies:await safeCall(()=>threads.replies(selected.id,run.parentId!),run.parentId),
          conversation:await safeCall(()=>threads.conversation(selected.id,run.parentId!),run.parentId)};
        console.log(`THREADS_ACTUAL_API_INSPECT=${JSON.stringify(result)}`);
      } else {
        const result=await threadsIntegration.start(selected.id);
        console.log(`THREADS_ACTUAL_API_TEST=${JSON.stringify(result)}`);
      }
    }
    usage.stop();database.close();app.quit();return;
  }

  if (!safeUiTestMode && !automationTestLock) {
    const recovery=await threadsAccounts.recoverOrphanedTokensOnStartup();
    if(recovery.recovered>0)repositories.addLog('INFO','THREADS_TOKEN',
      `DB 계정 ID 변경으로 분리된 Threads 토큰 ${recovery.recovered}개를 사용자 ID 확인 후 다시 연결했습니다.`);
    for(const failure of recovery.failures)repositories.addLog('WARN','THREADS_TOKEN',
      '분리된 Threads 토큰을 현재 계정에 다시 연결하지 못했습니다.',failure.reason);
    const maintenance=await threadsAccounts.maintainStoredTokensOnStartup();
    if(maintenance.checked>0)repositories.addLog('INFO','THREADS_TOKEN',
      `앱 시작 토큰 점검 완료 · ${maintenance.checked}개 확인 · ${maintenance.inspected}개 디버그 확인 · ${maintenance.refreshed}개 연장 · ${maintenance.skipped}개 유지`);
    if(maintenance.estimated>0)repositories.addLog('WARN','THREADS_TOKEN',
      `Meta 토큰 디버거로 확인하지 못한 계정이 ${maintenance.estimated}개 있어 저장 시각 기반 예상 만료일을 유지합니다.`);
    for(const failure of maintenance.failures)repositories.addLog('WARN','THREADS_TOKEN',
      '앱 시작 시 Threads 토큰을 갱신하지 못했습니다.',failure.reason,failure.accountId);
  }

  const appIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'app-icon.png')
    : path.join(app.getAppPath(), 'assets', 'app-icon.png');
  mainWindow = new BrowserWindow({
    width: safeUiSmallMode ? 960 : 1280, height: safeUiSmallMode ? 640 : 800, minWidth: 960, minHeight: 640, show: false,
    backgroundColor: '#100D16', icon: appIconPath,
    title: safeUiTestMode ? '스레드 자동화 by @복사장의생존발악 — UI 검증' : '스레드 자동화 by @복사장의생존발악',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: { color: '#100D16', symbolColor: '#C9BED6', height: 40 },
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('did-fail-load',(_event,code,description,url,isMainFrame)=>{
    if(isMainFrame)console.error(`MAIN_RENDERER_LOAD_FAILED=${JSON.stringify({code,description,url})}`);
  });
  mainWindow.webContents.on('render-process-gone',(_event,details)=>{
    console.error(`MAIN_RENDERER_GONE=${JSON.stringify(details)}`);
  });

  registerIpc({ window: mainWindow, repositories, settings, credentials, scheduler, codex, usage, registry, threads, coupang, eligibility, pipeline,
    threadsIntegration, ownedContent, threadsAccounts, coupangCollector, safeUiTestMode:safeUiTestMode || automationTestLock });
  const rendererUrl=MAIN_WINDOW_VITE_DEV_SERVER_URL
    ||pathToFileURL(path.join(__dirname,`../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)).toString();
  await loadMainRenderer(mainWindow,rendererUrl,{attempts:MAIN_WINDOW_VITE_DEV_SERVER_URL?3:1});
  if (safeUiTestMode) mainWindow.setTitle('스레드 자동화 by @복사장의생존발악 — UI 검증');
  mainWindow.show();
  const uiScreenshotPath=process.env.THREADS_AUTO_UI_SCREENSHOT?.trim();
  if((safeUiTestMode||automationTestLock)&&uiScreenshotPath){
    await new Promise((resolve)=>setTimeout(resolve,500));
    const uiPage=process.env.THREADS_AUTO_UI_PAGE;
    if(['coupang','naver-brand','accounts','report'].includes(uiPage??'')){
      const pageTitle=uiPage==='naver-brand'?'네이버 브랜드 커넥트':uiPage==='accounts'?'계정 관리':uiPage==='report'?'성과 리포트':'쿠팡 상품';
      await mainWindow.webContents.executeJavaScript(`document.querySelector('button[title=${JSON.stringify(pageTitle)}]')?.click()`);
    }
    const uiAccount=process.env.THREADS_AUTO_UI_ACCOUNT?.trim();
    if(uiAccount){
      await new Promise((resolve)=>setTimeout(resolve,500));
      const accountSelectId=uiPage==='naver-brand'?'naver-brand-account':'coupang-account';
      await mainWindow.webContents.executeJavaScript(`(()=>{const select=document.querySelector(${JSON.stringify(`#${accountSelectId}`)});if(!(select instanceof HTMLSelectElement))return false;const option=[...select.options].find((item)=>item.textContent?.trim()===${JSON.stringify(uiAccount)});if(!option)return false;select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    }
    if(process.env.THREADS_AUTO_UI_ACTION==='coupang-search'){
      await new Promise((resolve)=>setTimeout(resolve,800));
      await mainWindow.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((item)=>item.textContent?.trim()==='상품 검색')?.click()`);
      await new Promise((resolve)=>setTimeout(resolve,500));
      await mainWindow.webContents.executeJavaScript(`document.querySelector('.coupang-search-modal .coupang-search-controls > button.primary')?.click()`);
      await new Promise((resolve)=>setTimeout(resolve,4500));
    }
    if(process.env.THREADS_AUTO_UI_ACTION==='coupang-detail'){
      await new Promise((resolve)=>setTimeout(resolve,800));
      await mainWindow.webContents.executeJavaScript(`document.querySelector('.coupang-queue-item summary')?.click()`);
      await new Promise((resolve)=>setTimeout(resolve,500));
      await mainWindow.webContents.executeJavaScript(`document.querySelector('.coupang-queue-item[open] .coupang-item-actions')?.scrollIntoView({block:'center'})`);
    }
    if(process.env.THREADS_AUTO_UI_ACTION==='account-coupang-key-label'){
      await new Promise((resolve)=>setTimeout(resolve,500));
      await mainWindow.webContents.executeJavaScript(`(()=>{const details=document.querySelector('.account-settings-card');if(details instanceof HTMLDetailsElement)details.open=true;const button=[...document.querySelectorAll('.coupang-mode-selector button')].find((item)=>item.textContent?.includes('최종 승인 완료'));if(button instanceof HTMLButtonElement)button.click();document.querySelector('.provider-coupang')?.scrollIntoView({block:'start'});})()`);
    }
    if(process.env.THREADS_AUTO_UI_ACTION==='report-performance'){
      await new Promise((resolve)=>setTimeout(resolve,500));
      await mainWindow.webContents.executeJavaScript(`[...document.querySelectorAll('[role="tab"]')].find((item)=>item.textContent?.trim()==='성과 분석')?.click()`);
    }
    if(['report-performance-query','report-post-detail'].includes(process.env.THREADS_AUTO_UI_ACTION??'')){
      await new Promise((resolve)=>setTimeout(resolve,500));
      await mainWindow.webContents.executeJavaScript(`[...document.querySelectorAll('[role="tab"]')].find((item)=>item.textContent?.trim()==='성과 분석')?.click()`);
      await new Promise((resolve)=>setTimeout(resolve,250));
      await mainWindow.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((item)=>item.textContent?.trim()==='조회')?.click()`);
      await new Promise((resolve)=>setTimeout(resolve,700));
      await mainWindow.webContents.executeJavaScript(`[...document.querySelectorAll('.result-header h2')].find((item)=>item.textContent?.trim()==='Threads 게시물 성과')?.scrollIntoView({block:'start'})`);
      if(process.env.THREADS_AUTO_UI_ACTION==='report-post-detail'){
        await mainWindow.webContents.executeJavaScript(`document.querySelector('.performance-summary-row button')?.click()`);
        await new Promise((resolve)=>setTimeout(resolve,250));
        const visible=await mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.performance-body-row:not([hidden]) article')?.textContent?.includes('UI 검증용 게시물'))`);
        if(!visible)throw new Error('성과표 본문 펼치기 UI 검증 실패');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('.performance-body-row:not([hidden])')?.scrollIntoView({block:'center'})`);
        console.log('THREADS_REPORT_POST_DETAIL=PASS');
      }
    }
    let naverSmokeResult:Record<string,unknown>|undefined;
    if(process.env.THREADS_AUTO_UI_ACTION==='naver-brand-smoke'){
      const smokeLink=process.env.THREADS_AUTO_NAVER_TEST_LINK?.trim();
      if(!smokeLink)throw new Error('THREADS_AUTO_NAVER_TEST_LINK가 필요합니다.');
      naverSmokeResult=await mainWindow.webContents.executeJavaScript(`(async()=>{
        const select=document.querySelector('#naver-brand-account');
        if(!(select instanceof HTMLSelectElement)||!select.value)return {ok:false,error:'테스트할 계정을 찾지 못했습니다.'};
        const accountId=select.value;
        const providers=await window.threadsAuto.providers.list(accountId);
        const originalProvider=providers.find((item)=>item.type==='NAVER_BRAND_CONNECT')??null;
        const before=await window.threadsAuto.naverBrandQueue.list(accountId);
        await window.threadsAuto.providers.save({accountId,type:'NAVER_BRAND_CONNECT',enabled:true,config:{schemaVersion:1}});
        try{
          const created=await window.threadsAuto.naverBrandQueue.add({accountId,text:${JSON.stringify(smokeLink)}});
          const after=await window.threadsAuto.naverBrandQueue.list(accountId);
          const beforeIds=new Set(before.map((item)=>item.id));
          const testItems=after.filter((item)=>!beforeIds.has(item.id));
          return {ok:true,accountId,originalProvider,createdIds:testItems.map((item)=>item.id),product:testItems[0]??created?.[0]??null};
        }catch(error){
          const after=await window.threadsAuto.naverBrandQueue.list(accountId);
          const existing=after.find((item)=>item.affiliateUrl===${JSON.stringify(smokeLink)})??null;
          return {ok:Boolean(existing),accountId,originalProvider,createdIds:[],product:existing,error:error instanceof Error?error.message:String(error)};
        }
      })()`);
      console.log(`THREADS_AUTO_NAVER_SMOKE=${JSON.stringify(naverSmokeResult)}`);
      await mainWindow.webContents.executeJavaScript(`document.querySelector('button[title="대시보드"]')?.click()`);
      await new Promise((resolve)=>setTimeout(resolve,250));
      await mainWindow.webContents.executeJavaScript(`document.querySelector('button[title="네이버 브랜드 커넥트"]')?.click()`);
      await new Promise((resolve)=>setTimeout(resolve,900));
      await mainWindow.webContents.executeJavaScript(`document.querySelector('.coupang-queue-item summary')?.click()`);
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
    await new Promise((resolve)=>setTimeout(resolve,800));
    const screenshot=await mainWindow.webContents.capturePage();
    writeFileSync(uiScreenshotPath,screenshot.toPNG());
    console.log(`THREADS_AUTO_UI_SCREENSHOT=${uiScreenshotPath}`);
    if(naverSmokeResult?.accountId){
      await mainWindow.webContents.executeJavaScript(`(async()=>{
        const result=${JSON.stringify(naverSmokeResult)};
        for(const id of result.createdIds??[])await window.threadsAuto.naverBrandQueue.delete({accountId:result.accountId,id}).catch(()=>undefined);
        if(result.originalProvider)await window.threadsAuto.providers.save(result.originalProvider);
        else await window.threadsAuto.providers.delete(result.accountId,'NAVER_BRAND_CONNECT').catch(()=>undefined);
      })()`);
    }
    setImmediate(()=>app.quit());
  }
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    scheduler.pause();
    powerMonitor.off('resume',resumeScheduler);
    codex.cancelAll();
    repositories.cancelAllActiveWork();
    void coupangCollector.stop();
    usage.stop();
    database.close();
  };
  mainWindow.on('close', () => {
    if (quitting) return;
    quitting = true;
    cleanup();
  });
  app.on('before-quit', () => { quitting = true; cleanup(); });
}

app.whenReady().then(async () => {
  if(!primaryInstance)return;
  if (process.env.THREADS_AUTO_YOUTUBE_PREVIEW === '1') {
    const outputDirectory = await runYouTubePreview(app.getPath('userData'), projectRoot);
    console.log(`YOUTUBE_PREVIEW_RESULT=${outputDirectory}`);
    app.quit();
    return;
  }
  await createApplication();
}).catch((error) => {
  console.error(error);
  if (app.isReady()) void dialog.showMessageBox({
    type:'error',
    title:'스레드 자동화 시작 실패',
    message:'저장된 데이터를 열지 못해 프로그램을 시작하지 않았습니다.',
    detail:error instanceof Error ? error.message : String(error),
    buttons:['확인'],
    noLink:true,
  }).finally(()=>app.quit());
  else app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => mainWindow?.show());
