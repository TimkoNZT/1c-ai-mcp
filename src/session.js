import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { token, BASE_URL, UNIQUE_ID, SESSION_FILE, PLUGIN_VERSION, EDT_VERSION, buildConfigurationParameters } from "./config.js";
import { trace, log } from "./logger.js";

export class RetrySessionError extends Error {
  constructor(msg) { super(msg || "Retry session"); this.name = "RetrySessionError"; }
}

let sessionId = null;
let knownConversations = []; // { uuid, title?, skill?, created_at? }
let askConv = null; // { uuid, lastAssistantUuid } — персистентный Ask-чат

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function loadSessionCache() {
  try {
    if (existsSync(SESSION_FILE)) {
      const data = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
      if (data.sessionId) sessionId = data.sessionId;
      if (Array.isArray(data.conversations)) knownConversations = data.conversations;
      if (data.askConv) askConv = data.askConv;
    }
  } catch { /* ignore */ }
}

function saveSessionCache() {
  try {
    writeFileSync(SESSION_FILE, JSON.stringify({ sessionId, askConv, conversations: knownConversations }), "utf8");
  } catch { /* ignore */ }
}

export function resetSession() {
  sessionId = null;
  askConv = null;
  try { if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE); } catch { /* ignore */ }
}

export function addConversation(conv) {
  if (!conv?.uuid) return;
  knownConversations = knownConversations.filter(c => c.uuid !== conv.uuid);
  knownConversations.push({ uuid: conv.uuid, title: conv.title || "", skill: conv.skill || "", created_at: new Date().toISOString() });
  saveSessionCache();
}

export function removeConversation(uuid) {
  const before = knownConversations.length;
  knownConversations = knownConversations.filter(c => c.uuid !== uuid);
  if (knownConversations.length !== before) saveSessionCache();
}

export function getAllConversations() {
  return knownConversations;
}

export function clearConversations() {
  if (knownConversations.length) {
    knownConversations = [];
    saveSessionCache();
  }
}

export function clearToolConversations() {
  const before = knownConversations.length;
  const askSkills = new Set(["raw", "custom"]);
  knownConversations = knownConversations.filter(c => askSkills.has(c.skill));
  if (knownConversations.length !== before) saveSessionCache();
}

export function saveAskConv(uuid, lastAssistantUuid) {
  if (!uuid) return;
  askConv = { uuid, lastAssistantUuid: lastAssistantUuid || null };
  saveSessionCache();
}

export function getAskConv() {
  return askConv;
}

export function clearAskConv() {
  askConv = null;
  saveSessionCache();
}

export function getCachedSession() {
  return sessionId;
}

export async function getSession() {
  if (sessionId) {
    log(`  📋 sessionId: ${sessionId.slice(0, 8)}… (из кэша)`);
    return sessionId;
  }

  const delays = [10000, 30000, 60000]; // сервер рекомендует "Retry in 60 seconds"
  for (let attempt = 0; ; attempt++) {
    log("  🔄 Создание сессии...");
    trace("session_req", { body: "create_session" });
    const res = await fetch(`${BASE_URL}/api/v1/create_session`, {
      method: "POST",
      headers: {
        Authorization: token,
        "Unique-Id": UNIQUE_ID,
        "Content-Type": "application/json",
        Accept: "application/json",
        "plugin_version": PLUGIN_VERSION,
        "EDT_version": EDT_VERSION,
      },
      body: JSON.stringify({
        service_parameters: {
          url: BASE_URL,
          chat_url: BASE_URL + "chat/",
          timeout: 15000,
          min_delay: 300,
          verbosity: "warning",
          git_diff_context_lines: 8,
          stop: [],
          prefix_length: 1000,
          suffix_length: 500,
          global_context: false,
          experimental: false,
        },
        user_parameters: {
          plugin_version: PLUGIN_VERSION,
          edt_version: EDT_VERSION,
          tab_width: 4,
          code_completion_lines_count: 10,
          code_completion_policy: "moderate",
          is_continuous_code_completion: true,
          min_request_delay_ms: 300,
          timeout_ms: 15000,
          line_separator: "\r\n",
          language: "Russian",
          global_context: false,
          experimental: false,
          configuration_parameters: buildConfigurationParameters(),
        },
        system_info: {
          os_name: "Windows 11",
          os_version: "10.0",
          arch: "amd64",
          available_processors: 16,
          processor_name: "Intel64 Family 6 Model 186 Stepping 3, GenuineIntel",
          total_physical_memory_size: 34078701568,
        },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      sessionId = data.session_id;
      saveSessionCache();
      trace("session_res", { status: res.status, sessionId: sessionId?.slice(0, 8) });
      log(`  ✅ Сессия создана: ${sessionId.slice(0, 8)}…`);
      return sessionId;
    }

    const body = await res.text();
    trace("session_err", { status: res.status, body: body.slice(0, 500) });
    if ((res.status === 423 || res.status === 401) && attempt < delays.length) {
      log(`  ⏳ Сессия занята (${res.status}), жду ${delays[attempt] / 1000}с (попытка ${attempt + 1})...`);
      await sleep(delays[attempt]);
      continue;
    }

    log(`  ❌ Ошибка создания сессии (${res.status}): ${body}`);
    throw new Error(`create_session: ${res.status} ${body}`);
  }
}
