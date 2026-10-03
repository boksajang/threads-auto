import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  COUPANG_COLLECTOR_ALLOWED_ORIGIN,
  COUPANG_COLLECTOR_EXTENSION_ID,
  COUPANG_COLLECTOR_NATIVE_HOST,
  COUPANG_COLLECTOR_PROTOCOL_VERSION,
  COUPANG_COLLECTOR_WEB_STORE_URL,
  type CoupangCollectorStatus,
} from '../../shared/coupang-collector';
import { isCoupangAffiliateUrl } from './coupang-link-input';
import { isNaverBrandAffiliateUrl } from './naver-brand-link-input';
import { chromeUserDataRoot, collectorPipePath, nativeHostLauncher } from './collector-platform';

const execFileAsync=promisify(execFile);

export async function hasChromeCollectorInstalled(localAppData=process.env.LOCALAPPDATA,platform:NodeJS.Platform=process.platform,home?:string):Promise<boolean> {
  const root=chromeUserDataRoot(platform,home,localAppData);
  if(!root)return false;
  const profiles=await fs.readdir(root,{withFileTypes:true}).catch(()=>[]);
  for(const profile of profiles.filter(entry=>entry.isDirectory()&&(entry.name==='Default'||/^Profile \d+$/.test(entry.name)))){
    // 압축해제 설치는 Extensions 폴더가 아니라 Chrome 설정에 등록된 경로에 있다.
    for(const file of ['Secure Preferences','Preferences']){
      try{
        const preferences=JSON.parse(await fs.readFile(path.join(root,profile.name,file),'utf8'));
        const entry=preferences.extensions?.settings?.[COUPANG_COLLECTOR_EXTENSION_ID];
        if(typeof entry?.path==='string'){
          const directory=path.isAbsolute(entry.path)?entry.path:path.join(root,profile.name,'Extensions',entry.path);
          const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
          if(manifest.manifest_version&&manifest.version)return true;
        }
      }catch { /* 등록 정보가 없거나 삭제된 경로면 스토어 설치 폴더도 확인한다. */ }
    }
    const directory=path.join(root,profile.name,'Extensions',COUPANG_COLLECTOR_EXTENSION_ID);
    const versions=await fs.readdir(directory,{withFileTypes:true}).catch(()=>[]);
    for(const version of versions.filter(entry=>entry.isDirectory())){
      try { const manifest=JSON.parse(await fs.readFile(path.join(directory,version.name,'manifest.json'),'utf8'));if(manifest.manifest_version&&manifest.version)return true; } catch { /* 설치가 완료된 버전만 인정한다. */ }
    }
  }
  return false;
}
const REGISTRY_KEY=`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${COUPANG_COLLECTOR_NATIVE_HOST}`;
const MAX_PIPE_MESSAGE_BYTES=600*1024;

type StoredState={promptAcknowledged?:boolean;lastConnectedAt?:string;extensionVersion?:string};
type CollectorReview={reviewTextRaw:string;optionTextRaw?:string;rating?:number};
export interface CoupangChromeCollectionResult {
  finalUrl:string;productId:string;itemId?:string;vendorItemId?:string;productTitleRaw?:string;imageUrls:string[];
  reviews:CollectorReview[];collectedAt:string;
}
export interface NaverBrandChromeCollectionResult {
  finalUrl:string;productKey:string;productTitleRaw?:string;imageUrls:string[];
  reviews:CollectorReview[];productFacts:string[];collectedAt:string;
}

export function createCoupangNativeHostManifest(hostExecutablePath:string):Record<string,unknown>{
  return {allowed_origins:[COUPANG_COLLECTOR_ALLOWED_ORIGIN],description:'Threads Auto Coupang collector',name:COUPANG_COLLECTOR_NATIVE_HOST,path:path.resolve(hostExecutablePath),type:'stdio'};
}
type PendingRequest={provider:'COUPANG'|'NAVER_BRAND_CONNECT';sourceUrl:string;resolve:(value:any)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>};

export class CoupangChromeCollectorError extends Error {
  constructor(public readonly code:string,message:string,options?:ErrorOptions){super(message,options);this.name='CoupangChromeCollectorError';}
}

function isRecord(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function safeText(value:unknown,max:number):string|undefined{const text=typeof value==='string'?value.trim():'';return text?text.slice(0,max):undefined;}
function validId(value:unknown):value is string{return typeof value==='string'&&/^\d{1,32}$/.test(value);}
function collectedLocation(value:unknown):{finalUrl:string;productId:string;itemId?:string;vendorItemId?:string}|undefined{
  if(typeof value!=='string'||value.length>2_000)return undefined;
  try{
    const url=new URL(value);const match=/^\/vp\/products\/(\d+)\/?$/.exec(url.pathname);
    if(url.protocol!=='https:'||url.hostname!=='www.coupang.com'||!match)return undefined;
    const itemId=url.searchParams.get('itemId')?.trim();const vendorItemId=url.searchParams.get('vendorItemId')?.trim();
    if(itemId&&!validId(itemId))return undefined;if(vendorItemId&&!validId(vendorItemId))return undefined;
    if(!itemId&&!vendorItemId)return undefined;url.hash='';
    return {finalUrl:url.toString(),productId:match[1],...(itemId?{itemId}:{}),...(vendorItemId?{vendorItemId}:{})};
  }catch{return undefined;}
}
function normalizeImages(value:unknown):string[]{
  if(!Array.isArray(value))return [];
  const result:string[]=[];
  for(const item of value){
    if(typeof item!=='string')continue;
    try{const url=new URL(item);const host=url.hostname.toLowerCase();if(url.protocol!=='https:'||!(host==='coupangcdn.com'||host.endsWith('.coupangcdn.com')))continue;url.hash='';const normalized=url.toString();if(!result.includes(normalized))result.push(normalized);}catch{/* 잘못된 URL은 제외 */}
    if(result.length>=20)break;
  }
  return result;
}
function normalizeNaverImages(value:unknown):string[]{
  if(!Array.isArray(value))return [];
  const result:string[]=[];
  for(const item of value){
    if(typeof item!=='string')continue;
    try{const url=new URL(item);const host=url.hostname.toLowerCase();if(url.protocol!=='https:'&&url.protocol!=='http:')continue;
      if(!(host==='pstatic.net'||host.endsWith('.pstatic.net')))continue;url.protocol='https:';url.hash='';const normalized=url.toString();if(!result.includes(normalized))result.push(normalized);
    }catch{/* 잘못된 URL 제외 */}
    if(result.length>=20)break;
  }
  return result;
}

export class CoupangChromeCollectorService {
  private server?:net.Server;
  private socket?:net.Socket;
  private buffer='';
  private helloReceived=false;
  private helloVersion?:string;
  private helloSupportsAffiliateUrl=false;
  private helloSupportsNaverBrand=false;
  private hostRegistered=false;
  private hostExecutableReady=false;
  private lastError?:string;
  private stored:StoredState={};
  private readonly pending=new Map<string,PendingRequest>();
  private readonly awaitingSockets=new Set<net.Socket>();
  private readonly statusListeners=new Set<(status:CoupangCollectorStatus)=>void>();
  private tail:Promise<void>=Promise.resolve();
  private readonly statePath:string;
  private readonly installDirectory:string;
  private readonly installedHostPath:string;
  private readonly manifestPath:string;

  constructor(private readonly options:{userData:string;hostExecutablePath:string;registerHost?:boolean;timeoutMs?:number;pipePath?:string}){
    this.statePath=path.join(options.userData,'coupang-collector-state.json');
    this.installDirectory=path.join(options.userData,'NativeMessaging');
    this.installedHostPath=path.join(this.installDirectory,process.platform==='win32'?'ThreadsAuto.NativeHost.exe':'threads-auto-host');
    this.manifestPath=path.join(process.platform==='win32'?this.installDirectory:path.join(chromeUserDataRoot()!,'NativeMessagingHosts'),`${COUPANG_COLLECTOR_NATIVE_HOST}.json`);
  }

  async start():Promise<void>{
    await this.loadState();
    this.hostExecutableReady=await fs.access(this.options.hostExecutablePath).then(()=>true,()=>false);
    await this.listen();
    if(this.options.registerHost!==false&&this.hostExecutableReady){
      try{await this.registerNativeHost();this.hostRegistered=true;this.lastError=undefined;}
      catch(error){this.hostRegistered=false;this.lastError=`Native Messaging Host 등록 실패: ${error instanceof Error?error.message:String(error)}`;}
    }
    this.emitStatus();
  }

  async stop():Promise<void>{
    this.rejectAll(new CoupangChromeCollectorError('COLLECTOR_STOPPED','프로그램이 종료되어 쿠팡 상품 수집을 중단했습니다.'));
    this.socket?.destroy();this.socket=undefined;
    for(const socket of this.awaitingSockets)socket.destroy();this.awaitingSockets.clear();
    if(this.server)await new Promise<void>((resolve)=>this.server!.close(()=>resolve()));
    this.server=undefined;
  }

  status():CoupangCollectorStatus{
    const connected=Boolean(this.socket&&!this.socket.destroyed&&this.helloReceived);
    const message=connected?'Chrome 쿠팡 수집기 연결 완료'
      :!this.hostExecutableReady?'쿠팡 수집기 실행 파일이 준비되지 않았습니다.'
        :!this.hostRegistered?'Chrome 연결 구성에 실패했습니다.'
          :this.stored.lastConnectedAt?'Chrome 수집기 연결 대기 중 · Chrome에서 확장 프로그램을 확인하세요.'
            :'확장 프로그램 설치 및 최초 연결이 필요합니다.';
    return {extensionId:COUPANG_COLLECTOR_EXTENSION_ID,webStoreUrl:COUPANG_COLLECTOR_WEB_STORE_URL,
      hostRegistered:this.hostRegistered,hostExecutableReady:this.hostExecutableReady,connected,
      everConnected:Boolean(this.stored.lastConnectedAt),promptAcknowledged:Boolean(this.stored.promptAcknowledged),
      extensionVersion:this.stored.extensionVersion,lastConnectedAt:this.stored.lastConnectedAt,lastError:this.lastError,message};
  }

  async acknowledgePrompt():Promise<CoupangCollectorStatus>{this.stored.promptAcknowledged=true;await this.saveState();this.emitStatus();return this.status();}
  onStatus(listener:(status:CoupangCollectorStatus)=>void):()=>void{this.statusListeners.add(listener);return()=>this.statusListeners.delete(listener);}

  research(input:{sourceUrl:string;maxImages?:number;maxReviews?:number}):Promise<CoupangChromeCollectionResult>{
    const run=this.tail.then(()=>this.collectOnce(input,'COUPANG'),()=>this.collectOnce(input,'COUPANG'));
    this.tail=run.then(()=>undefined,()=>undefined);return run;
  }

  researchNaverBrand(input:{sourceUrl:string;maxImages?:number;maxReviews?:number}):Promise<NaverBrandChromeCollectionResult>{
    const run=this.tail.then(()=>this.collectOnce(input,'NAVER_BRAND_CONNECT'),()=>this.collectOnce(input,'NAVER_BRAND_CONNECT'));
    this.tail=run.then(()=>undefined,()=>undefined);return run;
  }

  private async collectOnce(input:{sourceUrl:string;maxImages?:number;maxReviews?:number},provider:'COUPANG'):Promise<CoupangChromeCollectionResult>;
  private async collectOnce(input:{sourceUrl:string;maxImages?:number;maxReviews?:number},provider:'NAVER_BRAND_CONNECT'):Promise<NaverBrandChromeCollectionResult>;
  private async collectOnce(input:{sourceUrl:string;maxImages?:number;maxReviews?:number},provider:'COUPANG'|'NAVER_BRAND_CONNECT'):Promise<CoupangChromeCollectionResult|NaverBrandChromeCollectionResult>{
    const sourceUrl=typeof input.sourceUrl==='string'?input.sourceUrl.trim():'';
    const valid=provider==='COUPANG'?isCoupangAffiliateUrl(sourceUrl):isNaverBrandAffiliateUrl(sourceUrl);
    if(!sourceUrl||sourceUrl.length>2_000||!valid)throw new CoupangChromeCollectorError('INVALID_PRODUCT_LINK',provider==='COUPANG'?'쿠팡 파트너스 상품 링크가 올바르지 않습니다.':'네이버 브랜드 커넥트에서 발급한 naver.me 상품 링크가 올바르지 않습니다.');
    if(provider==='NAVER_BRAND_CONNECT'&&!this.helloSupportsNaverBrand)throw new CoupangChromeCollectorError('COLLECTOR_UPDATE_REQUIRED','네이버 브랜드 커넥트 수집을 지원하는 최신 Chrome 확장 프로그램으로 새로고침하세요.');
    if(!this.socket||this.socket.destroyed||!this.helloReceived)throw new CoupangChromeCollectorError('COLLECTOR_NOT_CONNECTED','Chrome 상품 수집기가 연결되지 않았습니다. 계정 관리에서 확장 프로그램 상태를 확인하세요.');
    const requestId=randomUUID();
    const request={type:'COLLECT_PRODUCT',protocolVersion:COUPANG_COLLECTOR_PROTOCOL_VERSION,requestId,provider,
      sourceUrl,maxImages:Math.max(1,Math.min(20,Math.trunc(input.maxImages??20))),
      maxReviews:Math.max(0,Math.min(8,Math.trunc(input.maxReviews??8)))};
    return new Promise<CoupangChromeCollectionResult>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new CoupangChromeCollectorError('COLLECTION_TIMEOUT','Chrome에서 쿠팡 상품 정보를 가져오는 시간이 초과되었습니다. 열린 상품 페이지를 확인하세요.'));},this.options.timeoutMs??60_000);
      this.pending.set(requestId,{provider,sourceUrl,resolve,reject,timer});
      this.socket!.write(`${JSON.stringify(request)}\n`,error=>{if(!error)return;clearTimeout(timer);this.pending.delete(requestId);reject(new CoupangChromeCollectorError('NATIVE_HOST_WRITE_FAILED','Chrome 쿠팡 수집기에 요청을 보내지 못했습니다.',{cause:error}));});
    });
  }

  private async listen():Promise<void>{
    const pipePath=this.options.pipePath??collectorPipePath();
    if(process.platform!=='win32'){
      await fs.mkdir(path.dirname(pipePath),{recursive:true,mode:0o700});
      const existing=await fs.lstat(pipePath).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(existing){
        if(!existing.isSocket())throw new Error('수집기 소켓 경로가 다른 파일에 사용 중입니다.');
        const active=await new Promise<boolean>((resolve,reject)=>{
          const probe=net.createConnection(pipePath);
          probe.once('connect',()=>{probe.destroy();resolve(true);});
          probe.once('error',error=>{if(['ECONNREFUSED','ENOENT'].includes((error as NodeJS.ErrnoException).code??''))resolve(false);else reject(error);});
        });
        if(active)throw new Error('Chrome 수집기가 다른 앱 인스턴스에서 실행 중입니다.');
        await fs.unlink(pipePath).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }
    }
    await new Promise<void>((resolve,reject)=>{
      const server=net.createServer(socket=>{
        // A stale-socket probe must not replace the active Chrome connection.
        this.awaitingSockets.add(socket);socket.setEncoding('utf8');
        socket.setTimeout(15_000,()=>socket.destroy());
        socket.once('close',()=>this.awaitingSockets.delete(socket));
        socket.once('error',()=>socket.destroy());
        socket.once('data',chunk=>{this.awaitingSockets.delete(socket);socket.setTimeout(0);this.accept(socket);this.consume(String(chunk));});
      });
      server.once('error',reject);server.listen(pipePath,()=>{server.off('error',reject);this.server=server;resolve();});
    });
    if(process.platform!=='win32')await fs.chmod(pipePath,0o600);
  }

  private accept(socket:net.Socket):void{
    if(this.socket&&this.socket!==socket&&!this.socket.destroyed){
      this.rejectAll(new CoupangChromeCollectorError('COLLECTOR_RECONNECTED','Chrome 쿠팡 수집기 연결이 다시 설정되어 진행 중인 상품 수집을 중단했습니다. 다시 시도하세요.'));
      this.socket.destroy();
    }
    this.socket=socket;this.buffer='';this.helloReceived=false;this.helloVersion=undefined;this.helloSupportsAffiliateUrl=false;this.helloSupportsNaverBrand=false;
    socket.setEncoding('utf8');socket.on('data',chunk=>this.consume(String(chunk)));
    socket.on('error',error=>{this.lastError=`Chrome 수집기 통신 오류: ${error.message}`;this.emitStatus();});
    socket.on('close',()=>{if(this.socket===socket){this.socket=undefined;this.helloReceived=false;this.helloVersion=undefined;this.helloSupportsAffiliateUrl=false;this.helloSupportsNaverBrand=false;this.rejectAll(new CoupangChromeCollectorError('COLLECTOR_DISCONNECTED','Chrome 상품 수집기 연결이 끊어졌습니다.'));this.emitStatus();}});
  }

  private consume(chunk:string):void{
    this.buffer+=chunk;
    if(Buffer.byteLength(this.buffer,'utf8')>MAX_PIPE_MESSAGE_BYTES){this.lastError='Chrome 수집기 메시지가 허용 크기를 초과했습니다.';this.socket?.destroy();return;}
    for(;;){const newline=this.buffer.indexOf('\n');if(newline<0)break;const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);if(!line.trim())continue;try{this.handleMessage(JSON.parse(line));}catch(error){this.lastError=`Chrome 수집기 응답 처리 실패: ${error instanceof Error?error.message:String(error)}`;}}
  }

  private handleMessage(value:unknown):void{
    if(!isRecord(value)||value.protocolVersion!==COUPANG_COLLECTOR_PROTOCOL_VERSION)return;
    if(value.type==='HELLO'){
      const version=safeText(value.extensionVersion,40);
      const capabilities=isRecord(value.capabilities)?value.capabilities:{};
      if(!version||capabilities.collectByAffiliateUrl!==true){
        this.lastError='설치된 Chrome 확장 프로그램이 현재 상품 링크 수집 방식과 호환되지 않습니다. 확장 프로그램을 새로고침하세요.';
        this.emitStatus();
        return;
      }
      this.helloVersion=version;this.helloSupportsAffiliateUrl=true;
      this.helloSupportsNaverBrand=capabilities.collectNaverBrandConnect===true;
      this.socket?.write(`${JSON.stringify({type:'HELLO_ACK',protocolVersion:COUPANG_COLLECTOR_PROTOCOL_VERSION,extensionId:COUPANG_COLLECTOR_EXTENSION_ID,receivedAt:new Date().toISOString()})}\n`);return;
    }
    if(value.type==='READY'&&this.helloVersion&&this.helloSupportsAffiliateUrl){
      this.helloReceived=true;this.stored.extensionVersion=this.helloVersion;this.stored.lastConnectedAt=new Date().toISOString();this.lastError=undefined;
      void this.saveState();this.emitStatus();return;
    }
    if(value.type!=='COLLECT_PRODUCT_RESULT'||typeof value.requestId!=='string')return;
    const pending=this.pending.get(value.requestId);if(!pending)return;
    clearTimeout(pending.timer);this.pending.delete(value.requestId);
    if(value.ok!==true){const error=isRecord(value.error)?value.error:{};pending.reject(new CoupangChromeCollectorError(safeText(error.code,80)??'COLLECTION_FAILED',safeText(error.message,1000)??'Chrome에서 쿠팡 상품 정보를 가져오지 못했습니다.'));return;}
    try{pending.resolve(pending.provider==='NAVER_BRAND_CONNECT'?this.parseNaverBrandProduct(value.product):this.parseProduct(value.product));}catch(error){pending.reject(error instanceof Error?error:new Error(String(error)));}
  }

  private parseProduct(value:unknown):CoupangChromeCollectionResult{
    if(!isRecord(value))throw new CoupangChromeCollectorError('INVALID_PRODUCT_RESULT','수집된 상품 정보 형식이 올바르지 않습니다.');
    const location=collectedLocation(value.finalUrl);
    if(!location||value.productId!==location.productId||value.itemId!==location.itemId||value.vendorItemId!==location.vendorItemId)throw new CoupangChromeCollectorError('PRODUCT_IDENTITY_MISMATCH','수집된 상품 식별값이 최종 쿠팡 상품 주소와 일치하지 않습니다.');
    const imageUrls=normalizeImages(value.imageUrls);if(!imageUrls.length)throw new CoupangChromeCollectorError('PRODUCT_IMAGES_NOT_FOUND','상품 갤러리 이미지를 확인하지 못했습니다. 열린 Chrome 상품 페이지를 확인하세요.');
    const reviews:Array<CollectorReview>=[];
    if(Array.isArray(value.reviews))for(const entry of value.reviews.slice(0,8)){
      if(!isRecord(entry))continue;const reviewTextRaw=safeText(entry.reviewTextRaw,4000);if(!reviewTextRaw)continue;
      const optionTextRaw=safeText(entry.optionTextRaw,500);const rating=typeof entry.rating==='number'&&entry.rating>=1&&entry.rating<=5?entry.rating:undefined;
      reviews.push({reviewTextRaw,...(optionTextRaw?{optionTextRaw}:{}),...(rating?{rating}:{})});
    }
    return {...location,productTitleRaw:safeText(value.productTitleRaw,500),imageUrls,reviews,collectedAt:safeText(value.collectedAt,60)??new Date().toISOString()};
  }

  private parseNaverBrandProduct(value:unknown):NaverBrandChromeCollectionResult{
    if(!isRecord(value))throw new CoupangChromeCollectorError('INVALID_PRODUCT_RESULT','수집된 네이버 상품 정보 형식이 올바르지 않습니다.');
    const finalUrl=safeText(value.finalUrl,2_000);const productKey=safeText(value.productKey,200);
    if(!finalUrl||!productKey)throw new CoupangChromeCollectorError('PRODUCT_IDENTITY_MISMATCH','네이버 상품의 최종 주소와 식별값을 확인하지 못했습니다.');
    try{const url=new URL(finalUrl);if(url.protocol!=='https:'||!['brand.naver.com','smartstore.naver.com','shopping.naver.com','pkgtour.naver.com'].includes(url.hostname))throw new Error();}catch{throw new CoupangChromeCollectorError('PRODUCT_IDENTITY_MISMATCH','네이버 상품의 최종 주소가 허용된 상품 페이지가 아닙니다.');}
    const imageUrls=normalizeNaverImages(value.imageUrls);if(!imageUrls.length)throw new CoupangChromeCollectorError('PRODUCT_IMAGES_NOT_FOUND','네이버 상품 갤러리 이미지를 확인하지 못했습니다.');
    const reviews:Array<CollectorReview>=[];
    if(Array.isArray(value.reviews))for(const entry of value.reviews.slice(0,8)){if(!isRecord(entry))continue;const reviewTextRaw=safeText(entry.reviewTextRaw,4000);if(!reviewTextRaw)continue;const rating=typeof entry.rating==='number'&&entry.rating>=1&&entry.rating<=5?entry.rating:undefined;reviews.push({reviewTextRaw,...(rating?{rating}:{})});}
    const productFacts=Array.isArray(value.productFacts)?value.productFacts.map((entry)=>safeText(entry,1500)).filter((entry):entry is string=>Boolean(entry)).slice(0,60):[];
    return {finalUrl,productKey,productTitleRaw:safeText(value.productTitleRaw,500),imageUrls,reviews,productFacts,collectedAt:safeText(value.collectedAt,60)??new Date().toISOString()};
  }

  private rejectAll(error:Error):void{for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();}
  private emitStatus():void{const status=this.status();for(const listener of this.statusListeners){listener(status);}}
  private async loadState():Promise<void>{try{const parsed=JSON.parse(await fs.readFile(this.statePath,'utf8'));if(isRecord(parsed))this.stored={promptAcknowledged:Boolean(parsed.promptAcknowledged),lastConnectedAt:safeText(parsed.lastConnectedAt,60),extensionVersion:safeText(parsed.extensionVersion,40)};}catch{/* 최초 실행 */}}
  private async saveState():Promise<void>{await fs.mkdir(path.dirname(this.statePath),{recursive:true});await fs.writeFile(this.statePath,JSON.stringify(this.stored,null,2),'utf8');}
  private async registerNativeHost():Promise<void>{
    await fs.mkdir(this.installDirectory,{recursive:true});
    if(process.platform!=='win32'){
      const scriptPath=path.join(this.installDirectory,'host.cjs');
      await fs.copyFile(this.options.hostExecutablePath,scriptPath);
      await fs.writeFile(this.installedHostPath,nativeHostLauncher(process.execPath,scriptPath,this.options.pipePath??collectorPipePath()),{mode:0o700});
      await fs.chmod(this.installedHostPath,0o700);
    }else if(path.resolve(this.options.hostExecutablePath)!==path.resolve(this.installedHostPath)){
      await fs.copyFile(this.options.hostExecutablePath,this.installedHostPath);
    }
    const manifest=createCoupangNativeHostManifest(this.installedHostPath);
    await fs.mkdir(path.dirname(this.manifestPath),{recursive:true});
    await fs.writeFile(this.manifestPath,JSON.stringify(manifest,null,2),'utf8');
    if(process.platform!=='win32')return;
    // Chrome는 32비트 보기를 먼저, 64비트 보기를 다음으로 확인한다.
    // 두 보기를 명시적으로 등록해 OS/Chrome 아키텍처 차이를 제거한다.
    await execFileAsync('reg.exe',['ADD',REGISTRY_KEY,'/ve','/t','REG_SZ','/d',this.manifestPath,'/f','/reg:32'],{windowsHide:true});
    await execFileAsync('reg.exe',['ADD',REGISTRY_KEY,'/ve','/t','REG_SZ','/d',this.manifestPath,'/f','/reg:64'],{windowsHide:true});
  }
}

