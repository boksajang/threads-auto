import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import path from 'node:path';
import { prepareExtensionInstallation } from './src/main/services/extension-installation';

const extensionResources = path.resolve(__dirname, 'artifacts/extension-resources/chrome-extension');

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: [process.platform === 'win32' ? 'native-host/bin/ThreadsAuto.NativeHost.exe' : 'native-host/host.cjs', 'assets', extensionResources],
    icon: path.resolve(__dirname, 'assets', process.platform === 'darwin' ? 'app-icon.icns' : 'app-icon.ico'),
    ignore: (filePath) => {
      if (!filePath) return false;
      if (filePath.startsWith('/.vite')) return false;
      if (filePath === '/node_modules') return false;
      if (filePath.startsWith('/node_modules/better-sqlite3')) return false;
      if (filePath.startsWith('/node_modules/node-addon-api')) return false;
      return true;
    },
  },
  // better-sqlite3 v13 ships a Node-API prebuild; rebuilding it would require a
  // local Visual Studio C++ toolchain and is unnecessary for the packaged ABI.
  rebuildConfig: { onlyModules: [] },
  hooks: {
    generateAssets: async () => { await prepareExtensionInstallation(path.resolve(__dirname, 'chrome-extension'), extensionResources); },
  },
  makers: [new MakerSquirrel({ setupIcon: path.resolve(__dirname, 'assets', 'app-icon.ico') }), new MakerZIP({}, ['darwin'])],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.mjs', target: 'main' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.mjs', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mjs' }],
    }),
  ],
};

export default config;
