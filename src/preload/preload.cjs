const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const send = (channel) => (...args) => ipcRenderer.send(channel, ...args);
const subscribe = (channel) => (callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('electron', {
  searchLarkContacts: invoke('search-contacts'), searchLarkShareChats: invoke('search-chats'), sendLarkShareMessage: invoke('send-message'),
  getSettings: invoke('get-settings'), saveConfig: invoke('save-config'), login: invoke('login'), logout: invoke('logout'), installHook: invoke('install-hook'),
  setHideDock: invoke('set-hide-dock'), setOpenAtLogin: invoke('set-open-at-login'), openLoginSettings: send('open-login-settings'),
  openSettings: send('open-settings'), closeShare: send('close-share'),
  reportRendered: send('rendered'), resizeShare: send('resize-share'),
  onShare: subscribe('share'), onState: subscribe('state'),
});
