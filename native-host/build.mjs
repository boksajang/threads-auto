/* global process */
import { spawnSync } from 'node:child_process';
import { accessSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

if (process.platform === 'win32') {
  // setup skips dependency install scripts. Squirrel still requires its host-arch 7-Zip files.
  for (const extension of ['exe', 'dll']) {
    copyFileSync(new URL(`../node_modules/electron-winstaller/vendor/7z-${process.arch}.${extension}`, import.meta.url), new URL(`../node_modules/electron-winstaller/vendor/7z.${extension}`, import.meta.url));
  }
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./build.ps1', import.meta.url))], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  // macOS uses the bundled Electron runtime; no system Node or compiler is needed.
  accessSync(new URL('./host.cjs', import.meta.url));
  if (process.platform === 'darwin') {
    const temporary = mkdtempSync(path.join(tmpdir(), 'threads-auto-icon-'));
    try {
      const pngPath = path.join(temporary, 'icon.png');
      const resized = spawnSync('/usr/bin/sips', ['-z', '1024', '1024', fileURLToPath(new URL('../assets/app-icon.png', import.meta.url)), '--out', pngPath], { stdio: 'pipe' });
      if (resized.error) throw resized.error;
      if (resized.status !== 0) throw new Error(`macOS icon conversion failed: ${resized.stderr}`);
      const png = readFileSync(pngPath);
      const header = Buffer.alloc(16);
      header.write('icns', 0); header.writeUInt32BE(png.length + 16, 4);
      header.write('ic10', 8); header.writeUInt32BE(png.length + 8, 12);
      writeFileSync(new URL('../assets/app-icon.icns', import.meta.url), Buffer.concat([header, png]));
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
