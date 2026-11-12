#!/usr/bin/env node

import { token } from "./config.js";
import { log } from "./logger.js";
import { mcpMain } from "./mcp-handler.js";

if (!token) {
  log("ERROR: AI_TOKEN env var or --token argument required");
  process.exit(1);
}

log("1C AI MCP (code.1c.ai) — запуск...");
mcpMain().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
