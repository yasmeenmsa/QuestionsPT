const STORAGE_KEY = "ptexam_550_progress_v1";
const STUDY_USER_KEY = "ptexam_550_study_user_v1";
let serverAvailable = false;

function getStudyUserId() {
  let userId = localStorage.getItem(STUDY_USER_KEY);
  if (!userId) {
    if (crypto.randomUUID) {
      userId = crypto.randomUUID();
    } else {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
      userId = `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
    }
    localStorage.setItem(STUDY_USER_KEY, userId);
  }
  return userId;
}

const studyUserId = getStudyUserId();
const progressHeaders = { "Content-Type": "application/json", "x-study-user": studyUserId };

const state = {
  questions: [],
  records: {},
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
  nightDrillSecondsRemaining: 30 * 60
};

function loadLocalProgress() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveLocalProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
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
  if (!serverAvailable) {
    if (badge) badge.textContent = "● Saved on this device";
    return;
  }
  if (badge) badge.textContent = "↻ Saving...";
  try {
    const response = await fetch("./api/progress", {
      method: "POST",
      headers: progressHeaders,
      body: JSON.stringify({ replaceAll, records: state.records })
    });
    if (!response.ok) throw new Error("Progress save failed");
    if (badge) badge.textContent = "● Saved";
  } catch {
    if (badge) badge.textContent = "● Saved Locally";
  }
}

async function initApp() {
  serverAvailable = await fetch("./api/health")
    .then((response) => response.ok ? response.json() : null)
    .then((data) => Boolean(data?.ok))
    .catch(() => false);

  const [questionData, progressData] = serverAvailable
    ? await Promise.all([
        fetch("./api/questions").then((r) => r.json()).catch(() => ({ questions: [] })),
        fetch("./api/progress", { headers: progressHeaders }).then((r) => r.json()).catch(() => ({ records: {} }))
      ])
    : [
        await fetch("./data/questions.json").then((r) => r.json()).then((questions) => ({ questions })).catch(() => ({ questions: [] })),
        { records: {} }
      ];

  state.questions = Array.isArray(questionData.questions) ? questionData.questions : [];
  const serverRecords = progressData?.records || {};
  const localRecords = loadLocalProgress()?.records || {};
  const merged = { ...serverRecords };

  for (const [questionId, record] of Object.entries(localRecords)) {
    const serverRecord = merged[questionId];
    if (!serverRecord || (record.updatedAt || "") > (serverRecord.updatedAt || "")) {
      merged[questionId] = record;
    }
  }
  state.records = merged;
  if (!serverAvailable) setText("sync-status-badge", "● Saved on this device");

  if (Object.keys(localRecords).length) {
    await syncProgressToServer(false);
  } else {
    saveLocalProgress();
  }

  populateSystemFilter();
  bindEvents();
  startTimers();
  renderAll();
}

function populateSystemFilter() {
  const select = document.getElementById("system-filter-select");
  const current = select.value || "all";
  const systems = [...new Set(state.questions.map((q) => q.system).filter(Boolean))].sort();
  select.innerHTML = `<option value="all">All Systems (${state.questions.length})</option>` +
    systems.map((system) => `<option value="${escapeHtml(system)}">${escapeHtml(system)}</option>`).join("");
  select.value = current === "all" || systems.includes(current) ? current : "all";
  state.activeSystem = select.value;
}

function getFilteredQuestions() {
  return state.questions.filter((question) => {
    if (state.activeBlock !== "all" && String(question.block) !== state.activeBlock) return false;
    if (state.activeSystem !== "all" && question.system !== state.activeSystem) return false;
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
  state.currentIndex = index;
  resetQuestionPacer();
  renderAll();
  document.getElementById("question-nav-strip").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setStatusFilter(status) {
  state.activeStatus = status;
  state.currentIndex = 0;
  document.querySelectorAll(".filter-pill").forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.status === status);
  });
  resetQuestionPacer();
  renderAll();
}

function setViewMode(mode) {
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
  document.getElementById("questions-container").addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const questionId = button.dataset.qid;
    if (button.dataset.action === "pick-option") pickOption(questionId, Number(button.dataset.opt));
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
