import { ProviderRequestError } from './contracts';

export function isThreadsRemoteObjectMissing(error:unknown):boolean {
  let current:unknown=error;
  for(let depth=0;depth<5&&current instanceof Error;depth+=1){
    if(current instanceof ProviderRequestError&&current.status===404)return true;
    if(current instanceof ProviderRequestError&&current.status===400&&/\bcode 100\b/i.test(current.message)
      &&(/\bsubcode 33\b/i.test(current.message)||/unsupported get request|does not exist|cannot be loaded/i.test(current.message)))return true;
    current=current.cause;
  }
  return false;
}
