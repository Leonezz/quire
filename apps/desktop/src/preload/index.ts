import { contextBridge, ipcRenderer } from "electron";
import type { ReadApi } from "../shared/contracts";

// The only bridge. Method names mirror the main-process handlers one to one.
const api: ReadApi = {
  version: "0.0.1",
  platform: process.platform,
  openUrl: (url) => ipcRenderer.invoke("material:openUrl", url),
  getMaterial: (id) => ipcRenderer.invoke("material:get", id),
  listMaterials: () => ipcRenderer.invoke("material:list"),
};
contextBridge.exposeInMainWorld("read", api);
