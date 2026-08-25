/**
 * Right-click context menus.
 *
 * Redlynx ships no native menu bar, so this is where copy / paste / save-image
 * / open-in-new-tab actually live. Without it the browser feels broken, no
 * matter how good the rest is. Also wires Redlynx's own tricks into the menu:
 * grab this video, save this image straight to the download queue.
 */
const { Menu, clipboard, shell } = require('electron');

let deps = {};

function install(options) { deps = options; }

function attach(tabId, wc) {
  wc.on('context-menu', (event, p) => {
    const items = [];
    const nh = wc.navigationHistory;
    const sel = (p.selectionText || '').trim();

    // ── link ──
    if (p.linkURL) {
      items.push(
        { label: 'Open link in new tab', click: () => deps.newTab(p.linkURL, { background: true }) },
        // Pins straight to the rail, parked. Nothing loads until it is clicked,
        // which is the whole point of pinning something you are not reading yet.
        { label: 'Pin to sidebar', click: () => deps.pinUrl && deps.pinUrl(p.linkURL) },
        { label: 'Open link in this tab', click: () => wc.loadURL(p.linkURL) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
        { label: 'Open link in system browser', click: () => shell.openExternal(p.linkURL).catch(() => {}) },
        { type: 'separator' },
      );
    }

    // ── image ──
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: '⬇ Save image', click: () => deps.download(p.srcURL, 'image') },
        { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
        { label: 'Open image in new tab', click: () => deps.newTab(p.srcURL, { background: true }) },
        { type: 'separator' },
      );
    }

    // ── audio / video ──
    if (p.mediaType === 'video' || p.mediaType === 'audio') {
      items.push(
        { label: '⬇ Grab this ' + p.mediaType, click: () => deps.download(p.srcURL || wc.getURL(), p.mediaType) },
        { label: '⧉ Pop out video', click: () => deps.popOut(), visible: p.mediaType === 'video' },
        { label: 'Copy media address', click: () => clipboard.writeText(p.srcURL || ''), visible: !!p.srcURL },
        { type: 'separator' },
      );
    }

    // ── editable fields ──
    if (p.isEditable) {
      items.push(
        { label: 'Undo', role: 'undo', enabled: p.editFlags.canUndo },
        { label: 'Redo', role: 'redo', enabled: p.editFlags.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: p.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste },
        { label: 'Select all', role: 'selectAll' },
        { type: 'separator' },
      );
    } else if (sel) {
      const short = sel.length > 24 ? sel.slice(0, 24) + '…' : sel;
      items.push(
        { label: 'Copy', role: 'copy' },
        { label: 'Search for "' + short + '"', click: () => deps.searchFor(sel) },
        { type: 'separator' },
      );
    }

    // ── page ──
    items.push(
      { label: 'Back', enabled: !!(nh && nh.canGoBack()), click: () => nh.goBack() },
      { label: 'Forward', enabled: !!(nh && nh.canGoForward()), click: () => nh.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: '☆ Bookmark this page', click: () => deps.bookmark() },
      { label: '⬇ Media on this page…', click: () => deps.openPanel('panelMedia') },
      { label: '🔎 Find on page', accelerator: 'Ctrl+F', click: () => deps.find() },
      { label: 'Print…', accelerator: 'Ctrl+P', click: () => wc.print({}, () => {}) },
      { type: 'separator' },
      { label: 'Copy page address', click: () => clipboard.writeText(wc.getURL()) },
      { label: 'Inspect element', click: () => { wc.inspectElement(p.x, p.y); } },
    );

    Menu.buildFromTemplate(items).popup();
  });
}

module.exports = { install, attach };
