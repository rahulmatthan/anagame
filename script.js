const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 8;
const FALLBACK_SIGNATURES = ["art", "aert", "aehrt", "aehrst", "aehrstt", "acehrstt"];

const BUILTIN_WORDS = [
  "rat", "tar", "art",
  "rate", "tear", "tare",
  "earth", "heart", "hater", "rathe",
  "hearts", "haters", "earths",
  "hatters", "threats",
  "chatters", "ratchets"
];

const externalWords = typeof DICTIONARY_WORDS !== "undefined" && Array.isArray(DICTIONARY_WORDS)
  ? DICTIONARY_WORDS
  : [];
const combinedDictionary = [...externalWords, ...BUILTIN_WORDS];
const wordSet = new Set(combinedDictionary.map((w) => w.toLowerCase()));
const signaturesByLength = new Map();
const nextBySignature = new Map();
const canReachMemo = new Map();
let startSignatures = [];

const board = document.getElementById("board");
const message = document.getElementById("message");
const submitBtn = document.getElementById("submitBtn");
const shuffleBtn = document.getElementById("shuffleBtn");
const restartBtn = document.getElementById("restartBtn");
const currentLengthLabel = document.getElementById("currentLength");
const bestLengthLabel = document.getElementById("bestLength");

let solvedRows = [];
let currentLetters = [];
let bestLength = 3;
let currentLevel = 0;
let selectedIndex = null;
let puzzleSignatures = [];

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function updateStats() {
  currentLengthLabel.textContent = String(currentLetters.length || MIN_WORD_LENGTH);
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

function isPlayableWord(word) {
  return wordSet.has(word.toLowerCase());
}

function signatureOf(word) {
  return word.toLowerCase().split("").sort().join("");
}

function buildPuzzleGraph() {
  for (let len = MIN_WORD_LENGTH; len <= MAX_WORD_LENGTH; len += 1) {
    signaturesByLength.set(len, new Set());
  }

  for (const word of wordSet) {
    if (!/^[a-z]+$/.test(word)) continue;
    if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) continue;
    signaturesByLength.get(word.length).add(signatureOf(word));
  }

  for (let len = MIN_WORD_LENGTH; len < MAX_WORD_LENGTH; len += 1) {
    const parentSet = signaturesByLength.get(len);
    const childSet = signaturesByLength.get(len + 1);
    for (const childSig of childSet) {
      const seenParents = new Set();
      for (let i = 0; i < childSig.length; i += 1) {
        const parentSig = childSig.slice(0, i) + childSig.slice(i + 1);
        if (!parentSet.has(parentSig)) continue;
        if (seenParents.has(parentSig)) continue;
        seenParents.add(parentSig);
        if (!nextBySignature.has(parentSig)) nextBySignature.set(parentSig, []);
        nextBySignature.get(parentSig).push(childSig);
      }
    }
  }

  function canReachMax(sig, len) {
    const key = `${len}:${sig}`;
    if (canReachMemo.has(key)) return canReachMemo.get(key);
    if (len === MAX_WORD_LENGTH) {
      canReachMemo.set(key, true);
      return true;
    }

    const children = nextBySignature.get(sig) || [];
    const ok = children.some((childSig) => canReachMax(childSig, len + 1));
    canReachMemo.set(key, ok);
    return ok;
  }

  const starts = signaturesByLength.get(MIN_WORD_LENGTH) || new Set();
  startSignatures = [...starts].filter((sig) => canReachMax(sig, MIN_WORD_LENGTH));
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function buildRandomPuzzleSignatures() {
  if (!startSignatures.length) {
    return [...FALLBACK_SIGNATURES];
  }

  const path = [];
  let currentSig = randomItem(startSignatures);
  path.push(currentSig);

  for (let len = MIN_WORD_LENGTH; len < MAX_WORD_LENGTH; len += 1) {
    const children = (nextBySignature.get(currentSig) || [])
      .filter((childSig) => canReachMemo.get(`${len + 1}:${childSig}`));
    if (!children.length) {
      return [...FALLBACK_SIGNATURES];
    }
    currentSig = randomItem(children);
    path.push(currentSig);
  }

  return path;
}

function addedLetterBetween(parentSig, childSig) {
  const parentCounts = new Array(26).fill(0);
  for (const ch of parentSig) parentCounts[ch.charCodeAt(0) - 97] += 1;
  for (const ch of childSig) {
    const idx = ch.charCodeAt(0) - 97;
    parentCounts[idx] -= 1;
    if (parentCounts[idx] < 0) return ch;
  }
  return childSig[childSig.length - 1];
}

function render() {
  board.innerHTML = "";

  solvedRows.forEach((rowLetters) => {
    const rowEl = document.createElement("div");
    rowEl.className = "row locked";
    rowEl.style.gridTemplateColumns = `repeat(${rowLetters.length}, minmax(0, 1fr))`;

    rowLetters.forEach((char) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.textContent = char;
      rowEl.appendChild(tile);
    });

    board.appendChild(rowEl);
  });

  const activeRow = document.createElement("div");
  activeRow.className = "row";
  activeRow.id = "activeRow";
  activeRow.style.gridTemplateColumns = `repeat(${currentLetters.length}, minmax(0, 1fr))`;

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
}

let draggedIndex = null;

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

function submitCurrentWord() {
  clearMessage();
  const word = currentLetters.join("").toLowerCase();

  if (!isPlayableWord(word)) {
    setMessage(`\"${word}\" is not in the word list. Try another order.`, "error");
    return;
  }

  solvedRows.push(currentLetters.map((letter) => letter));
  if (currentLetters.length > bestLength) {
    bestLength = currentLetters.length;
  }

  playSuccessBeep();

  if (currentLevel === puzzleSignatures.length - 1) {
    currentLetters = [];
    render();
    updateStats();
    setMessage(`Perfect. You completed the 8-letter round with \"${word}\".`, "success");
    restartBtn.classList.remove("hidden");
    submitBtn.disabled = true;
    shuffleBtn.disabled = true;
    return;
  }

  const nextSignature = puzzleSignatures[currentLevel + 1];
  const currentSignature = puzzleSignatures[currentLevel];
  const newLetter = addedLetterBetween(currentSignature, nextSignature).toUpperCase();
  currentLevel += 1;
  currentLetters = shuffle([...word.toUpperCase().split(""), newLetter]);
  render();
  pulseSuccessRow();
  updateStats();
  setMessage(`Nice! Next round: make a ${currentLetters.length}-letter word.`, "success");
}

function startGame() {
  solvedRows = [];
  puzzleSignatures = buildRandomPuzzleSignatures();
  currentLevel = 0;
  selectedIndex = null;
  currentLetters = shuffle([...puzzleSignatures[currentLevel].toUpperCase().split("")]);
  bestLength = 3;
  render();
  updateStats();
  clearMessage();
  submitBtn.disabled = false;
  shuffleBtn.disabled = false;
  restartBtn.classList.add("hidden");
}

shuffleBtn.addEventListener("click", () => {
  currentLetters = shuffle([...currentLetters]);
  render();
});

submitBtn.addEventListener("click", submitCurrentWord);
restartBtn.addEventListener("click", startGame);

buildPuzzleGraph();
startGame();
