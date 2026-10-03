import { createHash } from 'node:crypto';
import type { CoupangInputType, CoupangMetadataStatus } from '../../shared/domain';

const AFFILIATE_HOSTS = new Set(['link.coupang.com', 'coupa.ng']);
const MAX_INPUT_LENGTH = 20_000;

export interface ParsedCoupangProductInput {
  originalInputType: CoupangInputType;
  affiliateUrl: string;
  urlFingerprint: string;
  productName?: string;
  imageUrl?: string;
  productFacts: string[];
  researchSourceUrls: string[];
  metadataStatus: CoupangMetadataStatus;
}

export interface CoupangProductIdentity {
  productId?: string;
  itemId?: string;
  vendorItemId?: string;
}

export function coupangProductIdentity(values: string[]): CoupangProductIdentity {
  const productIds = new Set<string>();
  const itemIds = new Set<string>();
  const vendorItemIds = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    const fact = /^(productId|pageKey|itemId|vendorItemId)=(\d+)$/i.exec(value);
    if (fact) {
      const name=fact[1].toLowerCase();
      if (name === 'itemid') itemIds.add(fact[2]);
      else if(name === 'vendoritemid') vendorItemIds.add(fact[2]);
      else productIds.add(fact[2]);
      continue;
    }
    try {
      const url = new URL(value);
      const pathProductId=/\/(?:vp\/)?products\/(\d+)/i.exec(url.pathname)?.[1];
      const queryProductId=url.searchParams.get('productId')?.trim()||url.searchParams.get('pageKey')?.trim();
      const itemId=url.searchParams.get('itemId')?.trim();
      const vendorItemId=url.searchParams.get('vendorItemId')?.trim();
      if(pathProductId)productIds.add(pathProductId);
      if(queryProductId&&/^\d+$/.test(queryProductId))productIds.add(queryProductId);
      if(itemId&&/^\d+$/.test(itemId))itemIds.add(itemId);
      if(vendorItemId&&/^\d+$/.test(vendorItemId))vendorItemIds.add(vendorItemId);
    } catch { /* 제품 사실 문자열은 URL이 아닐 수 있다. */ }
  }
  return {
    productId:productIds.size===1?[...productIds][0]:undefined,
    itemId:itemIds.size===1?[...itemIds][0]:undefined,
    vendorItemId:vendorItemIds.size===1?[...vendorItemIds][0]:undefined,
  };
}

export function isSameCoupangProduct(left: CoupangProductIdentity, right: CoupangProductIdentity): boolean {
  if (!left.productId || !right.productId || left.productId !== right.productId) return false;
  if(left.itemId&&right.itemId)return left.itemId===right.itemId;
  if(left.vendorItemId&&right.vendorItemId)return left.vendorItemId===right.vendorItemId;
  return false;
}

function decodeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isSafeInteger(code) ? String.fromCodePoint(code) : match;
  });
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  const expression = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(expression)) result.set(match[1].toLowerCase(), decodeHtml(match[2] ?? match[3] ?? match[4] ?? ''));
  return result;
}

export function isCoupangAffiliateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && AFFILIATE_HOSTS.has(url.hostname.toLowerCase());
  } catch { return false; }
}

export function normalizeCoupangImageUrl(value: string): string | undefined {
  const trimmed = decodeHtml(value.trim());
  if (!trimmed || trimmed.includes('\\')) return undefined;
  let candidate = trimmed;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  else if (candidate.startsWith('/') && !candidate.startsWith('//')) {
    if (!/^\/(?:thumbnails|image|images)\//i.test(candidate) || candidate.split('/').includes('..')) return undefined;
    candidate = `https://thumbnail6.coupangcdn.com${candidate}`;
  }
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(hostname === 'coupangcdn.com' || hostname.endsWith('.coupangcdn.com'))) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export function coupangUrlFingerprint(value: string): string {
  const url = new URL(value);
  url.hash = '';
  const canonical = `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname}${url.search}`;
  return createHash('sha256').update(canonical).digest('hex');
}

function factsFromUrl(value: string): string[] {
  const url = new URL(value);
  const facts: string[] = [];
  for (const name of ['pageKey', 'itemId', 'vendorItemId']) {
    const found = url.searchParams.get(name);
    if (found?.trim()) facts.push(`${name}=${found.trim()}`);
  }
  return facts;
}

function result(inputType: CoupangInputType, affiliateUrl: string, productName?: string, imageUrl?: string, pending = false): ParsedCoupangProductInput {
  if (!isCoupangAffiliateUrl(affiliateUrl)) throw new Error('쿠팡 파트너스 상품 링크는 link.coupang.com 또는 coupa.ng의 HTTPS 주소만 사용할 수 있습니다.');
  const facts = factsFromUrl(affiliateUrl);
  const cleanName = productName?.trim() || undefined;
  const cleanImage = imageUrl ? normalizeCoupangImageUrl(imageUrl) : undefined;
  return {
    originalInputType:inputType, affiliateUrl, urlFingerprint:coupangUrlFingerprint(affiliateUrl),
    productName:cleanName, imageUrl:cleanImage, productFacts:facts,
    researchSourceUrls:[affiliateUrl, cleanImage].filter((value): value is string => Boolean(value)),
    metadataStatus:pending ? 'PENDING' : cleanName ? 'READY' : 'INFORMATION_REQUIRED',
  };
}

export function parseCoupangProductInput(rawInput: string): ParsedCoupangProductInput {
  const input = rawInput.trim();
  if (!input) throw new Error('쿠팡 상품 링크를 입력하세요.');
  if (input.length > MAX_INPUT_LENGTH) throw new Error('쿠팡 상품 입력이 너무 깁니다.');
  if (/^<\s*iframe\b/i.test(input)) {
    if (!/^<\s*iframe\b[\s\S]*?(?:>\s*<\s*\/\s*iframe\s*>|\/\s*>)$/i.test(input)) throw new Error('완전한 iframe 태그 하나만 입력하세요.');
    const opening = input.match(/^<\s*iframe\b[^>]*>/i)?.[0] ?? input.match(/^<\s*iframe\b[^>]*\/\s*>/i)?.[0];
    const src = opening && attributes(opening).get('src');
    if (!src) throw new Error('iframe 태그에 src 링크가 없습니다.');
    return result('IFRAME', src, undefined, undefined, true);
  }
  if (/^<\s*a\b/i.test(input)) {
    const match = input.match(/^\s*(<\s*a\b[^>]*>)\s*(<\s*img\b[^>]*\/?>)\s*<\s*\/\s*a\s*>\s*$/i);
    if (!match) throw new Error('블로그 상품 태그는 링크 안에 이미지 하나가 있는 형태만 사용할 수 있습니다.');
    const anchor = attributes(match[1]);
    const image = attributes(match[2]);
    const href = anchor.get('href');
    if (!href) throw new Error('블로그 상품 태그에 href 링크가 없습니다.');
    return result('BLOG_ANCHOR_IMAGE', href, image.get('alt'), image.get('src'));
  }
  if (/[<>]/.test(input)) throw new Error('지원하지 않는 HTML입니다. 상품 링크, iframe 또는 블로그 상품 태그만 입력하세요.');
  if (/\r|\n/.test(input)) throw new Error('상품 입력은 한 번에 하나씩 등록하세요.');
  const separator = input.indexOf('|');
  if (separator >= 0) {
    if (input.indexOf('|', separator + 1) >= 0) throw new Error('상품명 | 링크 형식에는 구분자 하나만 사용할 수 있습니다.');
    const productName = input.slice(0, separator).trim();
    const link = input.slice(separator + 1).trim();
    if (!productName || !link) throw new Error('상품명 | 링크 형식으로 모두 입력하세요.');
    return result('PLAIN_LINK', link, productName);
  }
  return result('PLAIN_LINK', input);
}
