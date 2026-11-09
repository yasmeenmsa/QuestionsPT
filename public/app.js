const GUEST_STORAGE_KEY = "ptexam_550_progress_v1";
const ACCOUNT_STORAGE_PREFIX = "ptexam_550_account_progress_v1:";
const VOICE_STORAGE_KEY = "ptexam_550_voice_v1";
const LEGACY_QUESTION_IDS = {
  "ptexam1-q9": "ptexam-one-q9",
  "ptexam1-q10": "ptexam-one-q10",
  "ptexam1-q11": "ptexam-one-q11",
  "ptexam1-q12": "ptexam-one-q12"
};
let serverAvailable = false;

const state = {
  questions: [],
  records: {},
  currentUser: null,
  activeBlock: "all",
  activeStatus: "all",
  activeSystem: "all",
  viewMode: "single",
  currentIndex: 0,
  questionSeconds: 0,
  sessionSecondsRemaining: 60 * 60,
  sessionPaused: false,
  breakActive: false,
  breakSecondsRemaining: 10 * 60,
  nightDrillActive: false,
  nightDrillSecondsRemaining: 30 * 60,
  voices: [],
  speakingQuestionId: null,
  speechToken: 0
};

function localProgressKey() {
  return state.currentUser ? `${ACCOUNT_STORAGE_PREFIX}${state.currentUser.id}` : GUEST_STORAGE_KEY;
}

function loadLocalProgress(key = localProgressKey()) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function saveLocalProgress() {
  try {
    localStorage.setItem(localProgressKey(), JSON.stringify({
      updatedAt: new Date().toISOString(),
      records: state.records
    }));
  } catch (error) {
    console.warn("Local progress save failed", error);
  }
}

async function syncProgressToServer(replaceAll = false) {
  saveLocalProgress();
  const badge = document.getElementById("sync-status-badge");
  if (!serverAvailable || !state.currentUser) {
    if (badge) badge.textContent = "● Saved on this device";
    return;
  }
  if (badge) badge.textContent = "↻ Saving...";
  try {
    const response = await fetch("./api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replaceAll, records: state.records })
    });
    if (response.status === 401) {
      showSignedOutState("Your session expired. Sign in again to sync.");
      return;
    }
    if (!response.ok) throw new Error("Progress save failed");
    if (badge) badge.textContent = "● Synced to your account";
  } catch {
    if (badge) badge.textContent = "● Saved on this device";
  }
}

function mergeRecords(...sources) {
  const merged = {};
  for (const records of sources) {
    for (const [questionId, record] of Object.entries(records || {})) {
      const currentId = LEGACY_QUESTION_IDS[questionId] || questionId;
      if (!merged[currentId] || (record.updatedAt || "") > (merged[currentId].updatedAt || "")) {
        merged[currentId] = record;
      }
    }
  }
  return merged;
}

function updateAuthUI() {
  const loginRequired = serverAvailable && !state.currentUser;
  document.getElementById("study-main").classList.toggle("hidden", loginRequired);
  document.querySelector(".protocol-strip").classList.toggle("hidden", loginRequired);
  document.getElementById("auth-modal-backdrop").classList.toggle("hidden", !loginRequired);
  document.getElementById("account-button").classList.toggle("hidden", !serverAvailable);
  document.getElementById("logout-button").classList.toggle("hidden", !state.currentUser);
  document.getElementById("account-button").textContent = state.currentUser
    ? `👤 ${state.currentUser.displayName}`
    : "Sign in to sync";
  if (!serverAvailable) setText("sync-status-badge", "● Saved on this device");
  else if (state.currentUser) setText("sync-status-badge", "● Synced to your account");
  else setText("sync-status-badge", "Sign in to sync phone + PC");
}

function showSignedOutState(message = "") {
  state.currentUser = null;
  state.records = loadLocalProgress(GUEST_STORAGE_KEY)?.records || {};
  updateAuthUI();
  renderAll();
  if (message) showAuthError(message);
}

function showAuthError(message = "") {
  const error = document.getElementById("auth-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

async function loadAuthenticatedProgress() {
  const response = await fetch("./api/progress");
  if (!response.ok) throw new Error("Could not load your saved progress");
  const progress = await response.json();
  const accountLocal = loadLocalProgress()?.records || {};
  const guestLocal = loadLocalProgress(GUEST_STORAGE_KEY)?.records || {};
  state.records = mergeRecords(progress.records, accountLocal, guestLocal);
  if (Object.keys(guestLocal).length) {
    localStorage.removeItem(GUEST_STORAGE_KEY);
    await syncProgressToServer(false);
  } else if (Object.keys(accountLocal).length) {
    await syncProgressToServer(false);
  } else {
    saveLocalProgress();
  }
}

async function submitAuth(mode) {
  showAuthError();
  const register = mode === "register";
  const submit = document.getElementById(register ? "register-submit" : "login-submit");
  submit.disabled = true;
  try {
    const response = await fetch(`./api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(register ? {
        displayName: valueOf("register-name"),
        username: valueOf("register-username"),
        password: document.getElementById("register-password").value
      } : {
        username: valueOf("login-username"),
        password: document.getElementById("login-password").value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not sign in");
    state.currentUser = data.user;
    await loadAuthenticatedProgress();
    document.getElementById("login-form").reset();
    document.getElementById("register-form").reset();
    updateAuthUI();
    renderAll();
  } catch (error) {
    showAuthError(error.message);
  } finally {
    submit.disabled = false;
  }
}

async function initApp() {
  serverAvailable = await fetch("./api/health")
    .then((response) => response.ok ? response.json() : null)
    .then((data) => Boolean(data?.ok))
    .catch(() => false);

  const questionData = serverAvailable
    ? await fetch("./api/questions").then((r) => r.json()).catch(() => ({ questions: [] }))
    : await fetch("./data/questions.json").then((r) => r.json()).then((questions) => ({ questions })).catch(() => ({ questions: [] }));
  const authData = serverAvailable
    ? await fetch("./api/auth/me").then((r) => r.json()).catch(() => ({ user: null }))
    : { user: null };

  state.questions = Array.isArray(questionData.questions) ? questionData.questions : [];
  state.currentUser = authData.user || null;
  if (state.currentUser) await loadAuthenticatedProgress();
  else state.records = loadLocalProgress(GUEST_STORAGE_KEY)?.records || {};

  populateSystemFilter();
  bindEvents();
  initVoiceReader();
  startTimers();
  updateAuthUI();
  renderAll();
}

function isMicrosoftVoice(voice) {
  return /^microsoft/i.test(voice.name);
}

function voiceRank(voice) {
  let score = 0;
  if (/natural|online/i.test(voice.name)) score += 4;
  if (/^en[-_]us/i.test(voice.lang)) score += 2;
  if (/aria|jenny|michelle|monica|ava|andrew|brian|emma|guy/i.test(voice.name)) score += 1;
  return score;
}

function pickBestMicrosoftVoice(voices) {
  return voices
    .filter(isMicrosoftVoice)
    .sort((a, b) => voiceRank(b) - voiceRank(a))[0] || null;
}

function resolveVoice() {
  const synth = window.speechSynthesis;
  const voices = state.voices.length ? state.voices : (synth ? synth.getVoices() : []);
  const saved = localStorage.getItem(VOICE_STORAGE_KEY) || "auto";
  if (saved !== "auto") {
    const chosen = voices.find((voice) => voice.name === saved);
    if (chosen) return chosen;
  }
  return pickBestMicrosoftVoice(voices) || voices.find((voice) => /^en[-_]/i.test(voice.lang)) || voices[0] || null;
}

function refreshVoiceOptions() {
  const select = document.getElementById("voice-select");
  if (!select) return;
  const synth = window.speechSynthesis;
  if (!synth) {
    select.innerHTML = `<option value="">Read-aloud unavailable</option>`;
    select.disabled = true;
    return;
  }
  const voices = synth.getVoices();
  state.voices = voices.slice().sort((a, b) => {
    const microsoftFirst = Number(isMicrosoftVoice(b)) - Number(isMicrosoftVoice(a));
    return microsoftFirst || voiceRank(b) - voiceRank(a) || a.name.localeCompare(b.name);
  });
  if (!voices.length) {
    select.innerHTML = `<option value="auto">Automatic voice</option>`;
    select.disabled = false;
    return;
  }
  const saved = localStorage.getItem(VOICE_STORAGE_KEY) || select.value || "auto";
  const microsoft = state.voices.filter(isMicrosoftVoice);
  const others = state.voices.filter((voice) => !isMicrosoftVoice(voice));
  const optionHtml = (voice) => `<option value="${escapeHtml(voice.name)}">${escapeHtml(voice.name)} — ${escapeHtml(voice.lang)}</option>`;
  const autoLabel = microsoft.length ? "Automatic (best Microsoft voice)" : "Automatic (best available voice)";
  let html = `<option value="auto">${autoLabel}</option>`;
  if (microsoft.length) html += `<optgroup label="Microsoft voices">${microsoft.map(optionHtml).join("")}</optgroup>`;
  if (others.length) html += `<optgroup label="${microsoft.length ? "Other voices" : "Available voices"}">${others.map(optionHtml).join("")}</optgroup>`;
  select.innerHTML = html;
  select.value = [...select.options].some((option) => option.value === saved) ? saved : "auto";
  select.disabled = false;
}

function setVoiceStatus(message = "") {
  const status = document.getElementById("voice-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("hidden", !message);
}

function buildQuestionSpeech(question, revealed) {
  const parts = [`${question.exam || "Exam"} question ${question.number}.`, question.stem];
  question.options.forEach((option, index) => parts.push(`Option ${index + 1}. ${option}`));
  if (revealed) {
    parts.push(`Correct answer: option ${question.correctAnswer}, ${question.options[question.correctAnswer - 1]}.`);
    if (question.overview) parts.push(question.overview);
    if (question.rationales?.length) {
      parts.push("Rationales.");
      question.rationales.forEach((rationale, index) => parts.push(`Option ${index + 1}. ${rationale}`));
    }
  }
  return parts.join(" ");
}

function splitForSpeech(text) {
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && (current + sentence).length > 280) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function stopSpeaking({ rerender = false } = {}) {
  state.speechToken++;
  state.speakingQuestionId = null;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (rerender) renderAll();
}

function speakChunk(chunks, index, token, voice) {
  if (token !== state.speechToken) return;
  if (index >= chunks.length) {
    state.speakingQuestionId = null;
    setVoiceStatus("Finished reading.");
    renderAll();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(chunks[index]);
  if (voice) utterance.voice = voice;
  utterance.rate = 0.98;
  utterance.onend = () => speakChunk(chunks, index + 1, token, voice);
  utterance.onerror = (event) => {
    if (token !== state.speechToken) return;
    state.speakingQuestionId = null;
    setVoiceStatus(event.error === "interrupted" || event.error === "canceled" ? "" : "Read-aloud stopped.");
    renderAll();
  };
  window.speechSynthesis.speak(utterance);
}

function toggleReadQuestion(questionId) {
  if (state.speakingQuestionId === questionId) {
    stopSpeaking({ rerender: true });
    setVoiceStatus("Read-aloud stopped.");
    return;
  }
  if (!window.speechSynthesis) {
    setVoiceStatus("Read-aloud is not supported in this browser. Open the app in Microsoft Edge to use Microsoft voices.");
    return;
  }
  const question = state.questions.find((item) => item.id === questionId);
  if (!question) return;
  stopSpeaking();
  const voice = resolveVoice();
  const revealed = Boolean(state.records[questionId]?.revealed);
  const chunks = splitForSpeech(buildQuestionSpeech(question, revealed));
  const token = ++state.speechToken;
  state.speakingQuestionId = questionId;
  renderAll();
  setVoiceStatus(`Reading with ${voice ? voice.name : "your browser's default voice"}.`);
  speakChunk(chunks, 0, token, voice);
}

function initVoiceReader() {
  const select = document.getElementById("voice-select");
  if (!select) return;
  refreshVoiceOptions();
  select.addEventListener("change", () => {
    localStorage.setItem(VOICE_STORAGE_KEY, select.value);
    stopSpeaking({ rerender: true });
    const voice = resolveVoice();
    setVoiceStatus(`Voice set to ${voice ? voice.name : "the browser default"}.`);
  });
  if (window.speechSynthesis) {
    window.speechSynthesis.addEventListener?.("voiceschanged", refreshVoiceOptions);
    [250, 1000, 2500].forEach((delay) => setTimeout(refreshVoiceOptions, delay));
  }
}

function populateSystemFilter() {
  const select = document.getElementById("system-filter-select");
  const current = select.value || "all";
  const systems = [...new Set(state.questions.map((q) => q.exam).filter(Boolean))].sort();
  select.innerHTML = `<option value="all">All Exams (${state.questions.length})</option>` +
    systems.map((system) => `<option value="${escapeHtml(system)}">${escapeHtml(system)}</option>`).join("");
  select.value = current === "all" || systems.includes(current) ? current : "all";
  state.activeSystem = select.value;
}

function getFilteredQuestions() {
  return state.questions.filter((question) => {
    if (state.activeBlock !== "all" && String(question.block) !== state.activeBlock) return false;
    if (state.activeSystem !== "all" && question.exam !== state.activeSystem) return false;
    const status = state.records[question.id]?.status;
    if (state.activeStatus === "unseen") return !status;
    if (state.activeStatus === "wrong") return status === "wrong";
    if (state.activeStatus === "weak") return status === "wrong" || status === "guessed";
    if (state.activeStatus === "knew") return status === "knew";
    return true;
  });
}

function renderAll() {
  updateDashboardStats();
  const filtered = getFilteredQuestions();
  if (state.currentIndex >= filtered.length) state.currentIndex = Math.max(0, filtered.length - 1);
  renderNavigator(filtered);
  renderQuestionsStage(filtered);
}

function updateDashboardStats() {
  const counts = { knew: 0, guessed: 0, wrong: 0, answered: 0 };
  const blockCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };

  for (const question of state.questions) {
    const block = question.block || 1;
    blockCounts[block] = (blockCounts[block] || 0) + 1;
    const status = state.records[question.id]?.status;
    if (counts[status] !== undefined) {
      counts[status]++;
      counts.answered++;
    }
  }

  const percent = state.questions.length ? Math.round((counts.answered / state.questions.length) * 100) : 0;
  setText("stat-loaded-count", state.questions.length);
  setText("stat-answered-sub", `${counts.answered} of ${state.questions.length} marked (${percent}%)`);
  setText("stat-knew-count", counts.knew);
  setText("stat-guessed-count", counts.guessed);
  setText("stat-wrong-count", counts.wrong);
  setText("night-wrong-badge", counts.wrong);
  setText("tab-count-all", state.questions.length);
  for (let block = 1; block <= 4; block++) setText(`tab-count-b${block}`, blockCounts[block] || 0);
}

function renderNavigator(filtered) {
  const previousButton = document.getElementById("prev-q-btn");
  const nextButton = document.getElementById("next-q-btn");
  const dotsContainer = document.getElementById("q-dots-container");

  if (!filtered.length) {
    setText("q-position-label", "0 Questions in Filter");
    previousButton.disabled = true;
    nextButton.disabled = true;
    dotsContainer.innerHTML = "";
    return;
  }

  const currentQuestion = filtered[state.currentIndex];
  setText("q-position-label", `Q#${currentQuestion.number} (${state.currentIndex + 1} of ${filtered.length})`);
  previousButton.disabled = state.currentIndex <= 0;
  nextButton.disabled = state.currentIndex >= filtered.length - 1;
  dotsContainer.innerHTML = filtered.map((question, index) => {
    const status = state.records[question.id]?.status;
    const classes = [
      "q-dot",
      status ? `status-${status}` : "",
      index === state.currentIndex ? "current" : ""
    ].join(" ");
    return `<button type="button" class="${classes}" data-jump-idx="${index}" aria-label="Go to question ${question.number}" title="Question ${question.number}">${question.number}</button>`;
  }).join("");
}

function renderQuestionsStage(filtered) {
  const container = document.getElementById("questions-container");
  container.className = `questions-stage ${state.viewMode === "two-col" ? "mode-two-col" : "mode-single"}`;

  if (!filtered.length) {
    container.innerHTML = `
      <div class="sb-card"><div class="sb-card-top">
        <h2 class="sb-question-title"><span class="sb-bullet"></span>No questions match this filter</h2>
        <p class="sb-stem-text">Switch back to <strong>All</strong> or select another Block above to continue studying.</p>
      </div></div>`;
    return;
  }

  const visible = state.viewMode === "single" ? [filtered[state.currentIndex]] : filtered;
  container.innerHTML = visible.map(renderQuestionCard).join("");
}

function renderQuestionCard(question) {
  const record = state.records[question.id] || {};
  const revealed = Boolean(record.revealed);
  const speaking = state.speakingQuestionId === question.id;
  const selectedOption = record.selectedOption || null;
  const status = record.status || null;
  const statusLabels = { knew: "✓ Knew It", guessed: "? Guessed", wrong: "✗ Wrong" };
  const statusBadge = status
    ? `<span class="sb-status-pill ${status}">${statusLabels[status]}</span>`
    : `<span class="sb-status-pill" style="background:#f3f4f6;color:#5a626a">Unmarked</span>`;
  const image = question.image
    ? `<img src="${escapeHtml(question.image)}" alt="Question ${question.number} clinical illustration" class="sb-stem-image" />`
    : "";

  const options = question.options.map((text, index) => {
    const optionNumber = index + 1;
    let className = "";
    if (revealed) {
      if (optionNumber === question.correctAnswer && selectedOption === optionNumber) className = "selected-correct";
      else if (selectedOption === optionNumber && optionNumber !== question.correctAnswer) className = "selected-wrong";
      else if (optionNumber === question.correctAnswer) className = "revealed-correct";
    }
    return `<li><button type="button" class="sb-option-btn ${className}" data-action="pick-option" data-qid="${escapeHtml(question.id)}" data-opt="${optionNumber}" aria-label="Option ${optionNumber}: ${escapeHtml(text)}"><span class="sb-option-num">${optionNumber}.</span><span>${escapeHtml(text)}</span></button></li>`;
  }).join("");

  const rationaleSource = question.rationales?.length ? question.rationales : question.options;
  const rationales = rationaleSource.map((text, index) => {
    const correct = index + 1 === question.correctAnswer;
    return `<li class="${correct ? "correct-rationale" : ""}">${escapeHtml(text)}</li>`;
  }).join("");
  const oneLineFact = question.oneLineFact
    ? `<div class="sb-one-line-box"><strong>⚡ 1-Line Exam Fact:</strong> ${escapeHtml(question.oneLineFact)}</div>`
    : "";

  return `
    <article class="sb-card" data-card-qid="${escapeHtml(question.id)}">
      <div class="sb-card-top">
        <div class="sb-heading-row">
          <h2 class="sb-question-title"><span class="sb-bullet"></span>${escapeHtml(question.exam || "PTEXAM ONE")}: QUESTION ${question.number}</h2>
          ${statusBadge}
        </div>
        <div class="sb-stem-wrap"><p class="sb-stem-text">${escapeHtml(question.stem)}</p>${image}</div>
        <ol class="sb-options-list">${options}</ol>
        <div class="sb-mark-bar">
          <div class="mark-buttons-group" role="group" aria-label="Mark confidence">
            <button type="button" class="mark-btn mark-knew ${status === "knew" ? "active" : ""}" data-action="mark-status" data-qid="${escapeHtml(question.id)}" data-status="knew">✓ Knew it</button>
            <button type="button" class="mark-btn mark-guessed ${status === "guessed" ? "active" : ""}" data-action="mark-status" data-qid="${escapeHtml(question.id)}" data-status="guessed">? Guessed</button>
            <button type="button" class="mark-btn mark-wrong ${status === "wrong" ? "active" : ""}" data-action="mark-status" data-qid="${escapeHtml(question.id)}" data-status="wrong">✗ Wrong</button>
          </div>
          <button type="button" class="btn-reveal-toggle" data-action="toggle-reveal" data-qid="${escapeHtml(question.id)}">${revealed ? "🙈 Cover Answer Key" : "👁️ Check Answer & Rationales"}</button>
          <button type="button" class="btn-reveal-toggle btn-voice" data-action="read-question" data-qid="${escapeHtml(question.id)}" aria-pressed="${speaking}" title="Read the question and options aloud. When the answer is showing, the correct answer and rationales are read too.">${speaking ? "⏹ Stop Reading" : "🔊 Read Aloud"}</button>
          ${selectedOption ? `<button type="button" class="btn-reveal-toggle" data-action="retry-question" data-qid="${escapeHtml(question.id)}">↻ Answer Again</button>` : ""}
        </div>
      </div>
      <div class="sb-answer-section ${revealed ? "" : "hidden"}">
        <div class="sb-correct-banner"><span>Correct Answer: ${question.correctAnswer}${question.citation ? ` (${escapeHtml(question.citation)})` : ""}</span><span>Block ${question.block || 1}</span></div>
        <div class="sb-rationale-body">
          ${question.overview ? `<p class="sb-overview-p">${escapeHtml(question.overview)}</p>` : ""}
          <ol class="sb-rationales-ol">${rationales}</ol>
          ${oneLineFact}
          <div class="sb-meta-footer">
            <div><div><strong>System:</strong> ${escapeHtml(question.system)}</div><div><strong>Content Outline:</strong> ${escapeHtml(question.contentOutline)}</div></div>
            <div class="sb-level-badge"><span class="sb-level-circle"></span><span>${escapeHtml(question.level || "Level 2")}</span></div>
          </div>
          <div class="sb-note-row"><input type="text" class="sb-note-input" data-note-qid="${escapeHtml(question.id)}" placeholder="Add your one-line mistake note or memory trick..." value="${escapeHtml(record.notes || "")}" /></div>
        </div>
      </div>
    </article>`;
}

function updateRecord(questionId, patch, sync = true) {
  state.records[questionId] = {
    ...(state.records[questionId] || {}),
    ...patch,
    updatedAt: new Date().toISOString()
  };
  if (sync) syncProgressToServer(false);
  else saveLocalProgress();
  renderAll();
}

function pickOption(questionId, optionNumber) {
  const question = state.questions.find((item) => item.id === questionId);
  if (!question) return;
  const previous = state.records[questionId] || {};
  const correct = optionNumber === question.correctAnswer;
  const status = correct ? (previous.status || "knew") : "wrong";
  updateRecord(questionId, {
    selectedOption: optionNumber,
    revealed: true,
    status,
    timeSpentSec: state.questionSeconds
  });
}

function renderMistakesSheet() {
  const list = document.getElementById("mistakes-sheet-list");
  const items = state.questions.filter((question) => {
    const status = state.records[question.id]?.status;
    return status === "wrong" || status === "guessed";
  });

  if (!items.length) {
    list.innerHTML = `<div class="mistake-row"><span>No questions are marked <strong>✗ Wrong</strong> or <strong>? Guessed</strong>. Your weak-spot facts will compile here as you study.</span></div>`;
    return;
  }

  list.innerHTML = items.map((question) => {
    const record = state.records[question.id];
    const fact = record.notes || question.oneLineFact || question.options[question.correctAnswer - 1] || question.overview;
    const label = record.status === "wrong" ? "✗ Wrong" : "? Guessed";
    return `<div class="mistake-row is-${record.status}"><div><strong>Q#${question.number} (${escapeHtml(question.system)}):</strong> ${escapeHtml(fact)}</div><span class="sb-status-pill ${record.status}">${label}</span></div>`;
  }).join("");
}

function startTimers() {
  setInterval(() => {
    if (!state.sessionPaused && !state.breakActive) {
      state.questionSeconds++;
      const pacer = document.getElementById("q-pacer-display");
      pacer.textContent = formatMinSec(state.questionSeconds);
      pacer.classList.toggle("over-minute", state.questionSeconds >= 60);
      document.getElementById("q-pacer-nudge").classList.toggle("hidden", state.questionSeconds < 60);
    }

    if (state.breakActive) {
      state.breakSecondsRemaining = Math.max(0, state.breakSecondsRemaining - 1);
      setText("break-countdown-display", formatMinSec(state.breakSecondsRemaining));
      if (state.breakSecondsRemaining === 0) endBreakSession();
      return;
    }

    if (!state.sessionPaused) {
      state.sessionSecondsRemaining = Math.max(0, state.sessionSecondsRemaining - 1);
      setText("session-timer-display", formatMinSec(state.sessionSecondsRemaining));
      if (state.sessionSecondsRemaining === 0) startBreakSession();
    }

    if (state.nightDrillActive) {
      state.nightDrillSecondsRemaining = Math.max(0, state.nightDrillSecondsRemaining - 1);
      setText("night-countdown-display", formatMinSec(state.nightDrillSecondsRemaining));
    }
  }, 1000);
}

function startBreakSession() {
  state.breakActive = true;
  state.breakSecondsRemaining = 10 * 60;
  document.getElementById("break-banner").classList.remove("hidden");
  setText("session-mode-label", "On Break");
  setText("break-countdown-display", "10:00");
}

function endBreakSession() {
  state.breakActive = false;
  state.sessionSecondsRemaining = 60 * 60;
  document.getElementById("break-banner").classList.add("hidden");
  setText("session-mode-label", "Study Hour");
  setText("session-timer-display", "60:00");
}

function navigateTo(index) {
  const filtered = getFilteredQuestions();
  if (index < 0 || index >= filtered.length) return;
  stopSpeaking();
  state.currentIndex = index;
  resetQuestionPacer();
  renderAll();
  document.getElementById("question-nav-strip").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setStatusFilter(status) {
  stopSpeaking();
  state.activeStatus = status;
  state.currentIndex = 0;
  document.querySelectorAll(".filter-pill").forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.status === status);
  });
  resetQuestionPacer();
  renderAll();
}

function setViewMode(mode) {
  stopSpeaking();
  state.viewMode = mode;
  document.getElementById("view-single-btn").classList.toggle("active", mode === "single");
  document.getElementById("view-two-col-btn").classList.toggle("active", mode === "two-col");
  renderAll();
}

function resetQuestionPacer() {
  state.questionSeconds = 0;
  setText("q-pacer-display", "0:00");
  document.getElementById("q-pacer-display").classList.remove("over-minute");
  document.getElementById("q-pacer-nudge").classList.add("hidden");
}

function toggleMistakesSheet(open) {
  if (open) renderMistakesSheet();
  document.getElementById("mistakes-sheet-panel").classList.toggle("hidden", !open);
  document.getElementById("questions-container").classList.toggle("hidden", open);
  document.getElementById("question-nav-strip").classList.toggle("hidden", open);
}

function bindEvents() {
  document.getElementById("login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitAuth("login");
  });
  document.getElementById("register-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitAuth("register");
  });
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((item) => item.classList.toggle("active", item === tab));
      document.getElementById("login-form").classList.toggle("hidden", tab.dataset.authTab !== "login");
      document.getElementById("register-form").classList.toggle("hidden", tab.dataset.authTab !== "register");
      showAuthError();
    });
  });
  document.getElementById("account-button").addEventListener("click", () => {
    if (!state.currentUser) updateAuthUI();
  });
  document.getElementById("logout-button").addEventListener("click", async () => {
    const accountCacheKey = localProgressKey();
    await fetch("./api/auth/logout", { method: "POST" }).catch(() => null);
    localStorage.removeItem(accountCacheKey);
    showSignedOutState();
  });

  document.getElementById("questions-container").addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const questionId = button.dataset.qid;
    if (button.dataset.action === "pick-option") pickOption(questionId, Number(button.dataset.opt));
    if (button.dataset.action === "read-question") toggleReadQuestion(questionId);
    if (button.dataset.action === "mark-status") updateRecord(questionId, { status: button.dataset.status });
    if (button.dataset.action === "retry-question") {
      updateRecord(questionId, { selectedOption: null, revealed: false });
      resetQuestionPacer();
    }
    if (button.dataset.action === "toggle-reveal") {
      updateRecord(questionId, { revealed: !state.records[questionId]?.revealed }, false);
    }
  });

  document.getElementById("questions-container").addEventListener("change", (event) => {
    const input = event.target.closest("[data-note-qid]");
    if (!input) return;
    updateRecord(input.dataset.noteQid, { notes: input.value.trim() });
  });

  document.getElementById("prev-q-btn").addEventListener("click", () => navigateTo(state.currentIndex - 1));
  document.getElementById("next-q-btn").addEventListener("click", () => navigateTo(state.currentIndex + 1));
  document.getElementById("q-dots-container").addEventListener("click", (event) => {
    const dot = event.target.closest("[data-jump-idx]");
    if (dot) navigateTo(Number(dot.dataset.jumpIdx));
  });

  document.querySelectorAll(".block-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      stopSpeaking();
      document.querySelectorAll(".block-tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      state.activeBlock = tab.dataset.block;
      state.currentIndex = 0;
      resetQuestionPacer();
      renderAll();
    });
  });

  document.querySelectorAll(".filter-pill").forEach((pill) => {
    pill.addEventListener("click", () => setStatusFilter(pill.dataset.status));
  });
  document.querySelectorAll("[data-filter-click]").forEach((card) => {
    card.addEventListener("click", () => setStatusFilter(card.dataset.filterClick === "guessed" ? "weak" : card.dataset.filterClick));
  });

  document.getElementById("system-filter-select").addEventListener("change", (event) => {
    stopSpeaking();
    state.activeSystem = event.target.value;
    state.currentIndex = 0;
    renderAll();
  });
  document.getElementById("view-single-btn").addEventListener("click", () => setViewMode("single"));
  document.getElementById("view-two-col-btn").addEventListener("click", () => setViewMode("two-col"));

  document.getElementById("toggle-session-timer-btn").addEventListener("click", (event) => {
    state.sessionPaused = !state.sessionPaused;
    event.currentTarget.textContent = state.sessionPaused ? "Resume" : "Pause";
  });
  document.getElementById("start-break-btn").addEventListener("click", startBreakSession);
  document.getElementById("end-break-btn").addEventListener("click", endBreakSession);

  document.getElementById("night-review-btn").addEventListener("click", () => {
    for (const question of state.questions) {
      if (state.records[question.id]?.status === "wrong") {
        state.records[question.id] = { ...state.records[question.id], selectedOption: null, revealed: false, updatedAt: new Date().toISOString() };
      }
    }
    syncProgressToServer(false);
    state.nightDrillActive = true;
    state.nightDrillSecondsRemaining = 30 * 60;
    document.getElementById("night-drill-banner").classList.remove("hidden");
    setText("night-countdown-display", "30:00");
    setStatusFilter("wrong");
  });
  document.getElementById("exit-night-drill-btn").addEventListener("click", () => {
    state.nightDrillActive = false;
    document.getElementById("night-drill-banner").classList.add("hidden");
    setStatusFilter("all");
  });

  document.getElementById("open-mistakes-sheet-btn").addEventListener("click", () => toggleMistakesSheet(true));
  document.getElementById("close-mistakes-sheet-btn").addEventListener("click", () => toggleMistakesSheet(false));
  document.getElementById("print-sheet-btn").addEventListener("click", () => window.print());

  const modal = document.getElementById("import-modal-backdrop");
  document.getElementById("open-import-modal-btn").addEventListener("click", () => modal.classList.remove("hidden"));
  document.getElementById("close-import-modal-btn").addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.classList.add("hidden");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") modal.classList.add("hidden");
  });

  document.querySelectorAll(".modal-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".modal-tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.modalTab;
      document.getElementById("quick-add-form").classList.toggle("hidden", target !== "quick-add");
      document.getElementById("bulk-json-pane").classList.toggle("hidden", target !== "bulk-json");
      document.getElementById("backup-pane").classList.toggle("hidden", target !== "backup");
    });
  });

  document.getElementById("quick-add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const number = Number(document.getElementById("qa-number").value);
    const question = {
      id: `ptexam-q${number}-${Date.now()}`,
      number,
      exam: "PTEXAM ONE",
      system: valueOf("qa-system"),
      stem: valueOf("qa-stem"),
      options: [valueOf("qa-opt1"), valueOf("qa-opt2"), valueOf("qa-opt3"), valueOf("qa-opt4")],
      correctAnswer: Number(valueOf("qa-correct")),
      citation: valueOf("qa-citation"),
      overview: valueOf("qa-overview"),
      oneLineFact: valueOf("qa-fact")
    };
    if (await saveQuestions({ mode: "append", question })) {
      event.target.reset();
      modal.classList.add("hidden");
    }
  });

  document.getElementById("bulk-append-btn").addEventListener("click", async () => {
    const raw = document.getElementById("bulk-json-input").value.trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const questions = Array.isArray(parsed) ? parsed : [parsed];
      if (await saveQuestions({ mode: "append", questions })) {
        document.getElementById("bulk-json-input").value = "";
        modal.classList.add("hidden");
      }
    } catch (error) {
      alert("Invalid JSON format: " + error.message);
    }
  });

  document.getElementById("export-progress-btn").addEventListener("click", () => {
    const data = JSON.stringify({ updatedAt: new Date().toISOString(), records: state.records }, null, 2);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    link.download = `ptexam-550-progress-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  document.getElementById("import-progress-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed?.records || typeof parsed.records !== "object") throw new Error("Missing records object");
      state.records = { ...state.records, ...parsed.records };
      await syncProgressToServer(false);
      renderAll();
      modal.classList.add("hidden");
    } catch (error) {
      alert("Could not restore file: " + error.message);
    }
  });

  document.getElementById("reset-progress-btn").addEventListener("click", async () => {
    if (!window.confirm("Reset all ✓ / ? / ✗ marks and notes? Your questions will stay.")) return;
    state.records = {};
    await syncProgressToServer(true);
    renderAll();
    modal.classList.add("hidden");
  });
}

async function saveQuestions(payload) {
  if (!serverAvailable) {
    alert("Adding questions requires the server version. On GitHub Pages, send new questions in chat so they can be added to the shared set.");
    return false;
  }
  try {
    const response = await fetch("./api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error("Could not save questions");
    const data = await response.json();
    state.questions = data.questions;
    populateSystemFilter();
    renderAll();
    return true;
  } catch (error) {
    alert(error.message);
    return false;
  }
}

function valueOf(id) {
  return document.getElementById(id).value.trim();
}

function formatMinSec(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

initApp();
