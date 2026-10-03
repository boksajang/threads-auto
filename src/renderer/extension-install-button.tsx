import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CoupangCollectorStatus, ExtensionInstallation } from '../shared/coupang-collector';
import { useDialogKeyboard } from './use-dialog-keyboard';

export function ExtensionInstallButton() {
  const [status,setStatus]=useState<CoupangCollectorStatus>();
  const [open,setOpen]=useState(false);
  const [checking,setChecking]=useState(true);
  useEffect(()=>{
    let active=true;
    let request=0;
    const refresh=()=>{const current=++request;void window.threadsAuto.coupangCollector.status().then(value=>{if(active&&current===request)setStatus(value);}).catch(()=>{/* Preserve confirmed status after temporary lookup failures. */}).finally(()=>{if(active&&current===request)setChecking(false);});};
    refresh();
    const off=window.threadsAuto.coupangCollector.onStatus(refresh);
    const timer=window.setInterval(refresh,10000);
    window.addEventListener('focus',refresh);
    return()=>{active=false;off();window.clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[]);
  const installed=Boolean(status?.installed||status?.connected);
  return <>
    <button className={`extension-install-button${installed?' installed':''}`} disabled={checking} onClick={()=>setOpen(true)} title="확장프로그램 설치 방법 및 업데이트 안내">
      <span aria-hidden="true">{installed?'✓':'↧'}</span>{checking?'확장프로그램 확인 중…':installed?'확장프로그램 설치됨':'확장프로그램 설치'}
    </button>
    {open&&<ExtensionInstallGuide status={status} onClose={()=>setOpen(false)}/>}
  </>;
}

export function ExtensionInstallGuide({status,onClose}:{status?:CoupangCollectorStatus;onClose:()=>void}) {
  const ref=useRef<HTMLElement>(null);useDialogKeyboard(ref,onClose);
  const [mode,setMode]=useState<'developer'|'store'>('developer');
  const [installation,setInstallation]=useState<ExtensionInstallation>();
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  useEffect(()=>{
    let active=true;
    void window.threadsAuto.coupangCollector.installation().then(value=>{if(active)setInstallation(value);}).catch(()=>{if(active)setError('확장 파일을 준비하지 못했습니다. 앱을 다시 설치한 뒤 안내를 열어 주세요.');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[]);
  const act=async(action:()=>Promise<unknown>,message:string)=>{
    setBusy(true);setError('');setNotice('');
    try{await action();setNotice(message);}catch{setError('작업을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');}finally{setBusy(false);}
  };
  return createPortal(<div className="modal-backdrop extension-install-guide"><section ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby="extension-install-title">
    <header><div><h2 id="extension-install-title">Chrome 확장프로그램 설치</h2><p>설치 방법을 선택하세요. 현재 앱과 함께 제공된 버전은 개발자 모드로 설치할 수 있습니다.</p></div><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}>×</button></header>
    <div className="modal-body stack">
      <div className="extension-mode-options" role="group" aria-label="설치 방법">
        <button type="button" aria-pressed={mode==='developer'} onClick={()=>{setMode('developer');setNotice('');}}><strong>개발자 모드 설치 · 권장</strong><span>앱에 포함된 확장 파일로 바로 설치</span></button>
        <button type="button" aria-pressed={mode==='store'} onClick={()=>{setMode('store');setNotice('');}}><strong>웹스토어 설치</strong><span>스토어에 공개된 버전 설치</span></button>
      </div>
      {installation&&<p className="extension-version">제공 버전 <strong>{installation.version}</strong>{status?.connected&&status.extensionVersion&&<> · 현재 연결 버전 <strong>{status.extensionVersion}</strong></>}</p>}
      {mode==='developer'?<>
        <label className="field"><span>Chrome에서 선택할 확장 폴더</span><textarea className="extension-folder-path" readOnly rows={2} value={installation?.directory??(loading?'확장 파일을 준비하고 있습니다…':'경로를 확인할 수 없습니다.')} onFocus={event=>event.currentTarget.select()}/></label>
        <div className="actions"><button type="button" className="primary" disabled={busy||!installation} onClick={()=>void act(()=>window.threadsAuto.coupangCollector.openFolder(),'확장 폴더를 열었습니다.')}>폴더 열기</button><button type="button" disabled={busy||!installation} onClick={()=>void act(()=>navigator.clipboard.writeText(installation!.directory),'폴더 경로를 복사했습니다.')}>경로 복사</button></div>
        <ol className="extension-install-steps"><li>Chrome 주소창에 <code>chrome://extensions</code>를 입력합니다.</li><li>오른쪽 위 <strong>개발자 모드</strong>를 켭니다.</li><li><strong>압축해제된 확장 프로그램을 로드합니다</strong>를 누르고 위 폴더를 선택합니다. <code>manifest.json</code>이 있는 폴더이며, ZIP 파일이나 상위 폴더를 선택하면 안 됩니다.</li><li>Chrome과 앱을 실행한 상태에서 상품 페이지를 새로고침하고 수집을 시작합니다.</li></ol>
        <p>경로를 직접 입력할 때 Windows는 폴더 선택창의 주소 표시줄, macOS는 <strong>⌘⇧G</strong>(폴더로 이동)를 사용하세요.</p>
        <p>같은 확장이 웹스토어 버전으로 설치되어 있다면 먼저 제거한 뒤 진행하세요. 이후 앱을 업데이트하면 이 안내를 한 번 열고 Chrome 확장 관리 화면에서 해당 확장의 <strong>새로고침</strong>을 누르세요. 위 폴더는 삭제하거나 이동하지 마세요.</p>
      </>:<>
        <p>스토어 심사·게시 일정에 따라 공개 버전이 앱에 포함된 버전보다 낮을 수 있습니다. 스토어의 버전을 확인하고, 낮으면 <strong>개발자 모드 설치</strong>를 선택하세요.</p>
        <ol className="extension-install-steps"><li>아래 버튼으로 스토어 페이지를 엽니다. 다른 브라우저에서 열리면 주소를 Chrome으로 복사하세요.</li><li>버전을 확인한 뒤 <strong>Chrome에 추가 → 확장 프로그램 추가</strong>를 누릅니다.</li><li>Chrome과 앱을 함께 실행하고 상품 페이지를 새로고침합니다.</li></ol>
        <p>개발자 모드 버전에서 전환한다면 기존 확장을 먼저 제거하세요.</p>
        <div className="actions"><button type="button" disabled={busy} onClick={()=>void act(()=>window.threadsAuto.coupangCollector.openStore(),'스토어 페이지를 열었습니다. Chrome에서 설치를 완료하세요.')}>웹스토어 열기</button></div>
      </>}
      {error&&<p className="alert" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    </div><footer><button type="button" className="primary" onClick={onClose}>닫기</button></footer>
  </section></div>,document.body);
}
