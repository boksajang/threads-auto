export const POLICY = {
  databaseFileName: 'threads-auto.db',
  configFileName: 'config.json',
  credentialsFileName: 'credentials.json',
  jobMaxAttempts: 3,
  retryBaseMs: 5_000,
  agentOutputMaxBytes: 512_000,
  agentTimeoutSeconds: 180,
  blogCandidateMaxAgeDays: 90,
  weeklyWindowMinutes: 10_080,
  coupangDisclosure: '이 게시물은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.',
  externalProtocols: new Set(['https:']),
  threadsTextLimit: 500,
} as const;

export const CODEX_MODEL_OPTIONS = [
  { label: 'Default', value: 'Default' },
  { label: 'GPT-5.6 Sol', value: 'gpt-5.6-sol' },
  { label: 'GPT-5.6 Terra', value: 'gpt-5.6-terra' },
  { label: 'GPT-5.6 Luna', value: 'gpt-5.6-luna' },
  { label: 'GPT-5.5', value: 'gpt-5.5' },
  { label: 'GPT-5.4', value: 'gpt-5.4' },
] as const;

export const REASONING_OPTIONS = [
  { label: '낮음', value: 'low' },
  { label: '보통', value: 'medium' },
  { label: '높음', value: 'high' },
  { label: '매우 높음', value: 'xhigh' },
] as const;

export const DEFAULT_SETTINGS = {
  codex: { model: 'Default', reasoningEffort: 'medium', timeoutSeconds: POLICY.agentTimeoutSeconds },
  schedulerEnabled: false,
  launchAtStartup: false,
} as const;
