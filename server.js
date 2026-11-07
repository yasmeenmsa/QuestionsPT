import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, extname } from "path";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = join(import.meta.dir, "data");
const PUBLIC_DIR = join(import.meta.dir, "public");
const QUESTIONS_PATH = join(DATA_DIR, "questions.json");
const USERS_DIR = join(DATA_DIR, "users");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(USERS_DIR)) mkdirSync(USERS_DIR, { recursive: true });
if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });

function readQuestions() {
  if (!existsSync(QUESTIONS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(QUESTIONS_PATH, "utf8"));
  } catch (e) {
    console.error("Failed reading questions.json:", e);
    return [];
  }
}

function writeQuestions(questions) {
  // Auto-assign block (1..4, 140 questions per block) if missing
  const normalized = questions.map((q, idx) => {
    const num = Number(q.number ?? idx + 1);
    const computedBlock = Math.min(4, Math.floor((idx) / 140) + 1);
    return {
      id: q.id || `ptexam-q${num}-${idx + 1}`,
      number: num,
      exam: q.exam || "PTEXAM",
      chapter: q.chapter || "Physiotherapy Review",
      block: q.block || computedBlock,
      stem: q.stem || "",
      image: q.image || null,
      options: Array.isArray(q.options) ? q.options : [],
      correctAnswer: Number(q.correctAnswer || 1),
      citation: q.citation || "",
      overview: q.overview || "",
      rationales: Array.isArray(q.rationales) ? q.rationales : [],
      system: q.system || "General Physiotherapy",
      contentOutline: q.contentOutline || "Examination / Interventions",
      level: q.level || "Level 2",
      oneLineFact: q.oneLineFact || ""
    };
  });
  writeFileSync(QUESTIONS_PATH, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function getUserId(req) {
  const userId = req.headers.get("x-study-user") || "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)
    ? userId
    : null;
}

function readProgress(userId) {
  const progressPath = join(USERS_DIR, `${userId}.json`);
  if (!existsSync(progressPath)) {
    const initial = {
      updatedAt: new Date().toISOString(),
      targetTotal: 550,
      records: {}, // questionId -> { selectedOption, status: 'knew' | 'guessed' | 'wrong', timeSpentSec, notes, attempts, updatedAt }
      studyStats: {
        totalStudySeconds: 0,
        completedBlocks: [],
        breakCount: 0
      }
    };
    writeFileSync(progressPath, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
  try {
    return JSON.parse(readFileSync(PROGRESS_PATH, "utf8"));
  } catch (e) {
    return { updatedAt: new Date().toISOString(), targetTotal: 550, records: {}, studyStats: { totalStudySeconds: 0, completedBlocks: [], breakCount: 0 } };
  }
}

function writeProgress(userId, data) {
  const next = {
    ...data,
    updatedAt: new Date().toISOString()
  };
  writeFileSync(join(USERS_DIR, `${userId}.json`), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function adminAuthorized(req) {
  if (ADMIN_TOKEN) return req.headers.get("authorization") === `Bearer ${ADMIN_TOKEN}`;
  return process.env.NODE_ENV !== "production";
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/api/health") {
      return Response.json({ ok: true, status: "ready", questionCount: readQuestions().length });
    }

    if (pathname === "/api/questions" && req.method === "GET") {
      return Response.json({ questions: readQuestions() });
    }

    if (pathname === "/api/questions" && req.method === "POST") {
      if (!adminAuthorized(req)) return Response.json({ ok: false, error: "Admin authorization required" }, { status: 403 });
      try {
        const body = await req.json();
        const existing = readQuestions();
        const incoming = Array.isArray(body.questions) ? body.questions : (body.question ? [body.question] : []);
        const mode = body.mode || "append"; // "append" | "replace"
        let merged = mode === "replace" ? incoming : [...existing];
        if (mode !== "replace") {
          for (const item of incoming) {
            const idx = merged.findIndex((q) => (item.id && q.id === item.id) || (item.number && q.number === item.number && q.exam === (item.exam || "PTEXAM ONE")));
            if (idx >= 0) merged[idx] = { ...merged[idx], ...item };
            else merged.push(item);
          }
        }
        const saved = writeQuestions(merged);
        return Response.json({ ok: true, questions: saved });
      } catch (e) {
        return Response.json({ ok: false, error: String(e.message || e) }, { status: 400 });
      }
    }

    if (pathname.startsWith("/api/questions/") && req.method === "DELETE") {
      if (!adminAuthorized(req)) return Response.json({ ok: false, error: "Admin authorization required" }, { status: 403 });
      const id = decodeURIComponent(pathname.replace("/api/questions/", ""));
      const existing = readQuestions().filter((q) => q.id !== id);
      const saved = writeQuestions(existing);
      return Response.json({ ok: true, questions: saved });
    }

    if (pathname === "/api/progress" && req.method === "GET") {
      const userId = getUserId(req);
      if (!userId) return Response.json({ error: "Valid x-study-user header required" }, { status: 400 });
      return Response.json(readProgress(userId));
    }

    if (pathname === "/api/progress" && req.method === "POST") {
      const userId = getUserId(req);
      if (!userId) return Response.json({ error: "Valid x-study-user header required" }, { status: 400 });
      try {
        const body = await req.json();
        const current = readProgress(userId);
        const mergedRecords = body.replaceAll
          ? (body.records || {})
          : { ...current.records, ...(body.records || {}) };
        const next = writeProgress(userId, {
          ...current,
          targetTotal: body.targetTotal || current.targetTotal || 550,
          records: mergedRecords,
          studyStats: {
            ...current.studyStats,
            ...(body.studyStats || {})
          }
        });
        return Response.json(next);
      } catch (e) {
        return Response.json({ ok: false, error: String(e.message || e) }, { status: 400 });
      }
    }

    // Serve static files from public/
    const filePath = join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
    if (existsSync(filePath)) {
      const ext = extname(filePath).toLowerCase();
      return new Response(Bun.file(filePath), {
        headers: {
          "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
          "Cache-Control": "no-cache"
        }
      });
    }

    return new Response(Bun.file(join(PUBLIC_DIR, "index.html")), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
});

console.log(`PTEXAM 2-Day Study App listening on http://0.0.0.0:${server.port}`);
