export type PeriodPreset = 'today' | '7d' | '30d' | 'custom';

export interface PeriodRange {
  from: string;
  to: string;
}

export function toLocalDateInput(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function defaultCustomPeriod(now = new Date()): { from: string; to: string } {
  const from = new Date(now);
  from.setDate(from.getDate() - 6);
  return { from: toLocalDateInput(from), to: toLocalDateInput(now) };
}

export function resolvePeriodRange(
  preset: PeriodPreset,
  customFrom = '',
  customTo = '',
  now = new Date(),
): PeriodRange {
  if (preset === 'custom') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(customFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(customTo)) {
      throw new Error('시작일과 종료일을 모두 선택하세요.');
    }
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59.999`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('올바른 기간을 선택하세요.');
    if (from > to) throw new Error('시작일은 종료일보다 늦을 수 없습니다.');
    return { from: from.toISOString(), to: to.toISOString() };
  }

  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  if (preset === '7d') from.setDate(from.getDate() - 6);
  if (preset === '30d') from.setDate(from.getDate() - 29);
  return { from: from.toISOString(), to: now.toISOString() };
}

export function periodPresetLabel(preset: PeriodPreset): string {
  return ({ today: '오늘', '7d': '최근 7일', '30d': '최근 30일', custom: '설정 기간' } as const)[preset];
}
