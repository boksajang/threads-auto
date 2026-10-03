
export function AutomationScheduleButton({
  running,
  busy,
  onToggle,
}: {
  running: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void | Promise<void>;
}) {
  return <button
    type="button"
    className={`scheduler-toggle ${running?'danger-link':'primary'}`}
    disabled={busy}
    aria-pressed={running}
    onClick={()=>void onToggle(!running)}
  >
    {busy?'스케줄 처리 중…':running?'전체 계정 자동화 스케줄 중지':'전체 계정 자동화 스케줄 시작'}
  </button>;
}
