import path from 'node:path';
import { accessSync, constants, readFileSync } from 'node:fs';

export function projectStorageRoot(appPath: string, executablePath: string, packaged: boolean, installedStorageRoot?: string): string {
  if (!packaged) return appPath;
  // 프로젝트 out/의 실행 파일도 개발 실행과 같은 data/를 사용한다.
  const executableDirectory = path.dirname(executablePath);
  for (let directory = executableDirectory; ; directory = path.dirname(directory)) {
    try {
      if (JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).name === 'threads-auto') return directory;
    } catch { /* 상위 프로젝트 확인 */ }
    // Installed bundles and Program Files can be read-only. Use OS user storage.
    if (path.dirname(directory) === directory) {
      // Preserve existing portable Windows data without copying credentials or databases.
      if(process.platform==='win32'){
        try{accessSync(path.join(executableDirectory,'data'),constants.W_OK);return executableDirectory;}
        catch{/* New installs and read-only locations use the OS user directory. */}
      }
      return installedStorageRoot ?? executableDirectory;
    }
  }
}

export function projectDataDirectory(root: string, safeUiTest: boolean, processId: number): string {
  return safeUiTest ? path.join(root, 'test-artifacts', `ui-data-${processId}`) : path.join(root, 'data');
}
