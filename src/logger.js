import { writeFileSync, appendFileSync } from "fs";
import { TRACE_LOG } from "./config.js";

export function clearTrace() {
  // Каждый запуск прокси создаёт новый файл с timestamp — очистка не нужна
}

function truncateStrings(obj, maxLen) {
  if (typeof obj === "string")
    return obj.length > maxLen ? obj.slice(0, maxLen) + `... (${obj.length - maxLen} more chars)` : obj;
  if (Array.isArray(obj))
    return obj.map(v => truncateStrings(v, maxLen));
  if (obj && typeof obj === "object")
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, truncateStrings(v, maxLen)]));
  return obj;
}

export function trace(label, data) {
  const ts = new Date().toISOString();
  const safe = truncateStrings(data, 1000);
  const line = `\n=== ${ts} [${label}] ===\n${JSON.stringify(safe, null, 2)}\n`;
  appendFileSync(TRACE_LOG, line, "utf8");
}

export function log(...args) {
  // В MCP-режиме stdout используется для JSON-RPC, поэтому все логи — в stderr
  console.error(...args);
}
