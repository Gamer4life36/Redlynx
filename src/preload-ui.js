/**
 * Bridge for the browser chrome UI (tab strip, omnibar, panels).
 * The UI gets exactly this API and nothing more — no Node access.
 */
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('redlynx', {
  // tabs
  newTab: (url) => ipcRenderer.invoke('tab:new', url),
  closeTab: (id) => ipcRenderer.invoke('tab:close', id),
  activateTab: (id) => ipcRenderer.invoke('tab:activate', id),
  reopenTab: () => ipcRenderer.invoke('tab:reopen'),
  suspendTab: (id) => ipcRenderer.invoke('tab:suspend', id),
  pinTab: (id) => ipcRenderer.invoke('tab:pin', id),
  tabMenu: (id) => ipcRenderer.invoke('tab:menu', id),
  railToggle: () => ipcRenderer.invoke('rail:toggle'),
  suspendOthers: () => ipcRenderer.invoke('tab:suspendOthers'),
  tabState: () => ipcRenderer.invoke('tab:state'),

  // navigation
  go: (input) => ipcRenderer.invoke('nav:go', input),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: (hard) => ipcRenderer.invoke('nav:reload', !!hard),
  stop: () => ipcRenderer.invoke('nav:stop'),
  home: () => ipcRenderer.invoke('nav:home'),
  navState: () => ipcRenderer.invoke('nav:state'),

  // media + downloads
  mediaList: (tabId) => ipcRenderer.invoke('media:list', tabId),
  grabPage: (payload) => ipcRenderer.invoke('media:grabPage', payload),
  grab: (item) => ipcRenderer.invoke('media:grab', item),
  downloads: () => ipcRenderer.invoke('dl:list'),
  cancelDownload: (id) => ipcRenderer.invoke('dl:cancel', id),
  retryDownload: (id) => ipcRenderer.invoke('dl:retry', id),
  downloadDir: () => ipcRenderer.invoke('dl:dir'),
  enginesReady: () => ipcRenderer.invoke('dl:enginesReady'),

  // deep search
  deepSearch: (query, sources) => ipcRenderer.invoke('deep:search', { query, sources }),
  deepSources: () => ipcRenderer.invoke('deep:sources'),

  // prefs / privacy
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch) => ipcRenderer.invoke('prefs:set', patch),
  answerPrompt: (id, answer) => ipcRenderer.invoke('prompt:answer', { id, answer }),
  vaultList: () => ipcRenderer.invoke('vault:list'),
  vaultForget: (host) => ipcRenderer.invoke('vault:forget', host),
  clearBrowsingData: () => ipcRenderer.invoke('privacy:clear'),

  // AI (off unless the user enables it)
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiAsk: (question) => ipcRenderer.invoke('ai:ask', { question }),

  // Control (resource governor)
  hotTabs: () => ipcRenderer.invoke('gx:hot'),
  popOut: () => ipcRenderer.invoke('gx:popout'),
  memoryMb: () => ipcRenderer.invoke('gx:memory'),

  // blocking
  blockStatus: () => ipcRenderer.invoke('block:status'),
  blockRefresh: () => ipcRenderer.invoke('block:refresh'),

  // favorites
  favList: () => ipcRenderer.invoke('fav:list'),
  favAdd: () => ipcRenderer.invoke('fav:add'),
  favRemove: (url) => ipcRenderer.invoke('fav:remove', url),
  favIsSaved: () => ipcRenderer.invoke('fav:isSaved'),
  bmTree: () => ipcRenderer.invoke('bm:tree'),
  bmAddFolder: (name) => ipcRenderer.invoke('bm:addFolder', name),
  bmRename: (id, title) => ipcRenderer.invoke('bm:rename', { id, title }),
  bmRemove: (id) => ipcRenderer.invoke('bm:remove', id),
  bmMoveTo: (id, folderId) => ipcRenderer.invoke('bm:moveTo', { id, folderId }),
  bmFolders: () => ipcRenderer.invoke('bm:folders'),

  userscriptsList: () => ipcRenderer.invoke('userscripts:list'),

  // background
  bgPick: () => ipcRenderer.invoke('bg:pick'),
  bgClear: () => ipcRenderer.invoke('bg:clear'),
  bgUrl: () => ipcRenderer.invoke('bg:url'),

  // anonymity
  newPrivateTab: (url) => ipcRenderer.invoke('tab:newPrivate', url),
  anonApply: () => ipcRenderer.invoke('anon:apply'),
  anonCheckIp: () => ipcRenderer.invoke('anon:checkIp'),
  anonDoh: () => ipcRenderer.invoke('anon:doh'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  torStatus: () => ipcRenderer.invoke('anon:tor'),
  torState: () => ipcRenderer.invoke('tor:status'),
  torStart: () => ipcRenderer.invoke('tor:start'),
  torStop: () => ipcRenderer.invoke('tor:stop'),

  // history
  histSearch: (q) => ipcRenderer.invoke('hist:search', q),
  histSuggest: (q) => ipcRenderer.invoke('hist:suggest', q),
  omniSuggest: (q) => ipcRenderer.invoke('omni:suggest', q),

  // extensions
  moveTab: (id, toIndex) => ipcRenderer.invoke('tab:move', { id, toIndex }),

  // reader mode
  readerToggle: () => ipcRenderer.invoke('reader:toggle'),
  readerState: () => ipcRenderer.invoke('reader:state'),

  // site permissions
  permList: () => ipcRenderer.invoke('perm:list'),
  permForget: (host, permission) => ipcRenderer.invoke('perm:forget', { host, permission }),

  // updates

  extList: () => ipcRenderer.invoke('ext:list'),
  extAdd: () => ipcRenderer.invoke('ext:add'),
  extRemove: (id) => ipcRenderer.invoke('ext:remove', id),
  histRemove: (url) => ipcRenderer.invoke('hist:remove', url),
  histClear: (sinceMs) => ipcRenderer.invoke('hist:clear', sinceMs),

  // find in page
  findStart: (text, forward, findNext) => ipcRenderer.invoke('find:start', { text, forward, findNext }),
  findStop: (keep) => ipcRenderer.invoke('find:stop', keep),

  // page tools
  enginesList: () => ipcRenderer.invoke('engines:list'),
  zoomSet: (dir) => ipcRenderer.invoke('zoom:set', dir),
  zoomGet: () => ipcRenderer.invoke('zoom:get'),
  print: () => ipcRenderer.invoke('page:print'),
  importBookmarks: () => ipcRenderer.invoke('bm:import'),

  // shell
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openExternal: (u) => ipcRenderer.invoke('shell:openExternal', u),

  // events
  onTabs: on('tabs'),
  onNav: on('nav'),
  onPrefs: on('prefs'),
  onDownloads: on('downloads'),
  onPrompt: on('prompt'),
  onToast: on('toast'),
  onFocusUrl: on('focus-url'),
  onFindResult: on('find-result'),
  onOpenFind: on('open-find'),
  onDoBookmark: on('do-bookmark'),
  onOpenPanel: on('open-panel'),
  onPalette: on('palette'),
  onTor: on('tor'),
  onUpdate: on('update'),
  onShortcut: on('shortcut'),
  // Tell the browser the chrome is drawing over the page, so its view can be
  // grown to full size and raised above it.
  setOverlay: (on) => ipcRenderer.send('ui:overlay', !!on),
  // Ask the browser to open a connection ahead of the navigation.
  warm: (target) => ipcRenderer.send('ui:warm', target || ''),
});
