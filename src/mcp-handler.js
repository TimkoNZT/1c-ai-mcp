import { EDT_TOOLS } from "./config.js";
import { log } from "./logger.js";
import { loadSessionCache, getAllConversations, clearConversations, clearToolConversations, saveAskConv, getAskConv, clearAskConv } from "./session.js";
import { ChatClient, getJobResult, activeJob, dropJobs } from "./chat-client.js";
import { deleteConversationRequest } from "./transport.js";
const DEFERRED_MSG = "⚠️ **Модель не закончила вывод.** Подожди несколько секунд и вызови **GetResult**";
let toolQueue = Promise.resolve();

// Один ChatClient для последовательных Ask (пока не вызван NewChat)
let askClient = null;

function mcpRespond(id, result, error) {
  const msg = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function callMcpTool(toolName, toolContent) {
  return await (toolQueue = toolQueue.then(() => _callMcpTool(toolName, toolContent)));
}

async function resetAskChat() {
  // Сброс ask-сессии: старые задания и диалог больше не нужны.
  dropJobs(job => job.kind === "ask");
  if (askClient) {
    await askClient.deleteConversation().catch(() => {});
    askClient = null;
  }
  clearAskConv();
}

async function _callMcpTool(toolName, toolContent) {
  switch (toolName) {
    case "Ask": {
      if (toolContent?.newChat !== false) {
        await resetAskChat();
      } else {
        const running = activeJob("ask");
        if (running) {
          return `⚠️ Предыдущий запрос ещё выполняется. request_id: ${running.id}. Вызови **GetResult** с этим id.`;
        }
      }
      if (!askClient) {
        askClient = new ChatClient();
        const cached = getAskConv();
        if (cached) askClient.restoreConv(cached.uuid, cached.lastAssistantUuid);
      }
      const result = await chatTool(askClient, toolName, toolContent, false);
      const state = askClient.getConvState();
      if (state) saveAskConv(state.uuid, state.lastAssistantUuid);
      if (result.deferred) {
        return `${DEFERRED_MSG}\n\nrequest_id: ${result.jobId}\n\n${result.text}`.trim();
      }
      return result.text;
    }

    case "ReviewCode":
    case "FixCode":
    case "ExplainCode": {
      const client = new ChatClient();
      const result = await chatTool(client, toolName, toolContent, true);
      if (result.deferred) {
        return `${DEFERRED_MSG}\n\nrequest_id: ${result.jobId}\n\n${result.text}`.trim();
      }
      return result.text;
    }

    // case "NewChat": {
    //   await resetAskChat();
    //   return "Новый чат создан";
    // }

    case "GetResult": {
      const res = await getJobResult({
        requestId: toolContent?.request_id,
        waitSeconds: toolContent?.wait_seconds,
      });
      if (!res) return "Нет активного отложенного запроса. Используй Ask / ReviewCode / FixCode / ExplainCode, и если модель не уложится в 30с, вызывай GetResult.";
      if (res.error) throw res.error;
      if (!res.text && res.finished) return "✅ Модель закончила ответ.";
      return res.text;
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function chatTool(client, toolName, toolContent, freshConv) {
  const code = toolContent?.code;
  const question = toolContent?.question || "";

  const skillMap = {
    "Ask": "custom",
    "ReviewCode": "review",
    "FixCode": "modify",
    "ExplainCode": "explain",
  };
  const skillName = skillMap[toolName] || "custom";

  const defaultInstruction = {
    "ReviewCode": "Проведи ревью кода: ошибки, проблемы производительности, нарушения стандартов. Перечисли замечания по пунктам со строками. НЕ исправляй код.",
    "FixCode": "Найди и исправь ошибки в коде. Верни исправленный код целиком и кратко поясни изменения.",
    "ExplainCode": "Объясни, что делает код: назначение, логику по шагам, ключевые переменные. Простым языком. НЕ исправляй и НЕ ищи ошибки.",
  }[toolName] || "";

  const snippet = (code || question || "").replace(/\s+/g, " ").slice(0, 30);
  const titleMap = {
    "Ask": question ? `💬 [MCP] ${snippet}${snippet.length >= 30 ? "…" : ""}` : "💬 [MCP] Новый диалог",
    "ReviewCode": `🔍 [MCP] ReviewCode: ${snippet}${snippet.length >= 30 ? "…" : ""}`,
    "FixCode": `🔧 [MCP] FixCode: ${snippet}${snippet.length >= 30 ? "…" : ""}`,
    "ExplainCode": `📖 [MCP] ExplainCode: ${snippet}${snippet.length >= 30 ? "…" : ""}`,
  };
  const title = titleMap[toolName] || `🛠 [MCP] ${toolName}`;

  const opts = {
    showReasoning: toolContent?.showReasoning,
    showToolLog: toolContent?.showToolLog ?? (toolName === "Ask" ? false : true),
    showContext: toolName === "Ask",
    kind: toolName === "Ask" ? "ask" : "tool",
    skillName,
    freshConv,
    title,
    deferredMs: 30000,
  };

  const instruction = question || defaultInstruction;
  return await client.ask(instruction, code, opts);
}

async function cleanupOrphanedConversations() {
  const convs = getAllConversations();
  if (!convs.length) return;

  // Удаляем только tool-чаты. Ask (skill=custom) сохраняем.
  const ASK_SKILLS = new Set(["custom"]);
  const toolConvs = convs.filter(c => !ASK_SKILLS.has(c.skill));
  if (!toolConvs.length) return;

  log(`  🧹 Очистка ${toolConvs.length} осиротевших tool-конверсаций...`);
  for (const c of toolConvs) {
    try {
      try {
        await deleteConversationRequest(c.uuid);
        log(`    ✓ удалена: ${c.uuid.slice(0, 8)}… (${c.title || "без названия"})`);
      } catch (err) {
        if (err.status === 404) log(`    - уже удалена: ${c.uuid.slice(0, 8)}…`);
        else log(`    ? ${err.message}: ${c.uuid.slice(0, 8)}…`);
      }
    } catch { /* ignore network errors on cleanup */ }
  }
  clearToolConversations();
  log("  🧹 Очистка tool-конверсаций завершена");
}

export async function mcpMain() {
  loadSessionCache();

  // Очистка осиротевших конверсаций (после краша в прошлой сессии)
  // Блокируем обработку запросов до завершения очистки, чтобы избежать гонки
  await cleanupOrphanedConversations();

  let stdinBuf = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    stdinBuf += chunk;
    const lines = stdinBuf.split("\n");
    stdinBuf = lines.pop();
    for (const line of lines) {
      if (line.trim()) handleLine(line.trim());
    }
  });

  process.stdin.on("end", () => log("  stdin end"));
  process.stdin.resume();

  function handleLine(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      log(`MCP parse error: ${line.slice(0, 100)}`);
      return;
    }

    const { id, method, params } = req;
    if (id === null || id === undefined) {
      if (method === "notifications/initialized") log("MCP initialized");
      return;
    }

    try {
      switch (method) {
        case "initialize":
          mcpRespond(id, {
            protocolVersion: params?.protocolVersion || "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "1c-ai-mcp", version: "1.05" },
          });
          break;

        case "tools/list":
          mcpRespond(id, { tools: EDT_TOOLS });
          break;

        case "tools/call": {
          const { name, arguments: args } = params;
          if (!name) throw new Error("Missing tool name");
          return callMcpTool(name, args || {}).then((text) => {
            mcpRespond(id, { content: [{ type: "text", text }], isError: false });
          }).catch((err) => {
            log(`MCP tools/call error: ${err.message}`);
            if (err.message.includes("duplicate_token_usage") || err.message.includes("Token is already used")) {
              mcpRespond(id, { content: [{ type: "text", text: "❌ Сессия занята — токен используется в другом экземпляре. Закрой другой сеанс и повтори." }], isError: false });
            } else {
              mcpRespond(id, null, { code: -32603, message: err.message });
            }
          });
        }

        default:
          mcpRespond(id, null, { code: -32601, message: `Method not found: ${method}` });
      }
    } catch (err) {
      log(`MCP error: ${err.message}`);
      mcpRespond(id, null, { code: -32603, message: err.message });
    }
  }
}
