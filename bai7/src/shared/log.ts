// Logger dung chung cho server / app tai xe / mang gia lap,
// de log cua 1 lan chay thu nam chung 1 dong thoi gian.
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

let logFile: string | null = null;
const mutedTags = new Set<string>();

/** Tat log cua mot so nguon (vd SERVER khi demo 50 tai xe). */
export function muteTags(...tags: string[]) {
  tags.forEach((t) => mutedTags.add(t));
}

/** Ghi them log ra file (dung cho cac script demo de nop bai). */
export function logToFile(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  logFile = path;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function timestamp(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function log(tag: string, message: string) {
  if (mutedTags.has(tag)) return;
  const line = `${timestamp()} [${tag.padEnd(10)}] ${message}`;
  if (!process.env.QUIET) console.log(line);
  if (logFile) appendFileSync(logFile, line + "\n");
}

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
