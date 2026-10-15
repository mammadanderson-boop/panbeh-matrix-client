// The only bridge between the web app and Electron; src/desktop.ts is its other end.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("panbehDesktop", {
  setBadge: (n) => ipcRenderer.send("badge", n),
  setLang: (lang) => ipcRenderer.send("lang", lang),
  focus: () => ipcRenderer.send("focus"),
  openExternal: (url) => ipcRenderer.send("open-external", url),
  /** Pass a boolean to change it; resolves to the current setting. */
  autostart: (on) => ipcRenderer.invoke("autostart", on),
  info: () => ipcRenderer.invoke("info"),
  /** Where the download of this blob: URL was saved, once it finishes; null if it was cancelled. */
  downloadPath: (url) => ipcRenderer.invoke("download-path", url),
  /** Opens a file downloadPath reported; false if it's gone. */
  openDownload: (path) => ipcRenderer.invoke("open-download", path),
  /** Registers the listener, then asks for links that arrived before the page was ready (cold start). */
  onLink: (cb) => {
    const h = (_e, link) => cb(link);
    ipcRenderer.on("link", h);
    ipcRenderer.send("links-ready");
    return () => ipcRenderer.off("link", h);
  },
  /** Screen sharing on Windows/X11: main asks which screen or window; cb resolves to its id, or null to cancel. */
  onPickSource: (cb) => {
    const h = async (_e, n, sources) => ipcRenderer.send("picked-source", n, await cb(sources));
    ipcRenderer.on("pick-source", h);
    return () => ipcRenderer.off("pick-source", h);
  },
  /** App updates: the current state, then every change through onState; auto(on?) like autostart. */
  update: {
    state: () => ipcRenderer.invoke("update-state"),
    onState: (cb) => {
      const h = (_e, u) => cb(u);
      ipcRenderer.on("update", h);
      return () => ipcRenderer.off("update", h);
    },
    auto: (on) => ipcRenderer.invoke("update-auto", on),
    check: () => ipcRenderer.invoke("update-check"),
    download: () => ipcRenderer.invoke("update-download"),
    install: () => ipcRenderer.invoke("update-install"),
  },
  onVisibility: (cb) => {
    const h = (_e, visible) => cb(visible);
    ipcRenderer.on("visibility", h);
    return () => ipcRenderer.off("visibility", h);
  },
});
