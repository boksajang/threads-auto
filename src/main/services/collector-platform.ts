import os from 'node:os';
import path from 'node:path';

export function chromeUserDataRoot(platform: NodeJS.Platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA): string | undefined {
  if (platform === 'win32') return localAppData ? path.join(localAppData, 'Google', 'Chrome', 'User Data') : undefined;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  return path.join(home, '.config', 'google-chrome');
}

export function collectorPipePath(suffix = '', platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\threads-auto-coupang-collector-v2${suffix}`;
  // Short, per-user paths stay below macOS's Unix-domain socket path limit.
  return `/tmp/threads-auto-${process.getuid?.() ?? 'user'}/collector${suffix}.sock`;
}

export function nativeHostLauncher(executable: string, script: string, socket: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(executable)} ${quote(script)} ${quote(socket)} "$@"\n`;
}
