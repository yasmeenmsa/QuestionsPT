import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join, extname } from "path";
import { createHash, randomBytes, randomUUID } from "crypto";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = join(import.meta.dir, "data");
const PUBLIC_DIR = join(import.meta.dir, "public");
const QUESTIONS_PATH = join(DATA_DIR, "questions.json");
const USERS_DIR = join(DATA_DIR, "users");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const ACCOUNTS_PATH = join(DATA_DIR, "accounts.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const SESSION_COOKIE = "ptexam_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(USERS_DIR)) mkdirSync(USERS_DIR, { recursive: true });
if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });

function writeJsonAtomic(path, value) {
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(tempPath, path);
}

function readAccounts() {
  if (!existsSync(ACCOUNTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function publicUser(account) {
  return { id: account.id, username: account.username, displayName: account.displayName || account.username };
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function validUsername(username) {
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username);
}

function findAccountById(userId) {
  return Object.values(readAccounts()).find((account) => account.id === userId) || null;
}

function sessionHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  writeJsonAtomic(join(SESSIONS_DIR, `${sessionHash(token)}.json`), {
    userId,
    expiresAt: Date.now() + SESSION_MAX_AGE * 1000
  });
  return token;
}

function sessionToken(req) {
  const cookies = req.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return null;
}

function authenticatedAccount(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const path = join(SESSIONS_DIR, `${sessionHash(token)}.json`);
  if (!existsSync(path)) return null;
  try {
    const session = JSON.parse(readFileSync(path, "utf8"));
    if (session.expiresAt < Date.now()) {
      unlinkSync(path);
      return null;
    }
    return findAccountById(session.userId);
  } catch {
    return null;
  }
}

function sessionCookie(req, token, maxAge = SESSION_MAX_AGE) {
  const secure = process.env.NODE_ENV === "production" || req.headers.get("x-forwarded-proto") === "https";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function authResponse(req, account) {
  return Response.json(
    { user: publicUser(account) },
    { headers: { "Set-Cookie": sessionCookie(req, createSession(account.id)) } }
  );
}

const loginFailures = new Map();

function loginBlocked(username) {
  const entry = loginFailures.get(username);
  if (!entry) return false;
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) return true;
  if (entry.blockedUntil) loginFailures.delete(username);
  return false;
}

function recordLoginFailure(username) {
  const entry = loginFailures.get(username) || { count: 0, blockedUntil: 0 };
  entry.count++;
  if (entry.count >= 10) {
    entry.blockedUntil = Date.now() + 15 * 60 * 1000;
    entry.count = 0;
  }
  loginFailures.set(username, entry);
}

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
  return authenticatedAccount(req)?.id || null;
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
    return initial;
  }
  try {
    return JSON.parse(readFileSync(progressPath, "utf8"));
  } catch (e) {
    return { updatedAt: new Date().toISOString(), targetTotal: 550, records: {}, studyStats: { totalStudySeconds: 0, completedBlocks: [], breakCount: 0 } };
  }
}

function writeProgress(userId, data) {
  const next = {
    ...data,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(join(USERS_DIR, `${userId}.json`), next);
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

    if (pathname === "/api/auth/me" && req.method === "GET") {
      const account = authenticatedAccount(req);
      return Response.json({ user: account ? publicUser(account) : null });
    }

    if (pathname === "/api/auth/register" && req.method === "POST") {
      try {
        const body = await req.json();
        const username = normalizeUsername(body.username);
        const password = String(body.password || "");
        const displayName = String(body.displayName || username).trim().slice(0, 60);
        if (!validUsername(username)) {
          return Response.json({ error: "Username must be 3–32 characters: letters, numbers, dots, dashes, or underscores." }, { status: 400 });
        }
        if (password.length < 8 || password.length > 128) {
          return Response.json({ error: "Password must be 8–128 characters." }, { status: 400 });
        }
        const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
        const accounts = readAccounts();
        if (accounts[username]) return Response.json({ error: "That username is already registered." }, { status: 409 });
        const account = {
          id: randomUUID(),
          username,
          displayName: displayName || username,
          passwordHash,
          createdAt: new Date().toISOString()
        };
        writeJsonAtomic(ACCOUNTS_PATH, { ...accounts, [username]: account });
        writeProgress(account.id, readProgress(account.id));
        return authResponse(req, account);
      } catch {
        return Response.json({ error: "Could not create the account." }, { status: 400 });
      }
    }

    if (pathname === "/api/auth/login" && req.method === "POST") {
      try {
        const body = await req.json();
        const username = normalizeUsername(body.username);
        const password = String(body.password || "");
        if (loginBlocked(username)) {
          return Response.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
        }
        const account = readAccounts()[username];
        const valid = account && await Bun.password.verify(password, account.passwordHash);
        if (!valid) {
          recordLoginFailure(username);
          return Response.json({ error: "Incorrect username or password." }, { status: 401 });
        }
        loginFailures.delete(username);
        return authResponse(req, account);
      } catch {
        return Response.json({ error: "Could not sign in." }, { status: 400 });
      }
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const token = sessionToken(req);
      if (token) {
        const path = join(SESSIONS_DIR, `${sessionHash(token)}.json`);
        if (existsSync(path)) unlinkSync(path);
      }
      return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(req, "", 0) } });
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
      if (!userId) return Response.json({ error: "Sign in required" }, { status: 401 });
      return Response.json(readProgress(userId));
    }

    if (pathname === "/api/progress" && req.method === "POST") {
      const userId = getUserId(req);
      if (!userId) return Response.json({ error: "Sign in required" }, { status: 401 });
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
