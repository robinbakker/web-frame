/**
 * Preload for the Frame This window (public/bridge.html): connect code on first run, status after.
 * It runs sandboxed, where a preload is a plain script that can only `require('electron')`, so this
 * file has no imports or exports.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webFrame', {
  getState: () => ipcRenderer.invoke('bridge:get-state'),
  connect: (code: string) => ipcRenderer.invoke('bridge:connect', String(code)),
  useStandalone: () => ipcRenderer.invoke('bridge:standalone'),
  openFrameThis: () => ipcRenderer.invoke('bridge:open-frame-this'),
  runNow: () => ipcRenderer.invoke('bridge:run-now'),
  unlink: () => ipcRenderer.invoke('bridge:unlink'),
  onState: (listener: (state: unknown) => void) => {
    ipcRenderer.on('bridge:state', (_event: unknown, state: unknown) => listener(state));
  },
});
