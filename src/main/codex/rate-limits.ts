import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { codexProcessEnvironment } from './environment';
import type { CodexUsageStatus } from '../../shared/domain';
import { POLICY } from '../../shared/policy';

interface WindowShape { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null }

export function weeklyUsageFromResponse(response: any, routineTokens = 0): CodexUsageStatus {
  const root = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits ?? response;
  const windows: WindowShape[] = [root?.primary, root?.secondary].filter(Boolean);
  const weekly = windows.find((item) => item.windowDurationMins === POLICY.weeklyWindowMinutes);
  if (!weekly || !Number.isFinite(weekly.usedPercent)) return { routineTokens, available: false };
  const remaining = Math.max(0, Math.min(100, 100 - weekly.usedPercent));
  return {
    routineTokens,
    weeklyRemainingPercent: remaining,
    resetsAt: weekly.resetsAt ? new Date(weekly.resetsAt * 1000).toISOString() : undefined,
    checkedAt: new Date().toISOString(),
    available: true,
  };
}

export class CodexRateLimitClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private routineTokens = 0;
  private status: CodexUsageStatus = { routineTokens: 0, available: false };
  private listeners = new Set<(status: CodexUsageStatus) => void>();

  constructor(private readonly executable: string) {}
  current(): CodexUsageStatus { return this.status; }
  onUpdate(listener: (status: CodexUsageStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  addRoutineTokens(tokens?: number): void { if (tokens !== undefined) this.routineTokens += tokens; this.status = { ...this.status, routineTokens: this.routineTokens }; this.emit(); }
  resetRoutine(): void { this.routineTokens = 0; this.status = { ...this.status, routineTokens: 0 }; this.emit(); }

  private emit(): void { this.listeners.forEach((listener) => listener(this.status)); }
  private send(message: unknown): void { this.child?.stdin.write(`${JSON.stringify(message)}\n`); }

  private disconnect(error: Error): void {
    const child = this.child;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.status = { routineTokens: this.routineTokens, available: false };
    this.emit();
    child?.kill();
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex App Server 응답 시간이 초과되었습니다.')); }, 8_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], { shell: false, windowsHide: true,env:codexProcessEnvironment() });
    this.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')));
    this.child.stderr.on('data', () => { /* pipe backpressure 방지를 위해 소비한다. */ });
    this.child.once('error', (error) => this.disconnect(error));
    this.child.once('close', () => this.disconnect(new Error('Codex App Server 연결이 종료되었습니다.')));
    await this.request('initialize', { clientInfo: { name: 'threads-auto', title: 'Threads Auto', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
    await this.refresh();
  }

  async refresh(): Promise<CodexUsageStatus> {
    try {
      const response = await this.request('account/rateLimits/read', null);
      this.status = weeklyUsageFromResponse(response, this.routineTokens);
    } catch { this.status = { routineTokens: this.routineTokens, available: false }; }
    this.emit();
    return this.status;
  }

  private consume(text: string): void {
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > POLICY.agentOutputMaxBytes) {
      this.buffer = '';
      this.disconnect(new Error('Codex App Server 출력 크기 제한을 초과했습니다.'));
      return;
    }
    const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          const pending = this.pending.get(Number(message.id));
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(Number(message.id));
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
          }
        } else if (message.method === 'account/rateLimits/updated') {
          void this.refresh();
        }
      } catch { /* 비정상 행은 무시하고 다음 구조화 메시지를 기다린다. */ }
    }
  }

  stop(): void { this.child?.stdin.end(); this.child?.kill(); this.child = undefined; }
}
