import { contextBridge, ipcRenderer } from "electron";
import type { ReadApi } from "../shared/contracts";

// The only bridge. Method names mirror the main-process handlers one to one.
const api: ReadApi = {
  version: "0.0.1",
  platform: process.platform,
  setTheme: (theme) => ipcRenderer.invoke("theme:set", theme),
  onLibraryChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("library:changed", handler);
    return () => ipcRenderer.removeListener("library:changed", handler);
  },
  importCorpus: () => ipcRenderer.invoke("material:importCorpus"),
  openUrl: (url) => ipcRenderer.invoke("material:openUrl", url),
  openFile: (input) => ipcRenderer.invoke("material:openFile", input),
  getMaterial: (id) => ipcRenderer.invoke("material:get", id),
  getMaterialBytes: (id) => ipcRenderer.invoke("material:bytes", id),
  resolveImage: (url) => ipcRenderer.invoke("image:resolve", url),
  listAnnotations: (materialId) => ipcRenderer.invoke("annotation:list", materialId),
  saveAnnotation: (annotation) => ipcRenderer.invoke("annotation:save", annotation),
  deleteAnnotation: (materialId, id) => ipcRenderer.invoke("annotation:delete", materialId, id),
  listMaterials: () => ipcRenderer.invoke("material:list"),
};
contextBridge.exposeInMainWorld("read", api);
