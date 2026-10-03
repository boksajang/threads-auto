/* global chrome, console, TextEncoder, URL, document, location, setTimeout */
'use strict';

(() => {
  const PROTOCOL_VERSION = 2;
  const MAX_MESSAGE_BYTES = 512 * 1024;
  const MAX_REVIEW_TEXT_LENGTH = 4_000;
  const HYDRATION_TIMEOUT_MS = 15_000;

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const compact = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const byteLength = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

  function validIdentifier(value) {
    return typeof value === 'string' && /^\d{1,32}$/.test(value);
  }

  function currentIdentity() {
    const match = /^\/vp\/products\/(\d+)\/?$/.exec(location.pathname);
    const url = new URL(location.href);
    const itemId = url.searchParams.get('itemId');
    const vendorItemId = url.searchParams.get('vendorItemId');
    if (!match || (itemId && !validIdentifier(itemId)) || (vendorItemId && !validIdentifier(vendorItemId))) return null;
    if (!itemId && !vendorItemId) return null;
    return { productId: match[1], ...(itemId ? { itemId } : {}), ...(vendorItemId ? { vendorItemId } : {}) };
  }

  function restriction() {
    const text = compact(document.body?.innerText).slice(0, 120_000);
    const title = compact(document.title);
    if (/captcha|보안\s*문자|자동\s*입력\s*방지/i.test(`${title} ${text}`)) {
      return { code: 'CAPTCHA_REQUIRED', message: '쿠팡이 보안문자 확인을 요청했습니다. 열린 Chrome 화면에서 확인을 완료한 뒤 다시 시도하세요.' };
    }
    if (/access\s*denied|사용\s*권한이\s*(?:없습니다|제한)|요청하신\s*페이지의\s*사용권한/i.test(`${title} ${text}`)) {
      return { code: 'ACCESS_RESTRICTED', message: '쿠팡이 현재 상품 페이지 접근을 제한했습니다. 열린 Chrome 화면의 상태를 확인하세요.' };
    }
    return null;
  }

  function normalizeImage(rawValue) {
    const raw = compact(rawValue);
    if (!raw) return null;
    try {
      const url = new URL(raw, location.href);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || !(host === 'coupangcdn.com' || host.endsWith('.coupangcdn.com'))) return null;
      url.username = '';
      url.password = '';
      url.hash = '';
      url.pathname = url.pathname.replace(/\/(?:48x48|96x96|230x230|292x292|492x492)ex\//i, '/492x492ex/');
      return url.toString();
    } catch {
      return null;
    }
  }

  function imageIdentity(value) {
    try {
      const url = new URL(value);
      return `${url.hostname}${url.pathname.replace(/\/\d+x\d+ex\//i, '/__size__/')}`;
    } catch {
      return value;
    }
  }

  function imageSource(image) {
    return image.getAttribute('data-origin')
      || image.getAttribute('data-img-src')
      || image.getAttribute('data-src')
      || image.currentSrc
      || image.src;
  }

  function collectImages(maxImages) {
    const selectorGroups = [
      '[class~="twc-w-[70px]"] li img',
      '.prod-image__item img, .prod-image__detail img, #repImageContainer img',
      '[class*="product-image"] img, [class*="prod-image"] img'
    ];
    const results = [];
    const seen = new Set();
    for (const selectors of selectorGroups) {
      for (const image of document.querySelectorAll(selectors)) {
        const normalized = normalizeImage(imageSource(image));
        if (!normalized) continue;
        const identity = imageIdentity(normalized);
        if (seen.has(identity)) continue;
        seen.add(identity);
        results.push(normalized);
        if (results.length >= maxImages) return results;
      }
    }
    return results;
  }

  function productTitle() {
    const selectors = [
      '#MAIN_CONTENT_ROOT_ID h3',
      'main h3',
      'h1',
      '[class*="product-title"]',
      '[class*="prod-buy-header"] h2',
      '[class*="prod-buy-header"]'
    ];
    for (const selector of selectors) {
      const value = compact(document.querySelector(selector)?.textContent);
      if (value) return value.slice(0, 500);
    }
    return '';
  }

  function firstMatchingNodes(selectors) {
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      if (nodes.length) return nodes;
    }
    return [];
  }

  function reviewText(node) {
    const content = node.matches?.('[class*="review-content"], [class*="review__content"], [class~="twc-break-all"]')
      ? node
      : node.querySelector?.('[class*="review-content"], [class*="review__content"], [class*="review__article__list__review__content"], [class~="twc-break-all"]');
    return compact((content || node).textContent).slice(0, MAX_REVIEW_TEXT_LENGTH);
  }

  function reviewField(node, selectors, maxLength) {
    for (const selector of selectors) {
      const value = compact(node.querySelector?.(selector)?.textContent);
      if (value) return value.slice(0, maxLength);
    }
    return undefined;
  }

  function reviewRating(node) {
    const candidate = node.querySelector?.('[aria-label*="별"], [class*="rating"]');
    const source = `${candidate?.getAttribute?.('aria-label') ?? ''} ${candidate?.textContent ?? ''}`;
    const match = /([1-5](?:\.\d+)?)\s*(?:점|별)?/.exec(source);
    const value = match ? Number(match[1]) : NaN;
    return Number.isFinite(value) && value >= 1 && value <= 5 ? value : undefined;
  }

  function collectReviews(maxReviews) {
    const nodes = firstMatchingNodes([
      '.sdp-review__article__list',
      '#sdpReview article',
      '[data-testid*="review-item"]',
      'article[class*="review"]',
      '[class*="review__article__list"]',
      '[class*="review-content"]'
    ]);
    const reviews = [];
    const seen = new Set();
    for (const node of nodes) {
      const text = reviewText(node);
      if (text.length < 20 || seen.has(text)) continue;
      seen.add(text);
      const optionTextRaw = reviewField(node, ['[class*="review__article__list__info__product-info"]', '[class*="review-option"]', '[class*="option"]'], 500);
      const rating = reviewRating(node);
      reviews.push({
        reviewTextRaw: text,
        ...(optionTextRaw ? { optionTextRaw } : {}),
        ...(rating ? { rating } : {})
      });
      if (reviews.length >= maxReviews) break;
    }
    return reviews;
  }

  async function waitForReviews(maxReviews) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const denied = restriction();
      if (denied) throw Object.assign(new Error(denied.message), { code: denied.code });
      const reviews = collectReviews(maxReviews);
      if (reviews.length) return reviews;
      await delay(400);
    }
    return [];
  }

  async function waitForReviewSection() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const denied = restriction();
      if (denied) throw Object.assign(new Error(denied.message), { code: denied.code });
      const section = document.querySelector('#sdpReview, [id*="review"], [class*="review"]');
      if (section) return section;
      await delay(400);
    }
    return null;
  }

  async function waitForProductImages(maxImages) {
    const deadline = Date.now() + HYDRATION_TIMEOUT_MS;
    let best = [];
    let bestSignature = '';
    let unchangedPasses = 0;
    while (Date.now() < deadline) {
      const denied = restriction();
      if (denied) throw Object.assign(new Error(denied.message), { code: denied.code });
      const images = collectImages(maxImages);
      const signature = images.join('\n');
      if (images.length > best.length || (images.length === best.length && signature !== bestSignature)) {
        best = images;
        bestSignature = signature;
        unchangedPasses = 0;
      } else if (best.length) unchangedPasses += 1;
      if (best.length >= maxImages || (best.length > 1 && unchangedPasses >= 6)) return best;
      await delay(400);
    }
    if (best.length) return best;
    const error = new Error('상품 갤러리 이미지를 확인하지 못했습니다. 열린 Chrome 상품 페이지를 확인하세요.');
    error.code = 'PRODUCT_IMAGES_NOT_FOUND';
    throw error;
  }

  async function collectPage(request) {
    const identity = currentIdentity();
    const matches = identity && identity.productId === request.productId
      && (!request.itemId || identity.itemId === request.itemId)
      && (!request.vendorItemId || identity.vendorItemId === request.vendorItemId);
    if (!matches) {
      const error = new Error('열린 상품 페이지의 productId, itemId 또는 vendorItemId가 요청과 일치하지 않습니다.');
      error.code = 'PRODUCT_IDENTITY_MISMATCH';
      throw error;
    }
    const denied = restriction();
    if (denied) throw Object.assign(new Error(denied.message), { code: denied.code });
    const imageUrls = await waitForProductImages(request.maxImages);
    const reviewSection = await waitForReviewSection();
    if (reviewSection) {
      reviewSection.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
    const finalRestriction = restriction();
    if (finalRestriction) throw Object.assign(new Error(finalRestriction.message), { code: finalRestriction.code });
    const reviews = reviewSection ? await waitForReviews(request.maxReviews) : [];
    const result = {
      productId: identity.productId,
      ...(identity.itemId ? { itemId: identity.itemId } : {}),
      ...(identity.vendorItemId ? { vendorItemId: identity.vendorItemId } : {}),
      productTitleRaw: productTitle(),
      imageUrls,
      reviews,
      collectedAt: new Date().toISOString()
    };
    if (byteLength(result) > MAX_MESSAGE_BYTES) {
      const error = new Error('상품 수집 결과가 허용된 메시지 크기를 초과했습니다.');
      error.code = 'MESSAGE_TOO_LARGE';
      throw error;
    }
    return result;
  }

  function currentNaverIdentity() {
    if(location.hostname==='pkgtour.naver.com'){
      const travel=/^\/products\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
      return travel?{productKey:`${location.hostname}:${travel[1]}:${travel[2]}`,travel:true}:null;
    }
    const match=/\/products\/(\d+)/.exec(location.pathname);
    if(!match||!['brand.naver.com','smartstore.naver.com','shopping.naver.com'].includes(location.hostname))return null;
    return {productKey:`${location.hostname}:${match[1]}`};
  }

  function normalizeNaverImage(rawValue) {
    const raw=compact(rawValue);if(!raw)return null;
    try{
      const url=new URL(raw,location.href);const host=url.hostname.toLowerCase();
      if(!['http:','https:'].includes(url.protocol)||!(host==='pstatic.net'||host.endsWith('.pstatic.net')))return null;
      url.protocol='https:';url.username='';url.password='';url.hash='';return url.toString();
    }catch{return null;}
  }

  function collectNaverImages(maxImages) {
    const results=[];const seen=new Set();
    const travel=currentNaverIdentity()?.travel;
    const nodes=document.querySelectorAll(travel?'[class*="DetailPhotoSlider"] img':'img[alt="대표이미지"], img[alt^="추가이미지"]');
    for(const image of nodes){
      const normalized=normalizeNaverImage(imageSource(image));if(!normalized)continue;
      const alt=compact(image.getAttribute('alt'));const width=Math.max(image.naturalWidth||0,image.width||0);
      if(!travel&&width<80&&!/(대표이미지|추가이미지|상품)/.test(alt))continue;
      const url=new URL(normalized);const identity=`${url.hostname}${url.pathname}`;
      if(seen.has(identity))continue;seen.add(identity);results.push(normalized);
      if(results.length>=maxImages)break;
    }
    return results;
  }

  async function waitForNaverImages(maxImages) {
    const deadline=Date.now()+HYDRATION_TIMEOUT_MS;let best=[];let stable=0;
    while(Date.now()<deadline){
      const images=collectNaverImages(maxImages);
      if(images.length>best.length){best=images;stable=0;}else if(best.length)stable+=1;
      if(best.length>=maxImages||(best.length&&stable>=5))return best;
      await delay(400);
    }
    if(best.length)return best;
    const error=new Error('네이버 상품 갤러리 이미지를 확인하지 못했습니다.');error.code='PRODUCT_IMAGES_NOT_FOUND';throw error;
  }

  function collectNaverReviews(maxReviews) {
    const reviews=[];const seen=new Set();
    for(const node of document.querySelectorAll('button, article, [class*="review"]')){
      const text=compact(node.textContent);
      if(text.length<20||text.length>MAX_REVIEW_TEXT_LENGTH||!/(평점|리뷰)/.test(text)||seen.has(text))continue;
      const cleaned=text.replace(/^review_image\s*/i,'').trim();
      if(cleaned.length<20)continue;seen.add(cleaned);
      const match=/평점\s*([1-5](?:\.\d+)?)/.exec(cleaned);const rating=match?Number(match[1]):undefined;
      reviews.push({reviewTextRaw:cleaned,...(rating?{rating}:{})});if(reviews.length>=maxReviews)break;
    }
    return reviews;
  }

  function collectNaverFacts() {
    if(currentNaverIdentity()?.travel){
      const facts=['connectType=TRAVEL'];
      const add=(value)=>{const text=compact(value);if(text&&text.length<=1500&&!facts.includes(text))facts.push(text);};
      add(document.querySelector('h1')?.textContent);
      // 긴 약관/중첩 일정이 상한을 채우기 전에 개별 일정의 이용 조건을 보존한다.
      for(const node of document.querySelectorAll('[class*="DetailSchedule"]')){
        if(node.querySelector('[class*="DetailSchedule"]'))continue;
        const text=compact(node.textContent);
        if(text.length<=1500&&/(무제한|대체|변경|예정|동급|추가|별도)/.test(text))add(text);
      }
      // 상품 자체의 설명·조건만 사용한다. 하단 추천상품, 사용자 프로필, 예약 양식은 수집하지 않는다.
      for(const row of document.querySelectorAll('[class*="DetailDescription_col"]')){
        const label=compact(row.querySelector('dt')?.textContent);
        for(const item of row.querySelectorAll('li'))add(`${label}: ${item.textContent}`);
      }
      for(const section of document.querySelectorAll('[class*="DetailDescription_BasicDetailSection"], [class*="DetailDescription_EditorContainer"]'))add(section.textContent);
      return facts.slice(0,60);
    }
    const facts=[];const seen=new Set();const pattern=/(상품번호|제조사|브랜드|모델명|품번|원산지|연결방식|전송방식|반응속도|무료배송|상품 가격|키스위치)/;
    for(const node of document.querySelectorAll('li, dt, dd, [class*="product"] div')){
      const value=compact(node.textContent);if(value.length<3||value.length>180||!pattern.test(value)||seen.has(value))continue;
      seen.add(value);facts.push(value);if(facts.length>=30)break;
    }
    return facts;
  }

  async function collectNaverPage(request) {
    const identity=currentNaverIdentity();
    if(!identity||identity.productKey!==request.productKey){const error=new Error('열린 네이버 상품 페이지가 요청한 상품과 일치하지 않습니다.');error.code='PRODUCT_IDENTITY_MISMATCH';throw error;}
    const imageUrls=await waitForNaverImages(request.maxImages);
    const result={productKey:identity.productKey,productTitleRaw:identity.travel?compact(document.querySelector('h1')?.textContent):productTitle(),imageUrls,
      reviews:identity.travel?[]:collectNaverReviews(request.maxReviews),productFacts:collectNaverFacts(),collectedAt:new Date().toISOString()};
    if(byteLength(result)>MAX_MESSAGE_BYTES){const error=new Error('상품 수집 결과가 허용된 메시지 크기를 초과했습니다.');error.code='MESSAGE_TOO_LARGE';throw error;}
    return result;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'COUPANG_COLLECTOR_DIAGNOSTIC') {
      console.warn(`[Threads Auto] 쿠팡 수집기 연결 대기: ${String(message.message || '알 수 없는 오류')}`);
      return false;
    }
    const isNaver=message?.type==='COLLECT_NAVER_BRAND_PRODUCT_PAGE';
    if (message?.type !== 'COLLECT_PRODUCT_PAGE' && !isNaver) return false;
    const valid = message.protocolVersion === PROTOCOL_VERSION
      && typeof message.requestId === 'string'
      && (isNaver ? typeof message.productKey==='string'&&message.productKey.length<=200
        : validIdentifier(message.productId)
          && (!message.itemId || validIdentifier(message.itemId))
          && (!message.vendorItemId || validIdentifier(message.vendorItemId))
          && Boolean(message.itemId || message.vendorItemId))
      && Number.isInteger(message.maxImages) && message.maxImages >= 1 && message.maxImages <= 20
      && Number.isInteger(message.maxReviews) && message.maxReviews >= 0 && message.maxReviews <= 8;
    if (!valid || byteLength(message) > 64 * 1024) {
      sendResponse({
        requestId: message?.requestId,
        ok: false,
        error: { code: 'INVALID_REQUEST', message: '상품 페이지 수집 요청이 올바르지 않습니다.' }
      });
      return false;
    }
    void (isNaver?collectNaverPage(message):collectPage(message)).then((product) => {
      sendResponse({ requestId: message.requestId, ok: true, product });
    }).catch((error) => {
      sendResponse({
        requestId: message.requestId,
        ok: false,
        error: {
          code: error?.code || 'COLLECTION_FAILED',
          message: error instanceof Error ? error.message : '상품 페이지 정보를 수집하지 못했습니다.'
        }
      });
    });
    return true;
  });

  const identity = currentIdentity();
  if (identity) {
    void chrome.runtime.sendMessage({
      type: 'COUPANG_PAGE_READY',
      protocolVersion: PROTOCOL_VERSION,
      productId: identity.productId,
      ...(identity.itemId ? { itemId: identity.itemId } : {}),
      ...(identity.vendorItemId ? { vendorItemId: identity.vendorItemId } : {})
    }).then((response) => {
      if (response?.ok === false && response.error) {
        console.warn(`[Threads Auto] 쿠팡 수집기 연결 대기: ${String(response.error)}`);
      }
    }).catch((error) => {
      console.warn(`[Threads Auto] 쿠팡 수집기 서비스 워커 호출 대기: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  const naverIdentity=currentNaverIdentity();
  if(naverIdentity){
    void chrome.runtime.sendMessage({type:'NAVER_BRAND_PAGE_READY',protocolVersion:PROTOCOL_VERSION,productKey:naverIdentity.productKey}).catch(()=>undefined);
  }
})();
