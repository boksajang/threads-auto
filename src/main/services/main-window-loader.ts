export interface MainRendererWindowLike {
  loadURL(url:string):Promise<unknown>;
  webContents:{executeJavaScript<T=unknown>(code:string,userGesture?:boolean):Promise<T>};
}

export interface MainWindowLoadOptions {
  attempts?:number;
  mountChecks?:number;
  mountCheckIntervalMs?:number;
  wait?:(milliseconds:number)=>Promise<void>;
}

/**
 * 개발 서버가 HTML만 먼저 응답하거나 렌더러 모듈 준비가 늦는 경우에도 빈 창을
 * 노출하지 않는다. React가 #root에 실제로 마운트됐을 때만 성공으로 간주한다.
 */
export async function loadMainRenderer(
  window:MainRendererWindowLike,
  url:string,
  options:MainWindowLoadOptions={},
):Promise<void> {
  const attempts=Math.max(1,Math.min(4,Math.trunc(options.attempts??3)));
  const mountChecks=Math.max(1,Math.min(40,Math.trunc(options.mountChecks??20)));
  const interval=Math.max(25,Math.min(1_000,Math.trunc(options.mountCheckIntervalMs??150)));
  const wait=options.wait??((milliseconds:number)=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds)));
  let lastError:unknown;
  for(let attempt=1;attempt<=attempts;attempt+=1) {
    try {
      await window.loadURL(url);
      for(let check=0;check<mountChecks;check+=1) {
        const mounted=await window.webContents.executeJavaScript<boolean>(
          `Boolean(document.getElementById('root')?.childElementCount)`,false,
        );
        if(mounted)return;
        await wait(interval);
      }
      lastError=new Error('렌더러가 #root에 화면을 마운트하지 못했습니다.');
    } catch(error) { lastError=error; }
    if(attempt<attempts)await wait(interval*attempt*2);
  }
  throw new Error(`Threads Auto 화면을 ${attempts}회 불러왔지만 준비되지 않았습니다.`,{cause:lastError});
}
