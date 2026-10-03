import type { AppSettings } from '../../shared/domain';

type StartupSettings={read:()=>Promise<AppSettings>;save:(settings:AppSettings)=>Promise<void>};
type StartupScheduler={stopAndClearSchedules:()=>Promise<number>};

/** 앱을 다시 열었다는 이유만으로 자동 발행이 재개되지 않도록 시작 상태를 고정한다. */
export async function enforceStoppedAutomationOnStartup(settings:StartupSettings,scheduler:StartupScheduler):Promise<{settingsChanged:boolean;cancelled:number}> {
  const current=await settings.read();
  const settingsChanged=current.schedulerEnabled;
  if(settingsChanged)await settings.save({...current,schedulerEnabled:false});
  const cancelled=await scheduler.stopAndClearSchedules();
  return {settingsChanged,cancelled};
}
