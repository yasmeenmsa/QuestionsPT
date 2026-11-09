// Sends exam questions as Telegram voice notes using Microsoft's en-GB-SoniaNeural voice.
// Requires: edge-tts on PATH (pip install edge-tts), ffmpeg, and TELEGRAM_BOT_TOKEN.
// The bot can only message a chat that has started it once, so press Start in Telegram first.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE_DIR = join(ROOT, ".telegram-voice");
const STATE_PATH = join(ROOT, ".telegram-sent.json");
const VOICE = process.env.TELEGRAM_VOICE || "en-GB-SoniaNeural";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const examFilter = option("exam", "");
const limit = Number(option("limit", "0")) || 0;
const fromNumber = Number(option("from", "1")) || 1;
const toNumber = Number(option("to", "0")) || Infinity;
const dryRun = flag("dry-run");
const listChatsOnly = flag("list-chats");
const reveal = flag("reveal");

if (!TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN in the environment. Never commit the token.");
  process.exit(1);
}

async function telegram(method, payload) {
  const response = await fetch(API(method), { method: "POST", body: payload });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || "request failed"}`);
  return data.result;
}

async function discoverChat() {
  const configured = process.env.TELEGRAM_CHAT_ID;
  if (configured) return configured;
  const updates = await telegram("getUpdates", undefined);
  const chats = new Map();
  for (const update of updates) {
    const chat = update.message?.chat || update.channel_post?.chat;
    if (chat) chats.set(String(chat.id), chat);
  }
  if (listChatsOnly) {
    if (!chats.size) console.log("No chats yet. Open the bot in Telegram and press Start.");
    for (const chat of chats.values()) {
      console.log(`${chat.id}\t${chat.type}\t${chat.username || chat.title || chat.first_name || ""}`);
    }
    return null;
  }
  if (chats.size > 1) {
    console.error("Several chats found; set TELEGRAM_CHAT_ID to pick one:");
    for (const chat of chats.values()) console.error(`  ${chat.id}  ${chat.username || chat.title || chat.first_name || ""}`);
    process.exit(1);
  }
  const only = [...chats.values()][0];
  if (!only) {
    console.error("No chat found. Open t.me/<your bot> in Telegram, press Start, then run again.");
    process.exit(1);
  }
  return only.id;
}

function buildText(question) {
  const lines = [`${question.exam || "Exam"} question ${question.number}.`, question.stem];
  question.options.forEach((option, index) => lines.push(`Option ${index + 1}. ${option}`));
  if (reveal) {
    lines.push(`Correct answer: option ${question.correctAnswer}, ${question.options[question.correctAnswer - 1]}.`);
    if (question.overview) lines.push(question.overview);
    if (question.rationales?.length) {
      lines.push("Rationales.");
      question.rationales.forEach((rationale, index) => lines.push(`Option ${index + 1}. ${rationale}`));
    }
  }
  return lines.join(" ");
}

async function synthesize(text, basePath) {
  const mp3 = `${basePath}.mp3`;
  const ogg = `${basePath}.ogg`;
  const edgeTts = process.env.EDGE_TTS || "edge-tts";
  await run(edgeTts, ["--voice", VOICE, "--text", text, "--write-media", mp3]);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", mp3, "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", ogg]);
  return ogg;
}

async function main() {
  const questions = JSON.parse(readFileSync(join(ROOT, "data", "questions.json"), "utf8"));
  const selected = questions.filter((question) => {
    if (examFilter && question.exam !== examFilter) return false;
    if (question.number < fromNumber || question.number > toNumber) return false;
    return true;
  });
  const batch = limit ? selected.slice(0, limit) : selected;
  if (!batch.length) {
    console.error("No questions matched those filters.");
    process.exit(1);
  }

  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const sent = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {};
  const chatId = dryRun ? "dry-run" : await discoverChat();
  if (!chatId) return;

  let count = 0;
  for (const question of batch) {
    const key = `${question.id}:${reveal ? "revealed" : "stem"}`;
    if (sent[key]) continue;
    const base = join(CACHE_DIR, `${question.id}${reveal ? "-revealed" : ""}`);
    const ogg = await synthesize(buildText(question), base);
    if (dryRun) {
      console.log(`[dry-run] ${question.id} -> ${ogg}`);
      continue;
    }
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("voice", new Blob([readFileSync(ogg)], { type: "audio/ogg" }), `${question.id}.ogg`);
    form.set("caption", `${question.exam || "Exam"} · Q${question.number}`);
    await telegram("sendVoice", form);
    sent[key] = new Date().toISOString();
    writeFileSync(STATE_PATH, JSON.stringify(sent, null, 2));
    count++;
    console.log(`sent ${question.id}`);
    await new Promise((done) => setTimeout(done, 400));
  }
  console.log(dryRun ? `dry run: ${batch.length} question(s) prepared` : `sent ${count} voice note(s) to ${chatId}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
