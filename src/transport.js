import {
  token, API_MODE, API_BASE_URL, API_PREFIX,
  LOCAL_TOOL_DEFS,
} from "./config.js";
import { trace } from "./logger.js";

/**
 * Транспортный слой: единственное место, которое знает, как выглядит запрос
 * к code.1c.ai. Верхний код (chat-client) работает с диалогами и SSE и не
 * зависит от того, legacy это chat_api или публичный /public/v1.
 */

const IS_PUBLIC = API_MODE === "public";

export const TRANSPORT_CAPABILITIES = {
  mode: API_MODE,
  publicApi: IS_PUBLIC,
  skills: !IS_PUBLIC,        // выбор навыка через skill_name
  localContext: !IS_PUBLIC,  // структурированный код + курсор
  renderInfo: !IS_PUBLIC,    // request/response_markdown в стриме
};

export class ApiError extends Error {
  constructor(message, { status = 0, type = "", retryable = false, retrySession = false, conversationGone = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.retryable = retryable;
    this.retrySession = retrySession;
    this.conversationGone = conversationGone;
  }
}

/** Заголовки legacy chat_api (имитация веб-чата EDT). */
export function chatHeaders(accept) {
  return {
    Authorization: token,
    "Content-Type": "application/json",
    Accept: accept || "*/*",
    "Accept-Charset": "ISO-8859-1,utf-8;q=0.7,*;q=0.7",
    "Accept-Encoding": "gzip, inflate",
    "Accept-Language": "ru-ru,en-us;q=0.8,en;q=0.7",
    Origin: API_BASE_URL,
    Referer: `${API_BASE_URL}/chat/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Session-Id": "",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/622.1 (KHTML, like Gecko) JavaFX/25 Version/18.4 Safari/622.1",
  };
}

function headers(accept) {
  if (!IS_PUBLIC) return chatHeaders(accept);
  const h = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: accept || "application/json",
  };
  return h;
}

function endpoint(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${API_PREFIX}${p}`;
}

async function apiErrorFromResponse(res) {
  const text = await res.text();
  let type = "";
  let message = text;
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object") {
      type = body.error_type || "";
      if (typeof body.error === "string") message = body.error;
      else if (body.error !== undefined) message = JSON.stringify(body.error);
    }
  } catch { /* не JSON — оставляем как есть */ }

  const status = res.status;
  let msg = `HTTP ${status}${type ? ` ${type}` : ""}: ${String(message).slice(0, 800)}`;
  if (type === "budget_exceeded") msg += " (исчерпан лимит 1С:Напарника)";
  if (type === "no_active_tariff") msg += " (у ключа нет активной опции)";
  if (type === "invalid_token" || type === "token_not_found" || type === "no_token") {
    msg += " (проверь ключ доступа)";
  }

  return new ApiError(msg, {
    status,
    type,
    retryable: status === 429 || status >= 500,
    retrySession: !IS_PUBLIC && (status === 401 || status === 403),
    conversationGone: status === 404,
  });
}

function conversationPath(uuid, suffix = "") {
  return `/conversations/${uuid}${suffix}`;
}

/** Тело пользовательского сообщения для public API: инструкция + код одной строкой. */
export function buildUserContent(text, code) {
  const instruction = (text || "").trim();
  const src = code == null ? "" : String(code);
  if (!src.trim()) return instruction;
  const block = "```bsl\n" + src.replace(/\s+$/, "") + "\n```";
  return instruction ? `${instruction}\n\n${block}` : block;
}

export async function createConversationRequest({ skillName = "custom", title } = {}) {
  const isSkill = skillName !== "custom";

  let body;
  if (IS_PUBLIC) {
    body = {
      ui_language: "ru",
      programming_language: "1c",
      script_language: "ru",
    };
    if (title) body.title = title;
  } else {
    body = {
      skill_name: skillName,
      ui_language: "russian",
      programming_language: isSkill ? "1с" : "",
      is_chat: true,
      user_instruct: { common_rules: null, workspace_rules: null, projects_rules: {} },
    };
    if (isSkill) body.script_language = "Russian";
  }

  trace("conv_create", { mode: API_MODE, skillName, title });
  const res = await fetch(endpoint(IS_PUBLIC ? "/conversations" : "/conversations/"), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  const data = await res.json();
  if (!data?.uuid) throw new ApiError("create conversation: в ответе нет uuid", { status: res.status });
  return data.uuid;
}

export async function setConversationTitle(uuid, title) {
  const res = await fetch(endpoint(conversationPath(uuid, "/title")), {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ title: String(title).slice(0, 100) }),
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
}

export async function sendUserMessageRequest(convUuid, { text, code, skillName, parentUuid, signal }) {
  const isSkill = skillName && skillName !== "custom";

  let body;
  if (IS_PUBLIC) {
    body = {
      parent_uuid: parentUuid ?? null,
      role: "user",
      content: buildUserContent(text, code),
      tools: LOCAL_TOOL_DEFS,
    };
  } else {
    let content;
    if (isSkill) {
      // Новый контракт skill-запросов: инструкция обязательна и содержит код.
      content = { instruction: buildUserContent(text, code) };
    } else {
      content = { instruction: text || "" };
    }
    if (code && !isSkill) content.instruction = buildUserContent(text, code);
    body = {
      parent_uuid: parentUuid ?? null,
      role: "user",
      content: { content, tools: LOCAL_TOOL_DEFS },
    };
  }

  trace("send_msg_req", { mode: API_MODE, parentUuid, body });
  const res = await fetch(endpoint(conversationPath(convUuid, "/messages")), {
    method: "POST",
    headers: headers("text/event-stream"),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  return res;
}

/**
 * Отправляет результаты всех tool-вызовов одним сообщением:
 * локальные — со status ok/error и содержимым, серверные — accepted.
 */
export async function sendToolResultsRequest(convUuid, { parentUuid, entries, signal }) {
  const payload = entries.map(e => {
    if (IS_PUBLIC) {
      return {
        content: e.content ?? null,
        tool_call_id: e.tool_call_id,
        status: e.status || "ok",
      };
    }
    return {
      content: e.content ?? null,
      tool_call_id: e.tool_call_id,
      name: e.name,
      status: e.status || "ok",
    };
  });

  const body = { parent_uuid: parentUuid ?? null, role: "tool", content: payload };
  trace("tool_result_req", { mode: API_MODE, names: entries.map(e => e.name), body });
  const res = await fetch(endpoint(conversationPath(convUuid, "/messages")), {
    method: "POST",
    headers: headers("text/event-stream"),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  return res;
}

export async function deleteConversationRequest(uuid) {
  const res = await fetch(endpoint(conversationPath(uuid)), {
    method: "DELETE",
    headers: headers(),
  });
  if (!res.ok && res.status !== 404) throw await apiErrorFromResponse(res);
}
