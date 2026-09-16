import type { ReadApi } from "../shared/contracts";
declare global { interface Window { read: ReadApi } }
export {};
