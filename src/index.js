#!/usr/bin/env node

import { isMcpMode, token } from "./config.js";
import { log } from "./logger.js";
import { mcpMain } from "./mcp-handler.js";

if (!token && isMcpMode) {
  log("ERROR: AI_TOKEN env var or --token argument required for MCP mode");
  process.exit(1);
}

if (isMcpMode) {
  log("1C AI MCP (code.1c.ai) — запуск...");
  mcpMain().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
} else {
  log("HTTP mode будет добавлен позднее.");
  log("Запустите с флагом --mcp для MCP-режима.");
  process.exit(1);
}
