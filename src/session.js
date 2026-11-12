import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { SESSION_FILE } from "./config.js";

export class RetrySessionError extends Error {
  constructor(msg) { super(msg || "Retry session"); this.name = "RetrySessionError"; }
}

let knownConversations = []; // { uuid, title?, skill?, created_at? }
let askConv = null; // { uuid, lastAssistantUuid } — персистентный Ask-чат

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function loadSessionCache() {
  try {
    if (existsSync(SESSION_FILE)) {
      const data = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
      if (Array.isArray(data.conversations)) knownConversations = data.conversations;
      if (data.askConv) askConv = data.askConv;
    }
  } catch { /* ignore */ }
}

function saveSessionCache() {
  try {
    writeFileSync(SESSION_FILE, JSON.stringify({ askConv, conversations: knownConversations }), "utf8");
  } catch { /* ignore */ }
}

export function resetSession() {
  askConv = null;
  knownConversations = [];
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
  const askSkills = new Set(["custom"]);
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
