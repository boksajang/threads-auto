/* global chrome, console, TextEncoder, URL, setTimeout, clearTimeout */
'use strict';

const NATIVE_HOST_NAME = 'com.threadsauto.coupangcollector';
const PROTOCOL_VERSION = 2;
const MAX_INCOMING_BYTES = 64 * 1024;
const MAX_OUTGOING_BYTES = 512 * 1024;
const PAGE_LOAD_TIMEOUT_MS = 20_000;
const CONTENT_SCRIPT_TIMEOUT_MS = 15_000;
const PRODUCT_URL_PATTERNS = ['https://www.coupang.com/vp/products/*','https://brand.naver.com/*/products/*','https://smartstore.naver.com/*/products/*','https://shopping.naver.com/*','https://pkgtour.naver.com/products/*'];

let nativePort = null;
let nativeReady = false;
let activeRequestId = null;
let connectionGeneration = 0;
let reconnectAttempt = 0;
let reconnectTimer = null;
let lastNativeError = null;
const RECONNECT_DELAYS_MS = [1_000, 3_000, 10_000, 30_000];

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function extensionHello() {
  const manifest = chrome.runtime.getManifest();
  return {
    type: 'HELLO',
    protocolVersion: PROTOCOL_VERSION,
    extensionVersion: manifest.version,
    manifestVersion: manifest.manifest_version,
    capabilities: {
      collectProduct: true,
      collectByAffiliateUrl: true,
      collectNaverBrandConnect: true,
      maxImages: 20,
      maxReviews: 8
    },
    sentAt: new Date().toISOString()
  };
}

function postNative(message, expectedPort = nativePort) {
  if (!expectedPort || nativePort !== expectedPort) return false;
  if (byteLength(message) > MAX_OUTGOING_BYTES) {
    const requestId = typeof message?.requestId === 'string' ? message.requestId : undefined;
    expectedPort.postMessage({
      type: 'COLLECT_PRODUCT_RESULT',
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: 'MESSAGE_TOO_LARGE',
        message: '수집 결과가 허용된 메시지 크기를 초과했습니다.'
      }
    });
    return false;
  }
  expectedPort.postMessage(message);
  return true;
}

function disconnectNativePort(port) {
  if (nativePort !== port) return;
  const errorMessage = chrome.runtime.lastError?.message || 'Native Host 연결이 종료되었습니다.';
  lastNativeError = errorMessage;
  // 앱이 아직 실행되지 않았거나 등록 직후인 상태는 복구 가능한 대기 상태다.
  // console.error는 Chrome 확장 관리 화면에 영구적인 오류 배지를 남기므로
  // 실제 상태는 앱 UI와 상품 탭 진단 메시지로 전달하고 여기서는 경고만 남긴다.
  console.warn(`[Threads Auto] Native Host 연결 대기: ${errorMessage}`);
  chrome.tabs.query({ url: PRODUCT_URL_PATTERNS }, (tabs) => {
    void chrome.runtime.lastError;
    for (const tab of tabs || []) {
      if (!Number.isInteger(tab.id)) continue;
      chrome.tabs.sendMessage(tab.id, {
        type: 'COUPANG_COLLECTOR_DIAGNOSTIC',
        message: `${NATIVE_HOST_NAME}: ${errorMessage}`
      }).catch(() => undefined);
    }
  });
  nativePort = null;
  nativeReady = false;
  scheduleReconnect();
}

function scheduleReconnect() {
  if (nativePort || reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt = Math.min(reconnectAttempt + 1, RECONNECT_DELAYS_MS.length - 1);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureNativePort();
  }, delay);
}

function resetConnectionCycle() {
  reconnectAttempt = 0;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function ensureNativePort() {
  if (nativePort) return nativePort;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    nativeReady = false;
    connectionGeneration += 1;
    const portGeneration = connectionGeneration;
    port.onMessage.addListener((message) => {
      if (message?.type === 'HELLO_ACK' && message.protocolVersion === PROTOCOL_VERSION) {
        nativeReady = true;
        lastNativeError = null;
        resetConnectionCycle();
        postNative({ type: 'READY', protocolVersion: PROTOCOL_VERSION, sentAt: new Date().toISOString() }, port);
        return;
      }
      void handleNativeMessage(message, port, portGeneration);
    });
    port.onDisconnect.addListener(() => disconnectNativePort(port));
    postNative(extensionHello());
    return port;
  } catch (error) {
    lastNativeError = error instanceof Error ? error.message : String(error);
    nativePort = null;
    return null;
  }
}

function fail(requestId, code, message, detail, expectedPort = nativePort) {
  postNative({
    type: 'COLLECT_PRODUCT_RESULT',
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code,
      message,
      ...(detail ? { detail: String(detail).slice(0, 1_000) } : {})
    }
  }, expectedPort);
}

function progress(requestId, stage, expectedPort = nativePort) {
  postNative({
    type: 'COLLECT_PRODUCT_PROGRESS',
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    stage,
    sentAt: new Date().toISOString()
  }, expectedPort);
}

function validIdentifier(value) {
  return typeof value === 'string' && /^\d{1,32}$/.test(value);
}

function validRequestId(value) {
  return typeof value === 'string'
    && value.length >= 16
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function validAffiliateUrl(value, provider = 'COUPANG') {
  if (typeof value !== 'string' || value.length > 2_000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username && !url.password && !url.port
      && (provider === 'NAVER_BRAND_CONNECT'
        ? url.hostname === 'naver.me' && url.pathname.length > 1
        : url.hostname === 'link.coupang.com' || url.hostname === 'coupa.ng');
  } catch {
    return false;
  }
}

function parseNaverProductLocation(value) {
  try {
    const url = new URL(value);
    if(url.protocol==='https:'&&url.hostname==='pkgtour.naver.com'){
      const travel=/^\/products\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
      return travel?{productKey:`${url.hostname}:${travel[1]}:${travel[2]}`,url}:null;
    }
    if (url.protocol !== 'https:' || !['brand.naver.com','smartstore.naver.com','shopping.naver.com'].includes(url.hostname)) return null;
    const match = /\/products\/(\d+)/.exec(url.pathname);
    if (!match) return null;
    return { productKey: `${url.hostname}:${match[1]}`, url };
  } catch {
    return null;
  }
}

function parseProductLocation(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.coupang.com') return null;
    const match = /^\/vp\/products\/(\d+)\/?$/.exec(url.pathname);
    const itemId = url.searchParams.get('itemId');
    const vendorItemId = url.searchParams.get('vendorItemId');
    if (!match || (itemId && !validIdentifier(itemId)) || (vendorItemId && !validIdentifier(vendorItemId))) return null;
    if (!itemId && !vendorItemId) return null;
    return { productId: match[1], ...(itemId ? { itemId } : {}), ...(vendorItemId ? { vendorItemId } : {}), url };
  } catch {
    return null;
  }
}

async function waitForProductDestination(tabId, timeoutMs, requestId, requestPort, provider) {
  const deadline = Date.now() + timeoutMs;
  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      const error = new Error('상품 페이지가 수집 전에 닫혔습니다.');
      error.code = 'PRODUCT_TAB_CLOSED';
      throw error;
    }
    const location = provider === 'NAVER_BRAND_CONNECT' ? parseNaverProductLocation(tab.url ?? '') : parseProductLocation(tab.url ?? '');
    if (tab.status === 'complete' && location) return tab;
    if (Date.now() - lastProgressAt >= 2_000) {
      progress(requestId, location ? 'PRODUCT_PAGE_LOADING' : 'AFFILIATE_REDIRECT', requestPort);
      lastProgressAt = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const error = new Error(`제휴 링크가 제한 시간 안에 ${provider === 'NAVER_BRAND_CONNECT' ? '네이버' : '쿠팡'} 상품 페이지로 이동하지 않았습니다.`);
  error.code = 'PRODUCT_REDIRECT_TIMEOUT';
  throw error;
}

async function sendCollectionRequest(tabId, payload, requestPort) {
  const deadline = Date.now() + CONTENT_SCRIPT_TIMEOUT_MS;
  let lastError;
  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      lastError = error;
      if (Date.now() - lastProgressAt >= 2_000) {
        progress(payload.requestId, 'CONTENT_SCRIPT_WAIT', requestPort);
        lastProgressAt = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('상품 수집 스크립트를 실행하지 못했습니다.');
}

async function collectProduct(request, requestPort, requestGeneration) {
  const { requestId, sourceUrl, provider = 'COUPANG' } = request;
  progress(requestId, 'OPENING_AFFILIATE_LINK', requestPort);
  // 쿠팡 후기 영역은 비활성 탭에서 생성이 지연되거나 생략될 수 있다.
  // 수집 중인 탭만 활성화해 실제 브라우저 렌더링 경로로 이미지와 후기를 함께 확보한다.
  let tab = await chrome.tabs.create({ url: sourceUrl, active: true });
  if (typeof tab.id !== 'number') throw new Error('상품 페이지 탭을 확인하지 못했습니다.');
  try {
    tab = await waitForProductDestination(tab.id, PAGE_LOAD_TIMEOUT_MS, requestId, requestPort, provider);
    const finalLocation = provider === 'NAVER_BRAND_CONNECT' ? parseNaverProductLocation(tab.url ?? '') : parseProductLocation(tab.url ?? '');
    if (!finalLocation) {
      const error = new Error(`제휴 링크가 유효한 ${provider === 'NAVER_BRAND_CONNECT' ? '네이버' : '쿠팡'} 상품 페이지로 이동하지 않았습니다.`);
      error.code = 'PRODUCT_DESTINATION_INVALID';
      throw error;
    }
    progress(requestId, 'COLLECTING_PRODUCT_PAGE', requestPort);
    const response = await sendCollectionRequest(tab.id, {
      type: provider === 'NAVER_BRAND_CONNECT' ? 'COLLECT_NAVER_BRAND_PRODUCT_PAGE' : 'COLLECT_PRODUCT_PAGE', protocolVersion: PROTOCOL_VERSION, requestId,
      ...(finalLocation.productId ? { productId: finalLocation.productId } : {}),
      ...(finalLocation.productKey ? { productKey: finalLocation.productKey } : {}),
      ...(finalLocation.itemId ? { itemId: finalLocation.itemId } : {}),
      ...(finalLocation.vendorItemId ? { vendorItemId: finalLocation.vendorItemId } : {}),
      maxImages: 20, maxReviews: 8
    }, requestPort);
    if (!response || response.requestId !== requestId) {
      const error = new Error('상품 페이지 수집 응답의 요청 식별값이 일치하지 않습니다.');
      error.code = 'RESPONSE_IDENTITY_MISMATCH';
      throw error;
    }
    if (!response.ok) {
      const error = new Error(response.error?.message || '상품 페이지 정보를 수집하지 못했습니다.');
      error.code = response.error?.code || 'COLLECTION_FAILED';
      throw error;
    }
    if (nativePort !== requestPort || connectionGeneration !== requestGeneration || !nativeReady) {
      throw Object.assign(new Error('쿠팡 수집기 연결이 수집 도중 다시 설정되었습니다. 다시 시도하세요.'), { code: 'COLLECTOR_RECONNECTED' });
    }
    postNative({
      type: 'COLLECT_PRODUCT_RESULT', protocolVersion: PROTOCOL_VERSION, requestId, ok: true,
      product: {...response.product,finalUrl:finalLocation.url.toString(),...(finalLocation.productId?{productId:finalLocation.productId}:{}),
        ...(finalLocation.productKey?{productKey:finalLocation.productKey}:{}),
        ...(finalLocation.itemId?{itemId:finalLocation.itemId}:{}),
        ...(finalLocation.vendorItemId?{vendorItemId:finalLocation.vendorItemId}:{})}
    }, requestPort);
  } finally {
    if (typeof tab.id === 'number') await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function handleNativeMessage(message, requestPort, requestGeneration) {
  if (byteLength(message) > MAX_INCOMING_BYTES) {
    fail(undefined, 'MESSAGE_TOO_LARGE', 'Native Host 요청이 허용된 메시지 크기를 초과했습니다.');
    return;
  }
  if (!message || message.type !== 'COLLECT_PRODUCT') return;
  const { requestId, sourceUrl, protocolVersion } = message;
  const provider = message.provider === 'NAVER_BRAND_CONNECT' ? 'NAVER_BRAND_CONNECT' : 'COUPANG';
  if (protocolVersion !== PROTOCOL_VERSION) {
    fail(requestId, 'PROTOCOL_MISMATCH', 'Threads Auto와 확장 프로그램의 통신 버전이 일치하지 않습니다.');
    return;
  }
  if (!validRequestId(requestId)) {
    fail(requestId, 'INVALID_REQUEST_ID', 'Threads Auto의 상품 수집 요청 식별값이 올바르지 않습니다.');
    return;
  }
  if (!validAffiliateUrl(sourceUrl, provider)) {
    fail(requestId, 'INVALID_PRODUCT_LINK', provider === 'NAVER_BRAND_CONNECT' ? '네이버 브랜드 커넥트에서 발급한 naver.me 상품 링크가 올바르지 않습니다.' : '쿠팡 파트너스 상품 링크가 올바르지 않습니다.');
    return;
  }
  if (activeRequestId) {
    fail(requestId, 'COLLECTOR_BUSY', '다른 쇼핑 상품을 수집하고 있습니다. 잠시 후 다시 시도하세요.');
    return;
  }
  activeRequestId = requestId;
  try {
    await collectProduct({ requestId, sourceUrl, provider }, requestPort, requestGeneration);
  } catch (error) {
    fail(requestId, error?.code || 'COLLECTION_FAILED', error instanceof Error ? error.message : '상품 정보를 수집하지 못했습니다.', undefined, requestPort);
  } finally {
    activeRequestId = null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  resetConnectionCycle();
  ensureNativePort();
});

chrome.runtime.onStartup.addListener(() => {
  resetConnectionCycle();
  ensureNativePort();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'COUPANG_PAGE_READY' && message?.type !== 'NAVER_BRAND_PAGE_READY') return false;
  if (!nativePort) resetConnectionCycle();
  ensureNativePort();
  sendResponse({ ok: nativeReady, ...(lastNativeError ? { error: lastNativeError } : {}) });
  return false;
});

// MV3 서비스 워커가 확장 새로고침이나 유휴 상태 해제 때문에 새로 로드된 경우에도
// onInstalled/onStartup 이벤트 없이 실행될 수 있다. 로드 즉시 Native Host와 연결해
// 앱의 수집기 상태가 별도 페이지 새로고침 없이 갱신되도록 한다.
ensureNativePort();
