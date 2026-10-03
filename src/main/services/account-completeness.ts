import type { AccountInput } from '../../shared/domain';

const requiredProfileFields: Array<{ key: keyof Pick<AccountInput, 'name' | 'threadsHandle' | 'topic'>; label: string }> = [
  { key: 'name', label: '계정명' },
  { key: 'threadsHandle', label: 'Threads 계정' },
  { key: 'topic', label: '주제' },
];

export function normalizeAccountDefaults<T extends AccountInput>(input: T): T {
  return {
    ...input,
    personality:input.personality.trim() || '[표준]',
    tone:input.tone.trim() || '[표준]',
  };
}

export function resolveAccountStyle(input: Pick<AccountInput, 'personality' | 'tone'>): { personality:string; tone:string } {
  const personality = input.personality.trim();
  const tone = input.tone.trim();
  return {
    personality:!personality || personality === '[표준]' ? '일반적이고 균형 잡힌 성격' : personality,
    tone:!tone || tone === '[표준]' ? '정중하고 자연스러운 말투' : tone,
  };
}

export function missingAccountRequirements(input: AccountInput, hasThreadsToken: boolean): string[] {
  const missing = requiredProfileFields
    .filter(({ key }) => !String(input[key] ?? '').trim())
    .map(({ label }) => label);
  if (!input.dailyEnabled && !input.promotionEnabled) missing.push('콘텐츠 모드');
  if (!hasThreadsToken) missing.push('Threads Access Token');
  return missing;
}

export function assertCompleteAccount(input: AccountInput, hasThreadsToken: boolean): void {
  const missing = missingAccountRequirements(input, hasThreadsToken);
  if (missing.length) throw new Error(`계정 저장에 필요한 항목을 입력하세요: ${missing.join(', ')}`);
}
