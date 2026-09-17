import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { MaterialStore } from "./engine/materials";
import { MAX_BYTES } from "./engine/fetch";

const store = new MaterialStore(app.getPath("userData"));

function boundedString(value: unknown, max: number, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(code);
  return value;
}

// One JSON-RPC-ish boundary; every handler validates its input before touching the store.
ipcMain.handle("material:openUrl", (_event, url: unknown) => store.openUrl(boundedString(url, 4096, "IPC_INVALID_URL")));
ipcMain.handle("material:openFile", (_event, input: unknown) => {
  const value = input as { name?: unknown; mediaType?: unknown; bytes?: unknown };
  const name = boundedString(value?.name, 255, "IPC_INVALID_FILE_NAME");
  const mediaType = typeof value?.mediaType === "string" ? value.mediaType.slice(0, 100) : "";
  if (!(value?.bytes instanceof Uint8Array) || value.bytes.byteLength === 0 || value.bytes.byteLength > MAX_BYTES) throw new Error("IPC_INVALID_FILE_BYTES");
  return store.openFile({ name, mediaType, bytes: value.bytes });
});
ipcMain.handle("theme:set", (_event, theme: unknown) => {
  if (theme !== "system" && theme !== "light" && theme !== "dark") throw new Error("IPC_INVALID_THEME");
  nativeTheme.themeSource = theme;
});
ipcMain.handle("material:get", (_event, id: unknown) => store.get(boundedString(id, 64, "IPC_INVALID_ID")));
ipcMain.handle("material:bytes", (_event, id: unknown) => store.bytes(boundedString(id, 64, "IPC_INVALID_ID")));
ipcMain.handle("material:list", () => store.list());

// One window. Native vibrancy behind a transparent page so the glass panels
// in the renderer sit on the real desktop, not on a painted gradient.
function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 24, y: 24 },
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
