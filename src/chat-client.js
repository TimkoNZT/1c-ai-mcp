import { token, BASE_URL, LOCAL_TOOLS, LOCAL_TOOL_DEFS, TOOL_CONTENT_MAX_CHARS, UNIQUE_ID, PLUGIN_VERSION, EDT_VERSION } from "./config.js";
import { trace, log } from "./logger.js";
import { getSession, RetrySessionError, resetSession, addConversation, removeConversation, sleep } from "./session.js";
import { executeLocalTool } from "./tools.js";
import { createSSEReader } from "./sse-reader.js";

function edtHeaders(sid) {
  return {
    Authorization: token,
    "Unique-Id": UNIQUE_ID,
    "Session-Id": sid,
    "Content-Type": "application/json",
    Accept: "application/json",
    "plugin_version": PLUGIN_VERSION,
    "EDT_version": EDT_VERSION,
  };
}

/**
 * Санитизация текста: NFKC-нормализация + удаление управляющих ASCII-символов,
 * кроме табуляции, переноса строки и возврата каретки.
 */
export function sanitizeText(text) {
  return text ? text.normalize("NFKC").replace(/\\t/g, "").replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "") : text;
}

// ── Deferred mode (таймаут MCP + GetResult) ──
export const deferredState = { active: false, segments: [], toolCalls: [], cursor: 0, finished: false, error: null, opts: null };

/**
 * Получить результат отложенного стрима (для GetResult).
 * Каждый вызов возвращает новые сегменты, накопленные с прошлого раза.
 * Возвращает { text, finished } или null если нет активного deferred.
 */
export function getDeferredResult() {
  if (!deferredState.active && deferredState.cursor >= deferredState.segments.length) return null;
  const segs = deferredState.segments.slice(deferredState.cursor);
  deferredState.cursor = deferredState.segments.length;
  if (!segs.length && !deferredState.finished) return { text: "⏳ Модель ещё думает...", finished: false };
  const text = buildResult(segs, deferredState.toolCalls.slice(), deferredState.opts || {});
  const finished = deferredState.finished;
  if (finished) {
    deferredState.active = false;
  }
  let result = { text, finished };
  if (finished && text) {
    result.text = text + "\n\n⚠️ **Модель закончила ответ.**";
  }
  return result;
}

/**
 * ChatClient — управляет конверсацией и tool ACK циклом.
 * Создаёт новый экземпляр на каждый независимый диалог.
 */
export class ChatClient {
  constructor() {
    this.convUuid = null;
    this.lastAssistantUuid = null;
  }

  restoreConv(uuid, lastAssistantUuid) {
    this.convUuid = uuid || null;
    this.lastAssistantUuid = lastAssistantUuid || null;
  }

  getConvState() {
    return this.convUuid ? { uuid: this.convUuid, lastAssistantUuid: this.lastAssistantUuid } : null;
  }

  async createConversation(skillName = "raw", title) {
    const sid = await getSession();
    log(`  💬 askAI: создание конверсации (skill=${skillName})...`);
    const res = await fetch(`${BASE_URL}/chat_api/v1/conversations/`, {
      method: "POST",
      headers: edtHeaders(sid),
      body: JSON.stringify({ skill_name: skillName, ui_language: "ru", programming_language: "1c", script_language: "ru", is_chat: false }),
    });
    trace("conv_create", { skillName, title, status: res.status });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401 || res.status === 403) { resetSession(); throw new RetrySessionError(); }
      throw new Error(`create_conversation: ${res.status} ${body}`);
    }
    const data = await res.json();
    this.convUuid = data.uuid;

    // Устанавливаем название чата
    if (title) {
      try {
        await fetch(`${BASE_URL}/chat_api/v1/conversations/${this.convUuid}/title`, {
          method: "PUT",
          headers: edtHeaders(sid),
          body: JSON.stringify({ title: title.slice(0, 100) }),
        });
      } catch { /* ignore errors on title set */ }
    }

    // Регистрируем в кэше (на случай краша)
    addConversation({ uuid: this.convUuid, title, skill: skillName });
    log(`  💬 askAI: конверсация ${this.convUuid.slice(0, 8)}…`);
    return this.convUuid;
  }

  async sendUserMessage(text, code) {
    const sid = await getSession();
    const content = { code: code ? [{ content: code, path: "/" }] : [] };
    if (text) content.instruction = text;

    const body = {
      parent_uuid: this.lastAssistantUuid,
      role: "user",
      content: { content, tools: LOCAL_TOOL_DEFS },
    };
    log(`  💬 askAI: отправка (parent=${this.lastAssistantUuid ? this.lastAssistantUuid.slice(0, 8) + "…" : "null"})...`);
    trace("send_msg_req", { parentUuid: this.lastAssistantUuid, body });
    const res = await fetch(`${BASE_URL}/chat_api/v1/conversations/${this.convUuid}/messages`, {
      method: "POST",
      headers: { Authorization: token, "Session-Id": sid, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 401 || res.status === 403) { resetSession(); throw new RetrySessionError(); }
      if (res.status === 404) { this.convUuid = null; this.lastAssistantUuid = null; throw new RetrySessionError(); }
      throw new Error(`send_message: ${res.status} ${errBody}`);
    }
    return res;
  }

  async sendToolAck(assistantUuid, calls) {
    const sid = await getSession();
    const serverCalls = [];
    const results = [];

    for (const tc of calls) {
      const name = tc.function?.name || tc.name;
      if (LOCAL_TOOLS.has(name)) {
        try {
          const args = JSON.parse(tc.function?.arguments || "{}");
          log(`  💻 локальный тул: ${name}(${JSON.stringify(args).slice(0, 100)})`);
          const result = executeLocalTool(name, args);
          const content = (result.content || "").slice(0, TOOL_CONTENT_MAX_CHARS);
          results.push({ content, tool_call_id: tc.id, name });
        } catch (err) {
          log(`  ❌ ошибка тула ${name}: ${err.message}`);
          results.push({ content: `Error: ${err.message}`, tool_call_id: tc.id, name, status: "error" });
        }
      } else {
        serverCalls.push(tc);
      }
    }

    // Отправляем результаты локальных тулов
    if (results.length) {
      const body = {
        parent_uuid: assistantUuid,
        role: "tool",
        content: results.map(r => ({ content: r.content || "", tool_call_id: r.tool_call_id, name: r.name, status: r.status || "ok" })),
      };
      log(`  💬 askAI: результат локальных тулов (${results.map(r => r.name).join(", ")})`);
      trace("tool_result_req", { names: results.map(r => r.name), body });
    const res = await fetch(`${BASE_URL}/chat_api/v1/conversations/${this.convUuid}/messages`, {
      method: "POST",
      headers: { ...edtHeaders(sid), Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
      if (!res.ok) {
        const errBody = await res.text();
        if (res.status === 401 || res.status === 403) throw new RetrySessionError();
        throw new Error(`tool_result: ${res.status} ${errBody}`);
      }
      // Если есть ещё серверные — следующая итерация цикла их обработает
      if (serverCalls.length) return res;
      return res;
    }

    // Только серверные тулы — обычный ACK
    if (!serverCalls.length) return null;

    const body = {
      parent_uuid: assistantUuid,
      role: "tool",
      content: serverCalls.map(tc => ({ content: null, tool_call_id: tc.id, name: tc.function?.name || tc.name, status: "accepted" })),
    };
    log(`  💬 askAI: ACK серверных тулов (${serverCalls.map(t => t.function?.name || t.name).join(", ")})`);
    trace("tool_ack_req", { names: serverCalls.map(t => t.function?.name || t.name), body });
    const res = await fetch(`${BASE_URL}/chat_api/v1/conversations/${this.convUuid}/messages`, {
      method: "POST",
      headers: { ...edtHeaders(sid), Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 401 || res.status === 403) throw new RetrySessionError();
      throw new Error(`tool_ack: ${res.status} ${errBody}`);
    }
    return res;
  }

  /**
   * Единый обработчик SSE-события.
   * Модифицирует ctx { segments, toolCalls, answer, reasoning, assistantUuid, pendingToolName } на месте.
   */
  processEvent(event, ctx) {
    if (event.uuid && event.role === "assistant") {
      ctx.assistantUuid = event.uuid;
      ctx.pendingToolName = null;
    }

    if (event.role === "tool") {
      this.flushAccumulated(ctx);
      const toolName = event.content?.name || event.render_info?.[0]?.tool_name || null;
      if (event.content?.content) {
        let text = typeof event.content.content === "string" ? event.content.content : event.content.content?.text || "";
        if (text) {
          try { const p = JSON.parse(text); if (p && typeof p.content === "string") text = p.content; } catch {}
          text = sanitizeText(text.replace(/\\n/g, "\n"));
          ctx.segments.push({ type: "tool_result", toolName: toolName || "unknown_tool", text, toolCallId: event.content?.tool_call_id || null });
        }
      } else if (toolName && event.content_delta?.content) {
        const delta = sanitizeText(event.content_delta.content.replace(/\\n/g, "\n"));
        ctx.segments.push({ type: "tool_result", toolName, text: delta, toolCallId: event.content?.tool_call_id || null });
        ctx.pendingToolName = null;
      } else {
        ctx.pendingToolName = toolName;
        ctx.pendingToolCallId = event.content?.tool_call_id || null;
      }
      return;
    }

    if (event.content_delta) {
      if (event.content_delta.content) {
        const delta = sanitizeText(event.content_delta.content.replace(/\\n/g, "\n"));
        if (ctx.pendingToolName) {
          ctx.segments.push({ type: "tool_result", toolName: ctx.pendingToolName, text: delta, toolCallId: ctx.pendingToolCallId });
          ctx.pendingToolName = null;
          ctx.pendingToolCallId = null;
        } else {
          ctx.answer += delta;
        }
      }
      if (event.content_delta.reasoning_content) {
        const delta = sanitizeText(event.content_delta.reasoning_content.replace(/\\n/g, "\n"));
        ctx.reasoning += delta;
      }
      if (event.content_delta.tool_calls?.length) {
        for (const tc of event.content_delta.tool_calls) {
          const existing = ctx.toolCalls.find(t => t.index === tc.index);
          if (existing) {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) { existing.function = existing.function || {}; existing.function.name = tc.function.name; }
            if (tc.function?.arguments) { existing.function = existing.function || {}; existing.function.arguments = (existing.function.arguments || "") + tc.function.arguments; }
          } else {
            ctx.toolCalls.push(JSON.parse(JSON.stringify(tc)));
          }
        }
      }
    }

    if (event.finished) {
      if (event.content?.content && event.role !== "tool") {
        let text = typeof event.content.content === "string" ? event.content.content : event.content.content?.text || "";
        if (text) {
          text = sanitizeText(text.replace(/\\n/g, "\n"));
          if (text.length > ctx.answer.length) ctx.answer = text;
        }
      }
      if (ctx.reasoning) {
        ctx.segments.push({ type: "reasoning", text: ctx.reasoning });
        ctx.reasoning = "";
      }
      if (ctx.answer && ctx.toolCalls.length > 0) {
        ctx.segments.push({ type: "content", text: ctx.answer });
        ctx.answer = "";
        ctx.segments.push({ type: "boundary", finishReason: event.details?.finish_reason || null, renderInfo: event.render_info || null });
      } else {
        ctx.segments.push({ type: "boundary", finishReason: event.details?.finish_reason || null, renderInfo: event.render_info || null });
        if (ctx.answer) {
          ctx.segments.push({ type: "content", text: ctx.answer });
          ctx.answer = "";
        }
      }
    }
  }

  flushAccumulated(ctx) {
    if (ctx.reasoning || ctx.answer) {
      if (ctx.reasoning) ctx.segments.push({ type: "reasoning", text: ctx.reasoning });
      ctx.segments.push({ type: "content", text: ctx.answer });
      ctx.reasoning = "";
      ctx.answer = "";
    }
  }

  /**
   * Фоновый цикл чтения SSE: читает стрим, обрабатывает события,
   * самостоятельно отправляет tool ACK.
   * Всё накопленное кладёт в deferredState.
   */
  async bgLoop(response) {
    let currentRes = response;
    let assistantUuid = null;

    while (true) {
      try {
        const reader = createSSEReader(currentRes);
        const ctx = { segments: [], toolCalls: [], answer: "", reasoning: "", assistantUuid: null, pendingToolName: null, pendingToolCallId: null };

        while (true) {
          const { done, events } = await reader.read();
          if (done) break;
          for (const event of events) {
            trace("sse_event", event);
            this.processEvent(event, ctx);
            for (const seg of ctx.segments) {
              deferredState.segments.push(seg);
            }
            ctx.segments = [];
          }
        }

        this.flushAccumulated(ctx);
        for (const seg of ctx.segments) {
          deferredState.segments.push(seg);
        }
        ctx.segments = [];

        if (ctx.assistantUuid) {
          assistantUuid = ctx.assistantUuid;
          this.lastAssistantUuid = assistantUuid;
        }

        for (const tc of ctx.toolCalls) {
          deferredState.toolCalls.push({
            id: tc.id || tc.tool_call_id,
            name: tc.function?.name || tc.name || "?",
            args: (() => { try { return JSON.stringify(JSON.parse(tc.function?.arguments || "{}")); } catch { return tc.function?.arguments || ""; } })(),
          });
        }

        if (ctx.toolCalls.length > 0) {
          trace("tool_ack_loop", { toolCallsCount: ctx.toolCalls.length, assistantUuid: (assistantUuid || this.lastAssistantUuid)?.slice(0, 8) });
          currentRes = await this.sendToolAck(assistantUuid || this.lastAssistantUuid, ctx.toolCalls);
          if (!currentRes?.body) { deferredState.finished = true; break; }
          continue;
        }

        deferredState.finished = true;
        deferredState.active = false;
        trace("all_segments", deferredState.segments);
        return;
      } catch (err) {
        log(`  ⚠️ bgLoop error: ${err.message || err}`);
        deferredState.error = err;
        deferredState.finished = true;
        deferredState.active = false;
        return;
      }
    }
  }

  /**
   * Полный цикл чата: conv → message → bgLoop → результат.
   * bgLoop запускается в фоне; при deferredMs > 0 ask ждёт не дольше таймаута,
   * затем возвращает накопленное (deferred). bgLoop продолжает читать SSE
   * и отправлять tool ACK в фоне — GetResult забирает новые сегменты.
   */
  async ask(question, code, opts = {}) {
    const deferredMs = opts.deferredMs || 0;
    const showReasoning = opts.showReasoning ?? false;
    const showToolLog = opts.showToolLog ?? false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (opts.freshConv || !this.convUuid) {
          if (this.convUuid && opts.freshConv) {
            await this.deleteConversation().catch(() => {});
            this.convUuid = null; this.lastAssistantUuid = null;
          }
          await this.createConversation(opts.skillName || "raw", opts.title);
        } else {
          log(`  💬 askAI: конверсация ${this.convUuid.slice(0, 8)}… (существующая)`);
        }

        const res = await this.sendUserMessage(question, code);
        deferredState.opts = { showReasoning, showToolLog, stripMarkdown: true };
        deferredState.active = true;
        deferredState.segments = [];
        deferredState.toolCalls = [];
        deferredState.cursor = 0;
        deferredState.finished = false;
        deferredState.error = null;

        const bgPromise = this.bgLoop(res);
        if (opts.freshConv) {
          bgPromise.finally(() => {
            if (this.convUuid) return this.deleteConversation().catch(() => {});
          });
        }

        let wasDeferred = false;
        if (deferredMs > 0) {
          const winner = await Promise.race([
            bgPromise.then(() => "bg"),
            sleep(deferredMs).then(() => "timeout"),
          ]);
          wasDeferred = (winner === "timeout");
        } else {
          await bgPromise;
        }

        if (deferredState.error instanceof RetrySessionError) {
          throw deferredState.error;
        }
        if (deferredState.error && !wasDeferred) {
          log(`  ⚠️ bgLoop error: ${deferredState.error}`);
          throw new Error(typeof deferredState.error === "string" ? deferredState.error : "bgLoop завершился с ошибкой");
        }

        const segs = [...deferredState.segments];
        const toolCalls = [...deferredState.toolCalls];
        deferredState.cursor = deferredState.segments.length;

        let result = buildResult(segs, toolCalls, { showReasoning, showToolLog, stripMarkdown: true });
        if (!result && !wasDeferred) {
          if (toolCalls.length > 0) {
            result = "⚠️ Модель исчерпала лимит итераций инструментов. Финальный ответ не получен.\n"
              + (showToolLog ? `🔧 Использованы инструменты: ${[...new Set(toolCalls.map(t => t.name))].join(", ")}\n` : "");
          } else {
            throw new Error("AI не вернул текстовый ответ");
          }
        }

        log(`  💬 askAI: ответ (${result.length} символов${wasDeferred ? ", deferred" : ""})`);
        trace("askAI_result", { length: result.length, answerPreview: result.slice(0, 500), toolCalls: toolCalls.map(t => t.name), wasDeferred });
        return { text: result, deferred: wasDeferred };
      } catch (err) {
        if (err instanceof RetrySessionError && attempt === 0) {
          log(`  🔄 Пересоздание сессии (попытка 2)...`);
          this.convUuid = null;
          this.lastAssistantUuid = null;
          continue;
        }
        throw err;
      }
    }
  }

  async deleteConversation() {
    if (!this.convUuid) return;
    const uuid = this.convUuid;
    this.convUuid = null;
    removeConversation(uuid);
    const sid = await getSession();
    await fetch(`${BASE_URL}/chat_api/v1/conversations/${uuid}`, {
      method: "DELETE",
      headers: edtHeaders(sid),
    });
  }
}

/**
 * Форматирует финальный ответ из массива сегментов.
 * tool_result — не показываем (эхо тула)
 * content — основной ответ модели
 * boundary — граница, влияет на layout
 * reasoning — показываем/скрываем по showReasoning
 */
function cleanToolText(text) {
  return text
    .replace(/&nbsp;?/gi, "")
    .replace(/Выполнить\s+\*{1,3}[^*]+\*{1,3}:\s*/g, "")
    .replace(/- _?Ищем_?:\s*/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function formatToolEntry(name, requestText, responseText, details, { stripMarkdown, TOOL_ICONS, TOOL_LABELS, SEARCH_BASE }) {
  const label = TOOL_LABELS[name] || name.replace(/^mcp__[^_]+__/, "");
  const icon = TOOL_ICONS[name] || "🛠️";
  let line = `${icon} **${label}**`;
  if (requestText) {
    let text = cleanToolText(requestText);
    if (stripMarkdown) text = text.replace(/\*\*/g, "");
    line += `: ${text}`;
  }
  if (responseText) {
    let text = cleanToolText(responseText);
    if (stripMarkdown) text = text.replace(/\*\*/g, "");
    line += ` → ${text}`;
  }
  if (details?.response_details?.length) {
    const searchBase = SEARCH_BASE[name];
    const docs = details.response_details.map(d => {
      if (d.includes("](")) return d;
      if (searchBase) return `[${d}](${searchBase}${d})`;
      return d;
    });
    line += `\n  - ${docs.join("\n  - ")}`;
  }
  return line;
}

function buildResult(allSegments, toolCalls, { showReasoning, showToolLog, stripMarkdown = false }) {
  const segmentParts = [];

  const TOOL_ICONS = {
    "Read": "📄",
    "Write": "📝",
    "Edit": "📝",
    "Delete": "🗑️",
    "Execute": "⚡",
    "Glob": "🧩",
    "List": "📂",
    "SearchFiles": "🔎",
    "SearchText": "📜",
    "Find": "🔎",
    "mcp__knowledge-hub__Search_Documentation": "📖",
    "mcp__knowledge-hub__Search_ITS": "🔍",
    "mcp__knowledge-hub__Fetch_ITS": "📥",
    "mcp__knowledge-hub__Diff_Documentation_Versions": "🔄",
    "mcp__syntax-checker__validate": "✅",
    "mcp__web__fetch": "🌐",
    "FindRelated_in_Project": "🔗",
    "GetObject_in_Project": "🎯",
    "FindSimilar_in_Project": "👥",
    "Task": "📋",
  };
  const TOOL_LABELS = {
    "mcp__knowledge-hub__Search_Documentation": "Поиск в документации",
    "mcp__knowledge-hub__Search_ITS": "Поиск в ИТС",
    "mcp__knowledge-hub__Fetch_ITS": "Загрузка ИТС",
    "mcp__knowledge-hub__Diff_Documentation_Versions": "Сравнение версий документации",
    "mcp__syntax-checker__validate": "Проверка синтаксиса",
    "FindRelated_in_Project": "Поиск связанного кода",
    "GetObject_in_Project": "Получение объекта метаданных",
    "FindSimilar_in_Project": "Поиск похожего кода",
  };
  const SEARCH_BASE = {
    "mcp__knowledge-hub__Search_Documentation": "https://code.1c.ai/doc/search?q=",
  };
  const fmtOpts = { stripMarkdown, TOOL_ICONS, TOOL_LABELS, SEARCH_BASE };

  // Pass 1: collect tool info from boundaries + tool results by call_id
  const callArgs = new Map();
  for (const tc of toolCalls || []) {
    if (tc.id) callArgs.set(tc.id, tc.args);
  }
  const calls = new Map();
  const toolLastIdx = new Map();
  const toolResultsByCallId = new Map();
  const rawToolBuffer = new Map();

  for (let i = 0; i < allSegments.length; i++) {
    const seg = allSegments[i];
    if (seg.type === "boundary" && seg.renderInfo) {
      for (const r of seg.renderInfo) {
        const id = r.tool_call_id;
        if (!id) continue;
        if (!calls.has(id)) calls.set(id, { name: r.tool_name, request: null, response: null, details: null });
        const entry = calls.get(id);
        if (callArgs.has(id)) entry.request = callArgs.get(id);
        else if (r.request_markdown && !entry.request) entry.request = r.request_markdown;
        if (r.response_markdown && !entry.response) entry.response = r.response_markdown;
        if (r.details) entry.details = r.details;
        toolLastIdx.set(id, i);
      }
    }
    if (seg.type === "tool_result") {
      if (seg.toolCallId) {
        if (!toolResultsByCallId.has(seg.toolCallId)) toolResultsByCallId.set(seg.toolCallId, []);
        toolResultsByCallId.get(seg.toolCallId).push(seg.text);
      } else {
        const key = seg.toolName || "__unknown";
        if (!rawToolBuffer.has(key)) rawToolBuffer.set(key, []);
        rawToolBuffer.get(key).push(seg.text);
      }
    }
  }

  // Pass 2: build output
  for (let i = 0; i < allSegments.length; i++) {
    const seg = allSegments[i];
    switch (seg.type) {
      case "content":
        if (seg.text) {
          const prevRaw = i > 0 ? allSegments[i - 1] : null;
          if (prevRaw?.type === "content" && segmentParts.length > 0) {
            segmentParts[segmentParts.length - 1] += seg.text;
          } else {
            segmentParts.push(`🤖 ${seg.text}`);
          }
        }
        break;
      case "reasoning":
        if (showReasoning && seg.text) {
          const arr = seg.text.split("\n");
          const formatted = arr.map((l, i) => i === 0 ? `> 💭 ${l}` : `> ${l}`).join("\n");
          segmentParts.push(formatted);
        }
        break;
      case "boundary":
        if (seg.renderInfo) {
          for (const r of seg.renderInfo) {
            const id = r.tool_call_id;
            if (!id) continue;
            if (toolLastIdx.get(id) !== i) continue;
            const name = r.tool_name;
            if (name === "mcp__knowledge-hub__Fetch_ITS" || name === "TodoWrite") continue;
            const entry = calls.get(id);
            if (!entry) continue;
            if (showToolLog) {
              segmentParts.push(formatToolEntry(name, entry.request, entry.response, entry.details, fmtOpts));
              if (toolResultsByCallId.has(id)) {
                for (const t of toolResultsByCallId.get(id)) segmentParts.push(`🔧 ${t}`);
              }
              if (rawToolBuffer.has(name)) {
                for (const t of rawToolBuffer.get(name)) segmentParts.push(`🔧 ${t}`);
                rawToolBuffer.delete(name);
              }
            } else {
              segmentParts.push(formatToolEntry(name, entry.request, null, null, fmtOpts));
            }
          }
        }
        break;
    }
  }

  if (showToolLog) {
    for (const texts of rawToolBuffer.values()) {
      for (const t of texts) segmentParts.push(`🔧 ${t}`);
    }
  }

  return segmentParts.join("\n\n") || "";
}
