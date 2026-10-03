import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionInstallation } from '../../shared/coupang-collector';

const extensionFiles = ['service-worker.js', 'content-script.js', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png', 'manifest.json'];

// Copy only public extension assets, keeping the manifest last and the install path stable across app updates.
export async function prepareExtensionInstallation(sourceDirectory: string, targetDirectory = sourceDirectory): Promise<ExtensionInstallation> {
  const contents = await Promise.all(extensionFiles.map(file => fs.readFile(path.join(sourceDirectory, file))));
  const manifest = JSON.parse(contents[contents.length - 1].toString('utf8'));
  if (manifest.manifest_version !== 3 || typeof manifest.version !== 'string') throw new Error('확장프로그램 패키지를 확인할 수 없습니다. 앱을 다시 설치해 주세요.');
  if (path.resolve(sourceDirectory) !== path.resolve(targetDirectory)) {
    await fs.mkdir(path.join(targetDirectory, 'icons'), { recursive: true });
    for (const [index, file] of extensionFiles.entries()) await fs.writeFile(path.join(targetDirectory, file), contents[index]);
  }
  return { directory: path.resolve(targetDirectory), version: manifest.version };
}
