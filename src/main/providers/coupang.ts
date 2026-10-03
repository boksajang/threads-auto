import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Account } from '../../shared/domain';
import type { CredentialManager } from '../services/settings';
import { ProviderRequestError, type AffiliatePerformance, type ConnectionResult, type CoupangProvider, type ProductCandidate } from './contracts';

const HOST = 'https://api-gateway.coupang.com';

function productDetailUrl(product: any): string {
  const productId = String(product.productId ?? '').trim();
  if (!/^\d+$/.test(productId)) return '';
  let source: URL | undefined;
  try { source = new URL(String(product.productUrl ?? '')); } catch { /* 응답의 개별 ID로 계속 조합한다. */ }
  const value = (name:string):string => {
    const direct=String(product[name] ?? '').trim();
    const fromUrl=source?.searchParams.get(name)?.trim() ?? '';
    return /^\d+$/.test(direct) ? direct : /^\d+$/.test(fromUrl) ? fromUrl : '';
  };
  const url=new URL(`https://www.coupang.com/vp/products/${productId}`);
  const itemId=value('itemId');
  const vendorItemId=value('vendorItemId');
  if(itemId)url.searchParams.set('itemId',itemId);
  if(vendorItemId)url.searchParams.set('vendorItemId',vendorItemId);
  return url.toString();
}

function validShortAffiliateUrl(value:unknown):value is string {
  if(typeof value!=='string'||!value.trim())return false;
  try{
    const url=new URL(value.trim());
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port
      &&url.hostname.toLowerCase()==='link.coupang.com'&&/^\/a\/[^/]+\/?$/i.test(url.pathname);
  }catch{return false;}
}

export class CoupangPartnersProvider implements CoupangProvider {
  constructor(private readonly credentials: CredentialManager) {}

  async connectionFingerprint(accountId:string):Promise<string> {
    const accessKey=await this.credentials.get(`coupangAccessKey:${accountId}`);
    const secretKey=await this.credentials.get(`coupangSecretKey:${accountId}`);
    if(!accessKey||!secretKey)throw new Error('쿠팡 파트너스 Access Key와 Secret Key가 필요합니다.');
    return createHash('sha256').update(accessKey).update('\0').update(secretKey).digest('hex');
  }

  private async auth(accountId: string, method: string, pathWithQuery: string): Promise<string> {
    const accessKey = await this.credentials.get(`coupangAccessKey:${accountId}`);
    const secretKey = await this.credentials.get(`coupangSecretKey:${accountId}`);
    if (!accessKey || !secretKey) throw new Error('쿠팡 파트너스 Access Key와 Secret Key가 필요합니다.');
    const [path, query = ''] = pathWithQuery.split('?');
    const datetime = new Date().toISOString().replace(/[-:]/g, '').slice(2, 15) + 'Z';
    const signature = createHmac('sha256', secretKey).update(`${datetime}${method}${path}${query}`).digest('hex');
    return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
  }

  private async request(accountId: string, method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${HOST}${path}`, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: await this.auth(accountId, method, path), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 4_000_000) throw new Error('쿠팡 파트너스 API 응답 크기 제한을 초과했습니다.');
    const data = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    if (!response.ok) throw new ProviderRequestError(`쿠팡 파트너스 API 요청 실패 (${data?.code ?? response.status})`, response.status === 429 || response.status >= 500, Number(response.headers.get('retry-after') ?? 0) * 1000 || undefined, response.status);
    return data;
  }

  async test(accountId: string): Promise<ConnectionResult> {
    try { await this.search({ id: accountId } as Account, '노트북'); return { ok: true, message: '쿠팡 파트너스 연결에 성공했습니다.' }; }
    catch { return { ok: false, message: '쿠팡 상품 검색 실패: API Key와 권한을 확인하세요.' }; }
  }

  private products(account:Account,result:any,collection:'SEARCH'|'GOLDBOX'|'CATEGORY_BEST'|'COUPANG_PL'):ProductCandidate[] {
    const data=Array.isArray(result?.data)?result.data:(result?.data?.productData??[]);
    return data.map((product:any) => ({
      id: randomUUID(), accountId: account.id, sourceType: 'COUPANG' as const, sourceKey: String(product.productId),
      sourceUrl: productDetailUrl(product), title: String(product.productName??''), imageUrl: String(product.productImage??''),
      metadata: {
        price:Number(product.productPrice??0),
        isRocket:product.isRocket===true,
        isFreeShipping:product.isFreeShipping===true,
        isRocketFresh:product.isRocketFresh===true||product.isFresh===true||product.isFreshProduct===true,
        isGoldBox:collection==='GOLDBOX',
        isCategoryBest:collection==='CATEGORY_BEST',
        isCoupangPl:collection==='COUPANG_PL',
        categoryName:String(product.categoryName??''),
        sourceKinds:[collection],
      },
      productId: String(product.productId), price: Number(product.productPrice??0),
    })).filter((product:ProductCandidate)=>Boolean(product.productId&&product.sourceUrl&&product.title&&product.imageUrl));
  }

  async search(account: Account, keyword: string): Promise<ProductCandidate[]> {
    const path = `/v2/providers/affiliate_open_api/apis/openapi/products/search?keyword=${encodeURIComponent(keyword)}&limit=10`;
    const result = await this.request(account.id, 'GET', path);
    return this.products(account,result,'SEARCH');
  }

  async goldbox(account:Account):Promise<ProductCandidate[]> {
    const result=await this.request(account.id,'GET','/v2/providers/affiliate_open_api/apis/openapi/products/goldbox');
    return this.products(account,result,'GOLDBOX');
  }

  async bestCategory(account:Account,categoryId:string):Promise<ProductCandidate[]> {
    const result=await this.request(account.id,'GET',`/v2/providers/affiliate_open_api/apis/openapi/products/bestcategories/${encodeURIComponent(categoryId)}?limit=100`);
    return this.products(account,result,'CATEGORY_BEST').map((product)=>({...product,metadata:{...product.metadata,categoryId}}));
  }

  async coupangPl(account:Account,brandId?:string):Promise<ProductCandidate[]> {
    const suffix=brandId?`/${encodeURIComponent(brandId)}`:'';
    const result=await this.request(account.id,'GET',`/v2/providers/affiliate_open_api/apis/openapi/products/coupangPL${suffix}?limit=100`);
    return this.products(account,result,'COUPANG_PL').map((product)=>({...product,metadata:{...product.metadata,...(brandId?{brandId}:{})}}));
  }

  async deepLink(accountId: string, url: string, registeredSubId?: string): Promise<string> {
    const subId=registeredSubId?.trim();
    const result = await this.request(accountId, 'POST', '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink', { coupangUrls: [url], ...(subId?{subId}:{}) });
    if(String(result?.rCode??'')!=='0'){
      throw new ProviderRequestError(`쿠팡 파트너스 단축 링크 생성 실패 (${String(result?.rCode??'응답 오류')}): ${String(result?.rMessage??'변환 결과가 없습니다.')}`,false,undefined,200);
    }
    const shortenUrl=result?.data?.[0]?.shortenUrl;
    if(!validShortAffiliateUrl(shortenUrl)){
      throw new ProviderRequestError('쿠팡 파트너스 단축 링크 생성 응답에 유효한 link.coupang.com/a 링크가 없습니다.',false,undefined,200);
    }
    return shortenUrl.trim();
  }

  async performance(accountId: string, from: Date, to: Date): Promise<AffiliatePerformance[]> {
    const date = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value).replace(/-/g, '');
    const report = async (kind:'clicks'|'orders'|'cancels'):Promise<any[]> => {
      const rows:any[]=[];
      for(let page=0;page<100;page+=1){
        const query=`startDate=${date(from)}&endDate=${date(to)}&page=${page}`;
        const result=await this.request(accountId,'GET',`/v2/providers/affiliate_open_api/apis/openapi/v1/reports/${kind}?${query}`);
        if(String(result?.rCode??'')!=='0')throw new ProviderRequestError(`쿠팡 파트너스 리포트 조회 실패 (${String(result?.rCode??'응답 오류')}): ${String(result?.rMessage??'리포트 결과가 없습니다.')}`,false,undefined,200);
        if(!Array.isArray(result.data))throw new ProviderRequestError('쿠팡 파트너스 리포트 응답 형식이 올바르지 않습니다.',false,undefined,200);
        if(!result.data.length)break;
        rows.push(...result.data);
      }
      return rows;
    };
    const [clicks,orders,cancels]=await Promise.all([report('clicks'),report('orders'),report('cancels')]);
    const totals = new Map<string, AffiliatePerformance>();
    const normalizedDate=(value:unknown):string=>{
      const compact=String(value??'').trim();
      return /^\d{8}$/.test(compact)?`${compact.slice(0,4)}-${compact.slice(4,6)}-${compact.slice(6,8)}`:'';
    };
    const row = (item:any) => {
      const performanceDate=normalizedDate(item?.date);
      if(!performanceDate)return undefined;
      const subId=typeof item?.subId==='string'?item.subId.trim():'';
      const key=`${performanceDate}\u0000${subId}`;
      const existing = totals.get(key) ?? { date:performanceDate,subId,clicks:0,orders:0,orderAmount:0,revenue:0 };
      totals.set(key, existing); return existing;
    };
    for (const item of clicks) { const value=row(item); if(value)value.clicks+=Number(item.click??0); }
    for (const item of orders) { const value=row(item); if(value){value.orders+=Number(item.quantity??0);value.orderAmount+=Number(item.gmv??0);value.revenue+=Number(item.commission??0);} }
    for (const item of cancels) { const value=row(item); if(value){value.orders-=Number(item.quantity??0);value.orderAmount-=Number(item.gmv??0);value.revenue-=Number(item.commission??0);} }
    return [...totals.values()].sort((left,right)=>left.date.localeCompare(right.date)||left.subId.localeCompare(right.subId));
  }
}
