import { POLICY } from '../../shared/policy';

const URL_PATTERN=/https?:\/\/[^\s]+/gi;
export const naverBrandDisclosureLine='※ 이 포스팅은 네이버 쇼핑 커넥트 활동의 일환으로, 판매 발생 시 수수료를 제공받습니다. ※';
export const naverTravelDisclosureLine='※ 이 포스팅은 네이버 여행 커넥트 활동의 일환으로, 예약 발생 시 수수료를 제공받습니다. ※';
const disclosureLines=[naverBrandDisclosureLine,naverTravelDisclosureLine];

export class NaverBrandComplianceError extends Error {
  constructor(message:string){super(message);this.name='NaverBrandComplianceError';}
}

function assertLink(link:string):string {
  const value=link.trim();
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.hostname!=='naver.me')throw new Error();
  }catch{throw new NaverBrandComplianceError('네이버 브랜드 커넥트에서 발급한 naver.me HTTPS 링크가 필요합니다.');}
  return value;
}

export function naverBrandCreativeFromStoredBody(content:string,affiliateUrl:string):string {
  const link=assertLink(affiliateUrl);let body=content.trim();
  for(const disclosure of disclosureLines)if(body.startsWith(`${disclosure}\n\n`))body=body.slice(disclosure.length+2).trim();
  if(body.endsWith(`\n\n${link}`))body=body.slice(0,-(link.length+2)).trim();
  if(!body)throw new NaverBrandComplianceError('검증된 상품 광고 본문이 필요합니다.');
  if((body.match(URL_PATTERN)??[]).length)throw new NaverBrandComplianceError('광고 문장에는 URL을 넣지 마세요. 발급 링크는 프로그램이 마지막에 추가합니다.');
  if(/네이버 (쇼핑|여행) 커넥트 활동의 일환/.test(body))throw new NaverBrandComplianceError('광고 문장에는 제휴 고지문을 넣지 마세요. 프로그램이 첫 줄에 추가합니다.');
  return body;
}

export function composeNaverBrandPost(creativeBody:string,affiliateUrl:string,kind:'SHOPPING'|'TRAVEL'='SHOPPING'):string {
  const link=assertLink(affiliateUrl);const creative=naverBrandCreativeFromStoredBody(creativeBody,link);
  const disclosure=kind==='TRAVEL'?naverTravelDisclosureLine:naverBrandDisclosureLine;
  const result=`${disclosure}\n\n${creative}\n\n${link}`;
  assertNaverBrandPostCompliance(result,link);return result;
}

export function assertNaverBrandPostCompliance(content:string,affiliateUrl:string):void {
  const link=assertLink(affiliateUrl);const body=content.trim();
  if(!disclosureLines.some(line=>body.startsWith(`${line}\n\n`)))throw new NaverBrandComplianceError('네이버 커넥트 고지문은 본문 첫 줄에 표시해야 합니다.');
  const urls=body.match(URL_PATTERN)??[];
  if(urls.length!==1||urls[0]!==link||!body.endsWith(`\n\n${link}`))throw new NaverBrandComplianceError('발급 링크는 광고 문장과 빈 줄로 구분해 본문 마지막에 정확히 한 번 포함해야 합니다.');
  naverBrandCreativeFromStoredBody(body,link);
  if(body.length>POLICY.threadsTextLimit)throw new NaverBrandComplianceError(`고지문·광고 문장·링크를 포함한 본문이 Threads 글자 제한(${POLICY.threadsTextLimit}자)을 초과합니다.`);
}

export function composeNaverBrandPublishText(content:string,affiliateUrl:string):string {
  const body=content.trim();assertNaverBrandPostCompliance(body,affiliateUrl);
  const result=`${body}\n\n`;
  if(result.length>POLICY.threadsTextLimit)throw new NaverBrandComplianceError(`이미지 앞 빈 줄을 포함한 본문이 Threads 글자 제한(${POLICY.threadsTextLimit}자)을 초과합니다.`);
  return result;
}
