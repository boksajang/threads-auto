import { createHash } from 'node:crypto';

export function isNaverBrandAffiliateUrl(value:string):boolean {
  try{
    const url=new URL(value.trim());
    return url.protocol==='https:'&&url.hostname==='naver.me'&&!url.username&&!url.password&&!url.port&&url.pathname.length>1;
  }catch{return false;}
}

export function parseNaverBrandProductInput(value:string):{affiliateUrl:string;urlFingerprint:string} {
  const affiliateUrl=value.trim();
  if(!isNaverBrandAffiliateUrl(affiliateUrl))throw new Error('네이버 브랜드 커넥트에서 발급한 naver.me 상품 링크를 입력하세요.');
  return {affiliateUrl,urlFingerprint:createHash('sha256').update(affiliateUrl).digest('hex')};
}
