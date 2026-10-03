import os from 'node:os';
import path from 'node:path';

export function codexProcessEnvironment(env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform):NodeJS.ProcessEnv {
  if(platform==='win32')return env;
  // Finder-launched apps may omit the Node interpreter used by npm's Codex launcher.
  const directories=[...(env.PATH??'').split(path.delimiter),path.join(os.homedir(),'.local','bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'];
  return {...env,PATH:[...new Set(directories.filter(Boolean))].join(path.delimiter)};
}
