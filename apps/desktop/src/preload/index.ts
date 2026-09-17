import { contextBridge, ipcRenderer } from "electron";
import type { ReadApi } from "../shared/contracts";

// The only bridge. Method names mirror the main-process handlers one to one.
const api: ReadApi = {
  version: "0.0.1",
  platform: process.platform,
  setTheme: (theme) => ipcRenderer.invoke("theme:set", theme),
  openUrl: (url) => ipcRenderer.invoke("material:openUrl", url),
  openFile: (input) => ipcRenderer.invoke("material:openFile", input),
  getMaterial: (id) => ipcRenderer.invoke("material:get", id),
  getMaterialBytes: (id) => ipcRenderer.invoke("material:bytes", id),
  listMaterials: () => ipcRenderer.invoke("material:list"),
};
contextBridge.exposeInMainWorld("read", api);
