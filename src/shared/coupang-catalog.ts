export const COUPANG_CATEGORY_OPTIONS = [
  ['1001','여성패션'],['1002','남성패션'],['1010','뷰티'],['1011','출산/유아동'],['1012','식품'],
  ['1013','주방용품'],['1014','생활용품'],['1015','홈인테리어'],['1016','가전디지털'],['1017','스포츠/레저'],
  ['1018','자동차용품'],['1019','도서/음반/DVD'],['1020','완구/취미'],['1021','문구/오피스'],['1024','헬스/건강식품'],
  ['1025','국내여행'],['1026','해외여행'],['1029','반려동물용품'],['1030','유아동패션'],
] as const;

export const COUPANG_PL_BRAND_OPTIONS = [
  ['1001','탐사'],['1002','코멧'],['1003','Gomgom'],['1004','줌'],['1006','곰곰'],
  ['1007','꼬리별'],['1008','베이스알파에센셜'],['1010','비타할로'],['1011','비지엔젤'],
] as const;

export type CoupangCategorySelection = 'ALL' | typeof COUPANG_CATEGORY_OPTIONS[number][0];
export type CoupangPlSelection = 'ALL' | typeof COUPANG_PL_BRAND_OPTIONS[number][0];

export interface CoupangProductSearchSettings {
  keywords:string;
  keywordSearchIncluded:boolean;
  goldBoxIncluded:boolean;
  categoryBestIncluded:boolean;
  categoryId:CoupangCategorySelection;
  coupangPlIncluded:boolean;
  coupangPlBrandId:CoupangPlSelection;
  rocketOnly:boolean;
  rocketFreshOnly:boolean;
}

export const DEFAULT_COUPANG_PRODUCT_SEARCH_SETTINGS:CoupangProductSearchSettings={
  keywords:'',keywordSearchIncluded:true,goldBoxIncluded:false,categoryBestIncluded:false,categoryId:'ALL',
  coupangPlIncluded:false,coupangPlBrandId:'ALL',rocketOnly:false,rocketFreshOnly:false,
};

export function normalizeCoupangProductSearchSettings(config:Record<string,unknown>):CoupangProductSearchSettings {
  const legacyGoldBox=config.goldBoxOnly===true;
  const categoryIds=new Set<string>(COUPANG_CATEGORY_OPTIONS.map(([id])=>id));
  const brandIds=new Set<string>(COUPANG_PL_BRAND_OPTIONS.map(([id])=>id));
  const categoryId=String(config.categoryId??'ALL');
  const coupangPlBrandId=String(config.coupangPlBrandId??'ALL');
  return {
    keywords:String(config.keywords??''),
    keywordSearchIncluded:typeof config.keywordSearchIncluded==='boolean'?config.keywordSearchIncluded:!legacyGoldBox,
    goldBoxIncluded:typeof config.goldBoxIncluded==='boolean'?config.goldBoxIncluded:legacyGoldBox,
    categoryBestIncluded:config.categoryBestIncluded===true,
    categoryId:(categoryId==='ALL'||categoryIds.has(categoryId)?categoryId:'ALL') as CoupangCategorySelection,
    coupangPlIncluded:config.coupangPlIncluded===true,
    coupangPlBrandId:(coupangPlBrandId==='ALL'||brandIds.has(coupangPlBrandId)?coupangPlBrandId:'ALL') as CoupangPlSelection,
    rocketOnly:config.rocketOnly===true,
    rocketFreshOnly:config.rocketFreshOnly===true,
  };
}

export const hasCoupangProductSource=(settings:CoupangProductSearchSettings)=>
  settings.keywordSearchIncluded||settings.goldBoxIncluded||settings.categoryBestIncluded||settings.coupangPlIncluded;
