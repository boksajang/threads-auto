import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CoupangCollectorStatus } from '../shared/coupang-collector';
import { useDialogKeyboard } from './use-dialog-keyboard';

export function ExtensionInstallButton() {
  const [status,setStatus]=useState<CoupangCollectorStatus>();
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [checking,setChecking]=useState(true);
  useEffect(()=>{
    let active=true;
    let request=0;
    const refresh=()=>{const current=++request;void window.threadsAuto.coupangCollector.status().then(value=>{if(active&&current===request)setStatus(value);}).catch(()=>{/* 일시 조회 실패로 확인된 설치 상태를 지우지 않는다. */}).finally(()=>{if(active&&current===request)setChecking(false);});};
    refresh();
    const off=window.threadsAuto.coupangCollector.onStatus(refresh);
    const timer=window.setInterval(refresh,10000);
    window.addEventListener('focus',refresh);
    return()=>{active=false;off();window.clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[]);
  const installed=Boolean(status?.installed||status?.connected);
  const install=async()=>{
    if(installed||checking||busy)return;
    setOpen(true);setBusy(true);setError('');
    try{await window.threadsAuto.coupangCollector.openStore();}
    catch{setError('설치 페이지를 열지 못했습니다. 아래 버튼으로 다시 시도해 주세요.');}
    finally{setBusy(false);}
  };
  return <>
    {installed?<div className="extension-install-button installed" role="status" aria-label="확장프로그램 설치됨"><span aria-hidden="true">✓</span>확장프로그램 설치됨</div>:<button className="extension-install-button" disabled={checking||busy} onClick={()=>void install()} title={checking?'설치 상태를 확인 중입니다.':'Chrome 웹 스토어에서 설치'}>
      <span aria-hidden="true">↧</span>{checking?'확장프로그램 확인 중…':'확장프로그램 설치'}
    </button>}
    {open&&createPortal(<InstallGuide installed={installed} busy={busy} error={error} onClose={()=>setOpen(false)} onInstall={()=>void install()}/>,document.body)}
  </>;
}

function InstallGuide({installed,busy,error,onClose,onInstall}:{installed:boolean;busy:boolean;error:string;onClose:()=>void;onInstall:()=>void}) {
  const ref=useRef<HTMLElement>(null);useDialogKeyboard(ref,onClose);
  return <div className="modal-backdrop extension-install-guide"><section ref={ref} className="modal small" role="dialog" aria-modal="true" aria-labelledby="extension-install-title">
    <header><h2 id="extension-install-title">{installed?'설치가 확인되었습니다':'Chrome 확장프로그램 설치'}</h2><button className="icon-button" aria-label="닫기" onClick={onClose}>×</button></header>
    <div className="modal-body stack">{installed?<p>Chrome을 실행한 상태에서 앱의 상품 수집 기능을 사용하세요.</p>:<>
      <p>Chrome에서는 사용자 확인이 필요해 앱이 자동으로 설치할 수 없습니다.</p>
      <ol><li>열린 스토어 페이지를 <strong>Chrome</strong>에서 확인하세요.</li><li><strong>Chrome에 추가 → 확장 프로그램 추가</strong>를 누르세요.</li><li>앱으로 돌아오면 설치 여부를 자동으로 다시 확인합니다.</li></ol>
      <p>다른 브라우저에서 열렸다면 페이지 주소를 Chrome에 붙여넣으세요. 이미 설치했다면 확장프로그램을 설치한 Chrome 프로필을 실행하세요.</p>
    </>}{error&&<p role="alert">{error}</p>}</div>
    <footer>{!installed&&<button disabled={busy} onClick={onInstall}>{busy?'스토어 여는 중…':'설치 페이지 다시 열기'}</button>}<button className="primary" onClick={onClose}>확인</button></footer>
  </section></div>;
}
