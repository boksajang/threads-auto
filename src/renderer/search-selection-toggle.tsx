import { useEffect, useRef } from 'react';

export function SearchSelectionToggle({ids,selected,disabled,onChange}:{ids:string[];selected:Set<string>;disabled:boolean;onChange:(checked:boolean)=>void}) {
  const input=useRef<HTMLInputElement>(null);
  const count=ids.filter(id=>selected.has(id)).length;
  const all=ids.length>0&&count===ids.length;
  useEffect(()=>{if(input.current)input.current.indeterminate=count>0&&!all;},[count,all]);
  return <><label className="check search-select-all"><input ref={input} type="checkbox" checked={all} disabled={disabled||!ids.length} onChange={event=>onChange(event.target.checked)}/>검색 결과 전체 선택</label><span className="selection-count" aria-live="polite">{count}/{ids.length}개 선택</span></>;
}
