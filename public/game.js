const board = document.getElementById("board");
const message = document.getElementById("message");
const submitBtn = document.getElementById("submitBtn");
const shuffleBtn = document.getElementById("shuffleBtn");
const restartBtn = document.getElementById("restartBtn");
const currentLengthLabel = document.getElementById("currentLength");
const bestLengthLabel = document.getElementById("bestLength");
const puzzleDateLabel = document.getElementById("puzzleDate");
const timerLabel = document.getElementById("timer");
const fastestTimeLabel = document.getElementById("fastestTime");
const playerNameInput = document.getElementById("playerName");

let solvedRows = [];
let currentLetters = [];
let bestLength = 3;
let currentLevel = 0;
let selectedIndex = null;
let draggedIndex = null;
let puzzle = null;
let animateLastLockedRow = false;
let timerInterval = null;
let runStartMs = 0;
let elapsedMs = 0;
let scoreSubmitted = false;

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function updateStats() {
  currentLengthLabel.textContent = String(currentLetters.length || 3);
  bestLengthLabel.textContent = String(bestLength);
}

function clearMessage() {
  message.textContent = "";
  message.className = "message";
}

function setMessage(text, type = "") {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

function playSuccessBeep() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "triangle";
  osc.frequency.setValueAtTime(660, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(990, ctx.currentTime + 0.12);
  gain.gain.setValueAtTime(0.001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
  osc.start();
  osc.stop(ctx.currentTime + 0.26);
}

function formatDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function updateTimerLabel() {
  timerLabel.textContent = formatElapsed(elapsedMs);
}

function startTimer() {
  runStartMs = Date.now();
  elapsedMs = 0;
  updateTimerLabel();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    elapsedMs = Date.now() - runStartMs;
    updateTimerLabel();
  }, 100);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  elapsedMs = Date.now() - runStartMs;
  updateTimerLabel();
}

function renderRecord(record) {
  if (!record || !record.elapsedMs) {
    fastestTimeLabel.textContent = "-";
    return;
  }
  const by = record.player ? ` (${record.player})` : "";
  fastestTimeLabel.textContent = `${formatElapsed(record.elapsedMs)}${by}`;
}

function render() {
  board.innerHTML = "";

  solvedRows.forEach((rowLetters, idx) => {
    const rowEl = document.createElement("div");
    rowEl.className = "row locked";
    if (animateLastLockedRow && idx === solvedRows.length - 1) {
      rowEl.classList.add("rise-in");
    }

    rowLetters.forEach((char) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.textContent = char;
      rowEl.appendChild(tile);
    });

    board.appendChild(rowEl);
  });

  if (!currentLetters.length) return;

  const activeRow = document.createElement("div");
  activeRow.className = "row";
  activeRow.id = "activeRow";

  currentLetters.forEach((char, idx) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    tile.textContent = char;
    tile.draggable = true;
    tile.dataset.index = String(idx);

    tile.addEventListener("dragstart", onDragStart);
    tile.addEventListener("dragover", onDragOver);
    tile.addEventListener("dragleave", onDragLeave);
    tile.addEventListener("drop", onDrop);
    tile.addEventListener("dragend", onDragEnd);
    tile.addEventListener("click", onTileClick);

    activeRow.appendChild(tile);
  });

  board.appendChild(activeRow);
  animateLastLockedRow = false;
}

function onDragStart(e) {
  draggedIndex = Number(e.target.dataset.index);
  e.target.classList.add("dragging");
}

function onDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add("over");
}

function onDragLeave(e) {
  e.currentTarget.classList.remove("over");
}

function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove("over");

  const dropIndex = Number(e.currentTarget.dataset.index);
  if (Number.isNaN(draggedIndex) || Number.isNaN(dropIndex) || draggedIndex === dropIndex) return;

  const next = [...currentLetters];
  const [moved] = next.splice(draggedIndex, 1);
  next.splice(dropIndex, 0, moved);
  currentLetters = next;
  render();
}

function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  draggedIndex = null;
}

function onTileClick(e) {
  const clickedIndex = Number(e.currentTarget.dataset.index);
  if (selectedIndex === null) {
    selectedIndex = clickedIndex;
    e.currentTarget.classList.add("over");
    return;
  }
  if (selectedIndex === clickedIndex) {
    selectedIndex = null;
    render();
    return;
  }

  const next = [...currentLetters];
  [next[selectedIndex], next[clickedIndex]] = [next[clickedIndex], next[selectedIndex]];
  currentLetters = next;
  selectedIndex = null;
  render();
}

function pulseSuccessRow() {
  const rows = board.querySelectorAll(".row");
  const lastLockedRow = rows[rows.length - 2];
  if (!lastLockedRow) return;
  lastLockedRow.classList.add("success-burst");
  setTimeout(() => lastLockedRow.classList.remove("success-burst"), 450);
}

function addedLetterBetween(parentSig, childSig) {
  const counts = new Array(26).fill(0);
  for (const ch of parentSig) counts[ch.charCodeAt(0) - 97] += 1;
  for (const ch of childSig) {
    const idx = ch.charCodeAt(0) - 97;
    counts[idx] -= 1;
    if (counts[idx] < 0) return ch;
  }
  return childSig[childSig.length - 1];
}

async function validateWord(word, expectedSignature) {
  const resp = await fetch("/api/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word, expectedSignature })
  });
  if (!resp.ok) return { ok: false };
  return resp.json();
}

async function submitScore() {
  if (!puzzle || scoreSubmitted) return null;
  const player = (playerNameInput.value || "").trim() || "Anonymous";
  const resp = await fetch("/api/score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      puzzleDate: puzzle.date,
      elapsedMs,
      player
    })
  });
  if (!resp.ok) return null;
  scoreSubmitted = true;
  return resp.json();
}

async function submitCurrentWord() {
  if (!puzzle) return;
  clearMessage();
  const word = currentLetters.join("").toLowerCase();
  const expectedSignature = puzzle.signatures[currentLevel];

  submitBtn.disabled = true;

  try {
    const result = await validateWord(word, expectedSignature);
    if (!result.ok) {
      setMessage(`\"${word}\" is invalid for this row. Try another order.`, "error");
      submitBtn.disabled = false;
      return;
    }

    solvedRows.push([...currentLetters]);
    animateLastLockedRow = true;
    if (currentLetters.length > bestLength) {
      bestLength = currentLetters.length;
    }

    playSuccessBeep();

    if (currentLevel === puzzle.signatures.length - 1) {
      stopTimer();
      currentLetters = [];
      render();
      updateStats();
      const scoreResult = await submitScore();
      if (scoreResult && scoreResult.record) {
        puzzle.record = scoreResult.record;
        renderRecord(puzzle.record);
      }
      const solvedText = `Solved in ${formatElapsed(elapsedMs)} with \"${word}\".`;
      const suffix = scoreResult && scoreResult.isNewRecord ? " New fastest record!" : "";
      setMessage(`${solvedText}${suffix}`, "success");
      shuffleBtn.disabled = true;
      submitBtn.disabled = true;
      return;
    }

    const newLetter = addedLetterBetween(
      puzzle.signatures[currentLevel],
      puzzle.signatures[currentLevel + 1]
    ).toUpperCase();

    currentLevel += 1;
    currentLetters = shuffle([...word.toUpperCase().split(""), newLetter]);
    render();
    pulseSuccessRow();
    updateStats();
    setMessage(`Nice! Next row: build a ${currentLetters.length}-letter word.`, "success");
    submitBtn.disabled = false;
  } catch (_err) {
    setMessage("Could not validate word. Please try again.", "error");
    submitBtn.disabled = false;
  }
}

function startPuzzle() {
  solvedRows = [];
  currentLevel = 0;
  selectedIndex = null;
  bestLength = 3;
  scoreSubmitted = false;
  currentLetters = shuffle([...puzzle.signatures[0].toUpperCase().split("")]);
  shuffleBtn.disabled = false;
  submitBtn.disabled = false;
  render();
  updateStats();
  clearMessage();
  startTimer();
}

async function loadPuzzle() {
  setMessage("Loading today's puzzle...");
  submitBtn.disabled = true;
  shuffleBtn.disabled = true;

  try {
    const resp = await fetch("/api/puzzle/today");
    if (!resp.ok) {
      const payload = await resp.json().catch(() => ({}));
      const msg = payload && payload.error ? payload.error : "Failed to load puzzle";
      throw new Error(msg);
    }
    puzzle = await resp.json();
    puzzleDateLabel.textContent = formatDate(puzzle.date);
    renderRecord(puzzle.record || null);
    startPuzzle();
  } catch (err) {
    setMessage(err.message || "Could not load puzzle from server.", "error");
  }
}

playerNameInput.value = localStorage.getItem("wordforge_player_name") || "";
playerNameInput.addEventListener("change", () => {
  localStorage.setItem("wordforge_player_name", playerNameInput.value.trim());
});

shuffleBtn.addEventListener("click", () => {
  currentLetters = shuffle([...currentLetters]);
  render();
});

submitBtn.addEventListener("click", submitCurrentWord);
restartBtn.addEventListener("click", () => {
  if (!puzzle) return;
  startPuzzle();
});

document.addEventListener("dblclick", (e) => {
  e.preventDefault();
}, { passive: false });

loadPuzzle();
