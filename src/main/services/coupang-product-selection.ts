import type { SourceCandidate } from '../../shared/domain';

export interface CoupangProductSelectionOptions {
  keywords:string[];
  rocketOnly:boolean;
  rocketFreshOnly:boolean;
  limit?:number;
  excludedSourceKeys?:ReadonlySet<string>;
}

export function selectCoupangProductCandidates(candidates:SourceCandidate[],options:CoupangProductSelectionOptions):SourceCandidate[] {
  const normalizedTerms=options.keywords.map((value)=>value.trim().toLocaleLowerCase('ko-KR')).filter(Boolean);
  const unique=new Map<string,SourceCandidate>();
  for(const candidate of candidates){
    if(options.excludedSourceKeys?.has(candidate.sourceKey))continue;
    if(options.rocketOnly&&candidate.metadata.isRocket!==true)continue;
    if(options.rocketFreshOnly&&candidate.metadata.isRocketFresh!==true&&candidate.metadata.isRocket!==true)continue;
    const current=unique.get(candidate.sourceKey);
    if(!current){unique.set(candidate.sourceKey,candidate);continue;}
    const sourceKinds=[...new Set([
      ...(Array.isArray(current.metadata.sourceKinds)?current.metadata.sourceKinds.map(String):[]),
      ...(Array.isArray(candidate.metadata.sourceKinds)?candidate.metadata.sourceKinds.map(String):[]),
    ])];
    unique.set(candidate.sourceKey,{...current,metadata:{...current.metadata,...candidate.metadata,
      isRocket:current.metadata.isRocket===true||candidate.metadata.isRocket===true,
      isRocketFresh:current.metadata.isRocketFresh===true||candidate.metadata.isRocketFresh===true,
      isGoldBox:current.metadata.isGoldBox===true||candidate.metadata.isGoldBox===true,
      isCategoryBest:current.metadata.isCategoryBest===true||candidate.metadata.isCategoryBest===true,
      isCoupangPl:current.metadata.isCoupangPl===true||candidate.metadata.isCoupangPl===true,
      sourceKinds,
    }});
  }
  const relevance=(item:SourceCandidate)=>normalizedTerms.some((term)=>item.title.toLocaleLowerCase('ko-KR').includes(term));
  return [...unique.values()].sort((left,right)=>{
    const score=(item:SourceCandidate)=>Number(item.metadata.isGoldBox===true)*4+Number(item.metadata.isRocketFresh===true)*3+Number(item.metadata.isRocket===true)*2+Number(relevance(item));
    return score(right)-score(left)||left.title.localeCompare(right.title,'ko-KR');
  }).slice(0,options.limit??100);
}
