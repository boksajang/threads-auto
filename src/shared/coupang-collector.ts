export const COUPANG_COLLECTOR_EXTENSION_ID = 'haecnhoaegieddnhookppmcmdahidlal';
export const COUPANG_COLLECTOR_NATIVE_HOST = 'com.threadsauto.coupangcollector';
export const COUPANG_COLLECTOR_PROTOCOL_VERSION = 2;
export const COUPANG_COLLECTOR_ALLOWED_ORIGIN = `chrome-extension://${COUPANG_COLLECTOR_EXTENSION_ID}/`;
export const COUPANG_COLLECTOR_WEB_STORE_URL = `https://chromewebstore.google.com/detail/${COUPANG_COLLECTOR_EXTENSION_ID}`;

export interface ExtensionInstallation {
  directory: string;
  version: string;
}

export interface CoupangCollectorStatus {
  extensionId:string;
  webStoreUrl:string;
  hostRegistered:boolean;
  hostExecutableReady:boolean;
  connected:boolean;
  installed?:boolean;
  everConnected:boolean;
  promptAcknowledged:boolean;
  extensionVersion?:string;
  lastConnectedAt?:string;
  lastError?:string;
  message:string;
}
