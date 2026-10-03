import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { AppSettings, CredentialKey } from '../../shared/domain';
import { DEFAULT_SETTINGS, POLICY } from '../../shared/policy';

export interface SecretCodec {
  available(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export class ElectronSecretCodec implements SecretCodec {
  available(): boolean { return safeStorage.isEncryptionAvailable(); }
  encrypt(value: string): string { return safeStorage.encryptString(value).toString('base64'); }
  decrypt(value: string): string { return safeStorage.decryptString(Buffer.from(value, 'base64')); }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

export class SettingsManager {
  private readonly filePath: string;
  constructor(userDataPath: string) { this.filePath = path.join(userDataPath, POLICY.configFileName); }

  async read(): Promise<AppSettings> {
    try {
      const stored = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<AppSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...stored,
        codex: { ...DEFAULT_SETTINGS.codex, ...stored.codex },
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      return { ...DEFAULT_SETTINGS, codex: { ...DEFAULT_SETTINGS.codex } };
    }
  }

  async save(settings: AppSettings): Promise<void> {
    await writeJsonAtomic(this.filePath, settings);
  }
}

type StoredCredential = { encrypted: string; updatedAt: string };
type CredentialFile = Record<string, StoredCredential>;

export class CredentialManager {
  private readonly filePath: string;
  private mutation:Promise<void>=Promise.resolve();
  constructor(userDataPath: string, private readonly codec: SecretCodec = new ElectronSecretCodec()) {
    this.filePath = path.join(userDataPath, POLICY.credentialsFileName);
  }

  private mutate<T>(operation:()=>Promise<T>):Promise<T> {
    const result=this.mutation.then(operation,operation);
    this.mutation=result.then(()=>undefined,()=>undefined);
    return result;
  }

  private async readFile(): Promise<CredentialFile> {
    return this.readFileAt(this.filePath);
  }

  private async readFileAt(filePath: string): Promise<CredentialFile> {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')) as CredentialFile; }
    catch (error: any) { if (error?.code === 'ENOENT') return {}; throw error; }
  }

  async set(key: CredentialKey, value: string): Promise<void> {
    if (!value.trim()) throw new Error('Credential 값이 비어 있습니다.');
    if (!this.codec.available()) throw new Error('운영체제 보안 저장소를 사용할 수 없어 Secret을 저장하지 않았습니다.');
    await this.mutate(async()=>{
      const file = await this.readFile();
      file[key] = { encrypted: this.codec.encrypt(value), updatedAt: new Date().toISOString() };
      await writeJsonAtomic(this.filePath, file);
    });
  }

  async get(key: CredentialKey): Promise<string | undefined> {
    const stored = (await this.readFile())[key];
    if (!stored) return undefined;
    if (!this.codec.available()) throw new Error('운영체제 보안 저장소를 사용할 수 없습니다.');
    return this.codec.decrypt(stored.encrypted);
  }

  async delete(key: CredentialKey): Promise<void> {
    await this.mutate(async()=>{
      const file = await this.readFile();
      if (!(key in file)) return;
      delete file[key];
      await writeJsonAtomic(this.filePath, file);
    });
  }

  async status(keys: CredentialKey[]): Promise<Record<string, { stored: boolean; updatedAt?: string }>> {
    const file = await this.readFile();
    return Object.fromEntries(keys.map((key) => [key, { stored: Boolean(file[key]), updatedAt: file[key]?.updatedAt }]));
  }

  async orphanedThreadsTokenKeys(accountIds: string[]): Promise<Array<`threadsToken:${string}`>> {
    const active = new Set(accountIds);
    const file = await this.readFile();
    return Object.keys(file)
      .filter((key): key is `threadsToken:${string}` => key.startsWith('threadsToken:'))
      .filter((key) => !active.has(key.slice('threadsToken:'.length)));
  }

  async moveIfTargetMissing(sourceKey: CredentialKey, targetKey: CredentialKey): Promise<boolean> {
    return this.mutate(async()=>{
      const file=await this.readFile();
      if(!file[sourceKey]||file[targetKey])return false;
      file[targetKey]=file[sourceKey];
      delete file[sourceKey];
      await writeJsonAtomic(this.filePath,file);
      return true;
    });
  }

  async purgeDeprecatedThreadsAppCredentials(): Promise<number> {
    return this.mutate(async()=>{
      const file = await this.readFile();
      const deprecated = Object.keys(file).filter((key) => key === 'metaAppId' || key === 'metaAppSecret' || key.startsWith('metaAppId:') || key.startsWith('metaAppSecret:'));
      if (!deprecated.length) return 0;
      deprecated.forEach((key) => delete file[key]);
      await writeJsonAtomic(this.filePath, file);
      return deprecated.length;
    });
  }

  async migrateLegacyThreadsToken(accountIds:string[]):Promise<boolean> {
    return this.mutate(async()=>{
      const file = await this.readFile();
      const legacy = file.threadsToken;
      if (!legacy || accountIds.length !== 1) return false;
      const scopedKey = `threadsToken:${accountIds[0]}`;
      file[scopedKey] ??= legacy;
      delete file.threadsToken;
      await writeJsonAtomic(this.filePath,file);
      return true;
    });
  }
}
