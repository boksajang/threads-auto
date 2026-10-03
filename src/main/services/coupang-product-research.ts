import type { CoupangMetadataStatus } from '../../shared/domain';
import { coupangUrlFingerprint, isCoupangAffiliateUrl, normalizeCoupangImageUrl, type ParsedCoupangProductInput } from './coupang-link-input';

export interface CoupangProductResearchResult {
  affiliateUrl: string;
  urlFingerprint: string;
  productName?: string;
  imageUrl?: string;
  productFacts: string[];
  researchSourceUrls: string[];
  metadataStatus: CoupangMetadataStatus;
  researchedAt: string;
  lastError?: string;
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))];
}

function queryFacts(url: URL): string[] {
  const pathProductId=/\/(?:vp\/)?products\/(\d+)/.exec(url.pathname)?.[1];
  return distinct([pathProductId ? `productId=${pathProductId}` : undefined, ...['pageKey', 'itemId', 'vendorItemId'].map((name) => {
    const value = url.searchParams.get(name)?.trim();
    return value ? `${name}=${value}` : undefined;
  })]);
}

function isCoupangProductDestination(url:URL):boolean {
  const host=url.hostname.toLowerCase();
  return url.protocol==='https:' && (host==='coupang.com'||host.endsWith('.coupang.com'));
}

export class CoupangProductResearchResolver {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => Date = () => new Date()) {}

  async resolve(input: ParsedCoupangProductInput): Promise<CoupangProductResearchResult> {
    const researchedAt = this.now().toISOString();
    try {
      const directAffiliateInput=input.originalInputType==='PLAIN_LINK'||input.originalInputType==='BLOG_ANCHOR_IMAGE';
      const response = await this.fetchImpl(input.affiliateUrl, { redirect:directAffiliateInput?'manual':'follow', signal:AbortSignal.timeout(15_000) });
      const location = response.headers.get('location');
      const finalValue = response.url || (location ? new URL(location,input.affiliateUrl).toString() : '');
      if (!finalValue) throw new Error('iframe 링크의 상품 이동 정보를 확인할 수 없습니다.');
      const redirectUrl = new URL(finalValue);
      const fallbackUrl = location ? new URL(location,input.affiliateUrl) : redirectUrl;
      if (directAffiliateInput) {
        const destination=location ? fallbackUrl : redirectUrl;
        if (!isCoupangProductDestination(destination)) throw new Error('상품 링크의 쿠팡 상품 식별 정보를 확인할 수 없습니다.');
        const productFacts=distinct([...input.productFacts,...queryFacts(destination)]);
        if (!productFacts.some((fact)=>/^(productId|pageKey)=/.test(fact))) throw new Error('상품 링크에서 안정적인 상품 식별값을 찾지 못했습니다.');
        return {
          affiliateUrl:input.affiliateUrl,urlFingerprint:input.urlFingerprint,productName:input.productName,
          imageUrl:input.imageUrl,productFacts,researchSourceUrls:distinct([input.affiliateUrl,destination.toString()]),
          metadataStatus:'READY',researchedAt,
        };
      }
      const affiliateUrl = redirectUrl.searchParams.get('link')?.trim()
        || fallbackUrl.searchParams.get('link')?.trim()
        || redirectUrl.searchParams.get('linkUrl')?.trim()
        || fallbackUrl.searchParams.get('linkUrl')?.trim()
        || (isCoupangAffiliateUrl(redirectUrl.toString()) ? redirectUrl.toString() : '');
      if (!affiliateUrl || !isCoupangAffiliateUrl(affiliateUrl)) throw new Error('이동 정보에 유효한 쿠팡 파트너스 상품 링크가 없습니다.');
      const productName = redirectUrl.searchParams.get('productDescription')?.trim()
        || redirectUrl.searchParams.get('title')?.trim()
        || fallbackUrl.searchParams.get('productDescription')?.trim()
        || fallbackUrl.searchParams.get('title')?.trim() || undefined;
      const imageUrl = normalizeCoupangImageUrl(redirectUrl.searchParams.get('productImage')
        || redirectUrl.searchParams.get('image')
        || fallbackUrl.searchParams.get('productImage')
        || fallbackUrl.searchParams.get('image') || '');
      const productUrl = new URL(affiliateUrl);
      const productFacts = distinct([...input.productFacts, ...queryFacts(redirectUrl), ...queryFacts(productUrl)]);
      return {
        affiliateUrl, urlFingerprint:coupangUrlFingerprint(affiliateUrl), productName, imageUrl, productFacts,
        researchSourceUrls:distinct([input.affiliateUrl, affiliateUrl, imageUrl]),
        metadataStatus:productName ? 'READY' : 'INFORMATION_REQUIRED', researchedAt,
      };
    } catch (error) {
      return {
        affiliateUrl:input.affiliateUrl, urlFingerprint:input.urlFingerprint, productName:input.productName,
        imageUrl:input.imageUrl, productFacts:input.productFacts, researchSourceUrls:input.researchSourceUrls,
        metadataStatus:'FAILED', researchedAt,
        lastError:error instanceof Error ? error.message : '쿠팡 상품 정보를 확인하지 못했습니다.',
      };
    }
  }
}
