import type { ReadApi } from "./index";
declare global { interface Window { read: ReadApi } }
export {};
