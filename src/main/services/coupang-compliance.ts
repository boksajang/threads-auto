import { POLICY } from '../../shared/policy';

const URL_PATTERN = /https?:\/\/[^\s]+/gi;

export class CoupangComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoupangComplianceError';
  }
}

const occurrenceCount = (value: string, needle: string): number => value.split(needle).length - 1;
export const coupangDisclosureLine = `※ ${POLICY.coupangDisclosure} ※`;

function assertAffiliateUrl(affiliateUrl: string): string {
  const normalizedUrl = affiliateUrl.trim();
  if (!normalizedUrl || !normalizedUrl.startsWith('https://')) {
    throw new CoupangComplianceError('쿠팡 파트너스 HTTPS 링크가 필요합니다.');
  }
  return normalizedUrl;
}

export function assertCoupangCreativeBody(content: string): void {
  const creativeBody = content.trim();
  if (!creativeBody) throw new CoupangComplianceError('검증된 상품 광고 본문이 필요합니다.');
  if ((creativeBody.match(URL_PATTERN) ?? []).length > 0) {
    throw new CoupangComplianceError('상품 광고 문장에는 URL을 직접 넣지 마세요. 상품 링크는 Core가 본문 마지막에 추가합니다.');
  }
  if (creativeBody.includes(POLICY.coupangDisclosure) || /쿠팡\s*파트너스\s*활동의\s*일환/.test(creativeBody)) {
    throw new CoupangComplianceError('상품 광고 문장에는 제휴 고지문을 직접 넣지 마세요. Core가 본문 첫 줄에 추가합니다.');
  }
}

export function assertCoupangPostCompliance(content: string, affiliateUrl: string): void {
  const normalizedBody = content.trim();
  const normalizedUrl = assertAffiliateUrl(affiliateUrl);
  if (!normalizedBody.startsWith(`${coupangDisclosureLine}\n\n`)) {
    throw new CoupangComplianceError('강조된 쿠팡 파트너스 고지문은 본문 첫 줄에 정확히 표시하고 광고 문장과 빈 줄로 구분해야 합니다.');
  }
  if (occurrenceCount(normalizedBody, POLICY.coupangDisclosure) !== 1 || occurrenceCount(normalizedBody, coupangDisclosureLine) !== 1) {
    throw new CoupangComplianceError('쿠팡 파트너스 고지문은 ※ 기호로 감싸 정확히 한 번만 표시해야 합니다.');
  }
  const urls = normalizedBody.match(URL_PATTERN) ?? [];
  if (urls.length !== 1 || urls[0] !== normalizedUrl || !normalizedBody.endsWith(`\n\n${normalizedUrl}`)) {
    throw new CoupangComplianceError('현재 상품 링크는 광고 문장과 빈 줄로 구분해 본문 마지막에 정확히 한 번 포함해야 합니다.');
  }
  const creativeBody = normalizedBody.slice(coupangDisclosureLine.length + 2, -(normalizedUrl.length + 2)).trim();
  assertCoupangCreativeBody(creativeBody);
  if (normalizedBody.length > POLICY.threadsTextLimit) {
    throw new CoupangComplianceError(`고지문·광고 문장·링크를 포함한 본문이 Threads 글자 제한(${POLICY.threadsTextLimit}자)을 초과합니다.`);
  }
}

export function composeCoupangPost(creativeBody: string, affiliateUrl: string): string {
  const normalizedCreativeBody = creativeBody.trim();
  const normalizedUrl = affiliateUrl.trim();
  assertCoupangCreativeBody(normalizedCreativeBody);
  const result = `${coupangDisclosureLine}\n\n${normalizedCreativeBody}\n\n${normalizedUrl}`;
  assertCoupangPostCompliance(result, normalizedUrl);
  return result;
}

/** 이미지 앞에 빈 줄 하나가 전달되도록 발행 요청에서만 후행 줄바꿈을 보존한다. */
export function composeCoupangPublishText(content: string, affiliateUrl: string): string {
  const normalizedBody=content.trim();
  assertCoupangPostCompliance(normalizedBody,affiliateUrl);
  const result=`${normalizedBody}\n\n`;
  if(result.length>POLICY.threadsTextLimit){
    throw new CoupangComplianceError(`이미지 앞 빈 줄을 포함한 본문이 Threads 글자 제한(${POLICY.threadsTextLimit}자)을 초과합니다.`);
  }
  return result;
}

/** 기존 단일 본문 또는 예전 본문/댓글 준비본에서 Agent 광고 문장만 안전하게 꺼낸다. */
export function coupangCreativeFromStoredBody(content: string, affiliateUrl: string): string {
  const normalizedUrl = assertAffiliateUrl(affiliateUrl);
  let creativeBody = content.trim();
  if (creativeBody.startsWith(`${coupangDisclosureLine}\n\n`)) {
    creativeBody = creativeBody.slice(coupangDisclosureLine.length + 2).trim();
  }
  if (creativeBody.endsWith(`\n\n${normalizedUrl}`)) {
    creativeBody = creativeBody.slice(0, -(normalizedUrl.length + 2)).trim();
  }
  assertCoupangCreativeBody(creativeBody);
  return creativeBody;
}
