import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentResult, AgentRole, CodexHealth, CodexSettings } from '../../shared/domain';
import { POLICY } from '../../shared/policy';
import { agentResultJsonSchema, agentResultSchema } from './schemas';
import { codexProcessEnvironment } from './environment';

const execFileAsync = promisify(execFile);

export async function findPosixCodexExecutable(env:NodeJS.ProcessEnv=process.env,home=os.homedir()):Promise<string>{
  const directories=[...(env.PATH??'').split(path.delimiter),path.join(home,'.local','bin'),'/opt/homebrew/bin','/usr/local/bin'];
  for(const directory of new Set(directories.filter(Boolean))){
    const candidate=path.join(directory,'codex');
    try{if(!(await fs.stat(candidate)).isFile())continue;await fs.access(candidate,constants.X_OK);return candidate;}
    catch(error){if(!['ENOENT','ENOTDIR','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }
  throw Object.assign(new Error('Codex CLI가 설치되어 있지 않습니다. PATH와 표준 설치 위치를 자동 탐색했지만 실행 파일이 없습니다.'),{code:'ENOENT'});
}

export async function findWindowsCodexExecutable(env:NodeJS.ProcessEnv=process.env,arch:string=process.arch):Promise<string> {
  const exists=async(file:string)=>{try{return (await fs.stat(file)).isFile();}catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}};
  const directories=(env.PATH??env.Path??'').split(path.delimiter).map(entry=>entry.trim().replace(/^"(.*)"$/,'$1')).filter(Boolean);
  if(env.APPDATA)directories.push(path.join(env.APPDATA,'npm'));
  for(const directory of directories){const candidate=path.join(directory,'codex.exe');if(await exists(candidate))return candidate;}
  if(env.APPDATA){
    const target=arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc';
    const candidate=path.join(env.APPDATA,'npm','node_modules','@openai','codex','node_modules','@openai',`codex-win32-${arch==='arm64'?'arm64':'x64'}`,'vendor',target,'bin','codex.exe');
    if(await exists(candidate))return candidate;
  }
  // 데스크톱 업데이트로 버전 폴더가 바뀌어도 오래된 사용자 PATH에 의존하지 않는다.
  if(env.LOCALAPPDATA){
    const root=path.join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
    if(await exists(path.join(root,'codex.exe')))return path.join(root,'codex.exe');
    const entries=await fs.readdir(root,{withFileTypes:true}).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;});
    const candidates:Array<{file:string;modified:number}>=[];
    for(const entry of entries.filter(entry=>entry.isDirectory())){
      const file=path.join(root,entry.name,'codex.exe');
      if(await exists(file))candidates.push({file,modified:(await fs.stat(file)).mtimeMs});
    }
    candidates.sort((a,b)=>b.modified-a.modified||a.file.localeCompare(b.file));
    if(candidates[0])return candidates[0].file;
  }
  throw Object.assign(new Error('Codex CLI가 설치되어 있지 않습니다. PATH와 표준 설치 위치를 자동 탐색했지만 실행 파일이 없습니다.'),{code:'ENOENT'});
}

export interface AgentInvocation {
  role: AgentRole;
  prompt: string;
  settings: CodexSettings;
  webSearch?: boolean;
}

export interface AgentInvocationResult {
  result: AgentResult;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export class CodexRunner {
  private executable?: string;
  private readonly schemaPath: string;
  private readonly activeChildren = new Set<ChildProcessWithoutNullStreams>();

  constructor(private readonly workDirectory: string, dataDirectory: string) {
    this.schemaPath = path.join(dataDirectory, 'agent-result.schema.json');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.workDirectory, { recursive: true });
    await fs.writeFile(this.schemaPath, JSON.stringify(agentResultJsonSchema), 'utf8');
    this.executable = await this.resolveExecutable();
  }

  async executablePath(): Promise<string> {
    if(this.executable){
      try{await fs.access(this.executable);return this.executable;}catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;this.executable=undefined;}
    }
    this.executable=await this.resolveExecutable();return this.executable;
  }

  private async resolveExecutable(): Promise<string> {
    if (process.platform === 'win32') return findWindowsCodexExecutable();
    return findPosixCodexExecutable();
  }

  async health(): Promise<CodexHealth> {
    let executable:string;
    try{executable=await this.executablePath();}catch(error){
      const missing=(error as NodeJS.ErrnoException).code==='ENOENT';
      return {installed:false,failure:missing?'NOT_FOUND':'EXECUTION_FAILED',message:missing?'Codex CLI가 설치되어 있지 않습니다. PATH와 표준 설치 위치를 자동 탐색했지만 실행 파일이 없습니다.':`Codex CLI 자동 탐색 실패: ${(error as Error).message}`};
    }
    try {
      const versionResult = await execFileAsync(executable, ['--version'], { windowsHide: true,timeout:10_000,maxBuffer:64*1024,env:codexProcessEnvironment() });
      return { installed: true, version: versionResult.stdout.trim(), message: 'Codex CLI가 설치되어 있습니다.' };
    } catch(error) {
      return { installed: false,failure:'EXECUTION_FAILED',message:`Codex CLI는 발견했지만 실행 확인에 실패했습니다 (${(error as NodeJS.ErrnoException).code??'시간 초과 또는 실행 오류'}).` };
    }
  }

  private killChild(child: ChildProcessWithoutNullStreams): void {
    try {
      if (process.platform === 'win32' && child.pid) execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide:true, timeout:3_000, stdio:'ignore' });
      else child.kill('SIGKILL');
    } catch { child.kill('SIGKILL'); }
    this.activeChildren.delete(child);
  }

  cancelAll(): number {
    const children = [...this.activeChildren];
    children.forEach((child) => this.killChild(child));
    return children.length;
  }

  async run(invocation: AgentInvocation): Promise<AgentInvocationResult> {
    const executable = await this.executablePath();
    const args = [
      ...(invocation.webSearch ? ['--search'] : []), 'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'read-only', '--skip-git-repo-check',
      '-c', 'approval_policy="never"', '-c', `model_reasoning_effort="${invocation.settings.reasoningEffort}"`,
      '-c', `web_search="${invocation.webSearch ? 'live' : 'disabled'}"`,
      '--output-schema', this.schemaPath, '--color', 'never', '-C', this.workDirectory,
    ];
    if (invocation.settings.model !== 'Default') args.push('--model', invocation.settings.model);
    args.push('-');

    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],env:codexProcessEnvironment() });
      this.activeChildren.add(child);
      let stdout = '';
      let stderr = '';
      let finalText = '';
      let failureMessage = '';
      let usage: { input?: number; output?: number } = {};
      let buffer = '';
      let settled = false;

      const finishError = (error: Error, kill = false) => {
        if (!settled) { settled = true; clearTimeout(timer); if (kill) this.killChild(child); else this.activeChildren.delete(child); reject(error); }
      };
      const timer = setTimeout(() => finishError(new Error('Codex Agent 실행 시간이 초과되었습니다.'), true), invocation.settings.timeoutSeconds * 1000);

      const parseLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') finalText = event.item.text ?? finalText;
          if (event.type === 'error' && typeof event.message === 'string') failureMessage = event.message.slice(0, 4_000);
          if (event.type === 'turn.failed' && typeof event.error?.message === 'string') failureMessage = event.error.message.slice(0, 4_000);
          if (event.type === 'turn.completed' && event.usage) {
            usage = {
              input: Number(event.usage.input_tokens ?? event.usage.inputTokens ?? 0),
              output: Number(event.usage.output_tokens ?? event.usage.outputTokens ?? 0),
            };
          }
        } catch { /* 알 수 없는 JSONL 행은 최종 Schema 결과에 영향을 주지 않는다. */ }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout) > POLICY.agentOutputMaxBytes) return finishError(new Error('Codex 출력 크기 제한을 초과했습니다.'), true);
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
        lines.forEach(parseLine);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-32_000); });
      child.on('error', (error) => finishError(new Error(`Codex 실행 실패: ${error.message}`)));
      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        if (settled) return;
        parseLine(buffer);
        if (code !== 0) return finishError(new Error(`Codex Agent 실행 실패 (${code}): ${failureMessage || stderr.trim() || '상세 정보 없음'}`));
        try {
          const parsed = agentResultSchema.parse(JSON.parse(finalText));
          settled = true;
          resolve({ result: parsed, inputTokens: usage.input, outputTokens: usage.output,
            totalTokens: usage.input === undefined || usage.output === undefined ? undefined : usage.input + usage.output });
        } catch (error) { finishError(new Error(`Codex 구조화 결과 검증 실패: ${String(error)}`)); }
      });
      child.stdin.end(`[역할: ${invocation.role}]\n${invocation.prompt}`);
    });
  }
}
