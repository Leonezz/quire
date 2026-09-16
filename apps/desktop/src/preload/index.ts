import { contextBridge } from "electron";

// The only bridge. Grows into the JSON-RPC client; nothing else crosses.
const api = {
  version: "0.0.1",
  platform: process.platform,
};
contextBridge.exposeInMainWorld("read", api);
export type ReadApi = typeof api;
