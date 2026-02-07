const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "changeme";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "puzzles.json");
const DB_FILE = path.join(ROOT, "data", "puzzles.db");
const DICTIONARY_FILE = path.join(ROOT, "dictionary.txt");

const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 8;
const FALLBACK_SIGNATURES = ["art", "aert", "aehrt", "aehrst", "aehrstt", "acehrstt"];
const SEED_WORDS = [
  "rat", "tar", "art", "rate", "tear", "tare",
  "earth", "heart", "hater", "rathe",
  "hearts", "haters", "earths", "threats",
  "hatter", "hatters", "shatter", "chatters", "ratchets"
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function todayIsoLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeDate(value) {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

function addDays(isoDate, daysToAdd) {
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + daysToAdd);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function maxScheduledDate(curated) {
  if (!Array.isArray(curated) || !curated.length) return null;
  return curated
    .map((p) => normalizeDate(p.date))
    .filter(Boolean)
    .sort()
    .pop() || null;
}

function parseDictionary(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const words = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const word = line.trim().toLowerCase();
    if (!word) continue;
    if (!/^[a-z]+$/.test(word)) continue;
    if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) continue;
    words.add(word);
  }

  // Keep handpicked words available even if upstream dictionary misses them.
  for (const word of SEED_WORDS) words.add(word);

  return words;
}

function signatureOf(word) {
  return word.split("").sort().join("");
}

function letterPenalty(word) {
  const rare = new Set(["j", "q", "x", "z"]);
  const lessCommon = new Set(["k", "v", "w", "y"]);
  let score = 0;
  const seen = new Map();

  for (const ch of word) {
    if (rare.has(ch)) score += 1.8;
    if (lessCommon.has(ch)) score += 0.7;
    seen.set(ch, (seen.get(ch) || 0) + 1);
  }

  for (const [, count] of seen) {
    if (count > 1) score += (count - 1) * 0.35;
  }

  return score;
}

function buildGraph(wordSet) {
  const wordsBySignature = new Map();
  const signaturesByLength = new Map();
  const nextBySignature = new Map();
  const canReachMemo = new Map();

  for (let len = MIN_WORD_LENGTH; len <= MAX_WORD_LENGTH; len += 1) {
    signaturesByLength.set(len, new Set());
  }

  for (const word of wordSet) {
    const sig = signatureOf(word);
    signaturesByLength.get(word.length).add(sig);
    if (!wordsBySignature.has(sig)) wordsBySignature.set(sig, new Set());
    wordsBySignature.get(sig).add(word);
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

  const starts = [...(signaturesByLength.get(MIN_WORD_LENGTH) || new Set())]
    .filter((sig) => canReachMax(sig, MIN_WORD_LENGTH));

  function representativeWord(sig) {
    const words = [...(wordsBySignature.get(sig) || [])];
    if (!words.length) return sig;
    words.sort((a, b) => {
      const delta = letterPenalty(a) - letterPenalty(b);
      if (delta !== 0) return delta;
      return a.localeCompare(b);
    });
    return words[0];
  }

  function signatureDifficulty(sig) {
    const words = wordsBySignature.get(sig);
    const count = words ? words.size : 1;
    const canonical = representativeWord(sig);
    return (10 / Math.max(1, count)) + letterPenalty(canonical);
  }

  return {
    wordsBySignature,
    nextBySignature,
    canReachMemo,
    starts,
    canReachMax,
    representativeWord,
    signatureDifficulty
  };
}

function sortWordsForChoice(words) {
  return [...words].sort((a, b) => {
    const delta = letterPenalty(a) - letterPenalty(b);
    if (delta !== 0) return delta;
    return a.localeCompare(b);
  });
}

function pickWeighted(items, weightFn) {
  if (!items.length) return null;
  const weights = items.map((item) => Math.max(0.0001, weightFn(item)));
  const total = weights.reduce((sum, n) => sum + n, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

function createSuggestion(graph) {
  if (!graph.starts.length) {
    return {
      signatures: [...FALLBACK_SIGNATURES],
      words: ["art", "rate", "earth", "hearts", "hatters", "chatters"],
      averageDifficulty: 999,
      anagramCounts: [1, 1, 1, 1, 1, 1]
    };
  }

  const path = [];
  const startCandidates = [...graph.starts]
    .sort((a, b) => graph.signatureDifficulty(a) - graph.signatureDifficulty(b))
    .slice(0, 500);

  let current = pickWeighted(startCandidates, (sig) => 1 / (1 + graph.signatureDifficulty(sig)));
  path.push(current);

  for (let len = MIN_WORD_LENGTH; len < MAX_WORD_LENGTH; len += 1) {
    const children = (graph.nextBySignature.get(current) || [])
      .filter((childSig) => graph.canReachMemo.get(`${len + 1}:${childSig}`));

    if (!children.length) return null;

    current = pickWeighted(children, (sig) => 1 / (1 + graph.signatureDifficulty(sig)));
    path.push(current);
  }

  const words = path.map((sig) => graph.representativeWord(sig));
  const anagramCounts = path.map((sig) => (graph.wordsBySignature.get(sig) || new Set()).size);
  const avgDifficulty = path
    .map((sig) => graph.signatureDifficulty(sig))
    .reduce((sum, n) => sum + n, 0) / path.length;

  return {
    signatures: path,
    words,
    averageDifficulty: Number(avgDifficulty.toFixed(2)),
    anagramCounts
  };
}

function createSuggestions(graph, count = 20) {
  const suggestions = [];
  const seen = new Set();
  const attempts = count * 20;

  for (let i = 0; i < attempts && suggestions.length < count; i += 1) {
    const suggestion = createSuggestion(graph);
    if (!suggestion) continue;
    const key = suggestion.signatures.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(suggestion);
  }

  suggestions.sort((a, b) => a.averageDifficulty - b.averageDifficulty);
  return suggestions;
}

function createUniqueSuggestion(graph, usedSignatureChains) {
  for (let i = 0; i < 200; i += 1) {
    const next = createSuggestion(graph);
    if (!next) continue;
    const key = next.signatures.join("|");
    if (usedSignatureChains.has(key)) continue;
    usedSignatureChains.add(key);
    return next;
  }
  return createSuggestion(graph);
}

function initDatabase() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS puzzles (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      signatures_json TEXT NOT NULL,
      words_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_puzzles_date ON puzzles(date);
  `);

  const rowCount = db.prepare("SELECT COUNT(*) AS count FROM puzzles").get().count;
  if (rowCount === 0 && fs.existsSync(DATA_FILE)) {
    try {
      const payload = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      const curated = Array.isArray(payload.curated) ? payload.curated : [];
      const insert = db.prepare(`
        INSERT OR REPLACE INTO puzzles (id, date, signatures_json, words_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const txn = db.transaction((rows) => {
        for (const row of rows) {
          insert.run(
            row.id || crypto.randomUUID(),
            row.date,
            JSON.stringify(Array.isArray(row.signatures) ? row.signatures : []),
            JSON.stringify(Array.isArray(row.words) ? row.words : []),
            row.createdAt || new Date().toISOString()
          );
        }
      });
      txn(curated);
      console.log(`Migrated ${curated.length} puzzle(s) from JSON to SQLite.`);
    } catch (err) {
      console.error("Failed to migrate JSON puzzles into SQLite:", err.message);
    }
  }

  return db;
}

function loadDataFile() {
  try {
    const rows = db.prepare(`
      SELECT id, date, signatures_json, words_json, created_at
      FROM puzzles
      ORDER BY date ASC
    `).all();
    const curated = rows.map((row) => ({
      id: row.id,
      date: row.date,
      signatures: JSON.parse(row.signatures_json),
      words: JSON.parse(row.words_json),
      createdAt: row.created_at
    }));
    return { curated };
  } catch (_err) {
    return { curated: [] };
  }
}

function saveDataFile(data) {
  const curated = Array.isArray(data.curated) ? data.curated : [];
  const clear = db.prepare("DELETE FROM puzzles");
  const insert = db.prepare(`
    INSERT OR REPLACE INTO puzzles (id, date, signatures_json, words_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const txn = db.transaction((rows) => {
    clear.run();
    for (const row of rows) {
      insert.run(
        row.id || crypto.randomUUID(),
        row.date,
        JSON.stringify(Array.isArray(row.signatures) ? row.signatures : []),
        JSON.stringify(Array.isArray(row.words) ? row.words : []),
        row.createdAt || new Date().toISOString()
      );
    }
  });
  txn(curated);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
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

function getAdminToken(urlObj, req) {
  const q = urlObj.searchParams.get("token");
  if (q) return q;
  return req.headers["x-admin-token"] || "";
}

function isAuthorized(urlObj, req) {
  return getAdminToken(urlObj, req) === ADMIN_TOKEN;
}

const dictionary = parseDictionary(DICTIONARY_FILE);
const graph = buildGraph(dictionary);
const db = initDatabase();

function resolvePuzzleForDate(date, data) {
  const exact = data.curated.find((p) => p.date === date);
  if (exact) return { ...exact, source: "curated" };

  const fallback = createSuggestion(graph);
  if (!fallback) {
    return {
      id: "fallback-static",
      date,
      signatures: [...FALLBACK_SIGNATURES],
      words: ["art", "rate", "earth", "hearts", "hatters", "chatters"],
      source: "fallback"
    };
  }

  return {
    id: "fallback-generated",
    date,
    signatures: fallback.signatures,
    words: fallback.words,
    source: "fallback"
  };
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const requested = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!requested.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.stat(requested, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(requested).toLowerCase();
    const type = mimeTypes[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(requested).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;

    if (pathname === "/admin") {
      serveStatic(req, res, "/admin.html");
      return;
    }

    if (pathname === "/api/puzzle/today" && req.method === "GET") {
      const data = loadDataFile();
      const date = todayIsoLocal();
      const puzzle = resolvePuzzleForDate(date, data);
      const addedLetters = [];
      for (let i = 1; i < puzzle.signatures.length; i += 1) {
        addedLetters.push(addedLetterBetween(puzzle.signatures[i - 1], puzzle.signatures[i]));
      }

      sendJson(res, 200, {
        date: puzzle.date,
        source: puzzle.source,
        signatures: puzzle.signatures,
        words: puzzle.words,
        addedLetters
      });
      return;
    }

    if (pathname === "/api/validate" && req.method === "POST") {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const word = String(payload.word || "").toLowerCase();
      const expectedSignature = String(payload.expectedSignature || "").toLowerCase();

      if (!/^[a-z]+$/.test(word)) {
        sendJson(res, 400, { ok: false, reason: "invalid_format" });
        return;
      }

      const isInDictionary = dictionary.has(word);
      const sigMatches = signatureOf(word) === expectedSignature;

      sendJson(res, 200, {
        ok: isInDictionary && sigMatches,
        isInDictionary,
        sigMatches
      });
      return;
    }

    if (pathname === "/api/admin/suggestions" && req.method === "GET") {
      if (!isAuthorized(urlObj, req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const count = Math.min(50, Math.max(1, Number(urlObj.searchParams.get("count") || "20")));
      const suggestions = createSuggestions(graph, count).map((s, idx) => ({
        id: `s-${idx + 1}-${crypto.randomUUID().slice(0, 8)}`,
        ...s
      }));
      sendJson(res, 200, { suggestions });
      return;
    }

    if (pathname === "/api/admin/puzzles" && req.method === "GET") {
      if (!isAuthorized(urlObj, req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const data = loadDataFile();
      const curated = [...data.curated].sort((a, b) => a.date.localeCompare(b.date));
      sendJson(res, 200, { curated });
      return;
    }

    if (pathname === "/api/admin/manual/next" && req.method === "POST") {
      if (!isAuthorized(urlObj, req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const word = String(payload.word || "").toLowerCase();

      if (!/^[a-z]+$/.test(word)) {
        sendJson(res, 400, { error: "Word must contain letters only." });
        return;
      }
      if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) {
        sendJson(res, 400, { error: "Word length must be between 3 and 8." });
        return;
      }
      if (!dictionary.has(word)) {
        sendJson(res, 400, { error: "Word not found in dictionary." });
        return;
      }

      const signature = signatureOf(word);
      const hasSignature = graph.wordsBySignature.has(signature);
      if (!hasSignature) {
        sendJson(res, 400, { error: "Word signature not found in graph." });
        return;
      }

      if (word.length === MAX_WORD_LENGTH) {
        sendJson(res, 200, { done: true, nextLength: null, options: [] });
        return;
      }

      const nextLength = word.length + 1;
      const children = graph.nextBySignature.get(signature) || [];

      const options = [];
      for (const childSig of children) {
        const words = graph.wordsBySignature.get(childSig) || new Set();
        const sorted = sortWordsForChoice(words);
        for (const optionWord of sorted) {
          options.push({
            word: optionWord,
            signature: childSig,
            canReachEight: !!graph.canReachMemo.get(`${nextLength}:${childSig}`)
          });
        }
      }

      options.sort((a, b) => {
        const delta = letterPenalty(a.word) - letterPenalty(b.word);
        if (delta !== 0) return delta;
        return a.word.localeCompare(b.word);
      });

      sendJson(res, 200, {
        done: false,
        nextLength,
        options: options
          .sort((a, b) => {
            if (a.canReachEight !== b.canReachEight) return a.canReachEight ? -1 : 1;
            const delta = letterPenalty(a.word) - letterPenalty(b.word);
            if (delta !== 0) return delta;
            return a.word.localeCompare(b.word);
          })
          .slice(0, 400)
      });
      return;
    }

    if (pathname === "/api/admin/puzzles" && req.method === "POST") {
      if (!isAuthorized(urlObj, req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const requestedDate = normalizeDate(payload.date);
      const autoDate = payload.autoDate !== false;
      const signatures = Array.isArray(payload.signatures) ? payload.signatures : null;
      const words = Array.isArray(payload.words) ? payload.words : null;

      if (!signatures || signatures.length !== 6) {
        sendJson(res, 400, { error: "Expected { signatures: [6], words: [6], date?: YYYY-MM-DD, autoDate?: boolean }" });
        return;
      }

      for (let i = 0; i < signatures.length; i += 1) {
        const sig = String(signatures[i] || "").toLowerCase();
        const expectedLen = MIN_WORD_LENGTH + i;
        if (!/^[a-z]+$/.test(sig) || sig.length !== expectedLen) {
          sendJson(res, 400, { error: `Invalid signature at index ${i}` });
          return;
        }
        if (!graph.wordsBySignature.has(sig)) {
          sendJson(res, 400, { error: `Signature not found in dictionary at index ${i}` });
          return;
        }
        if (i > 0) {
          const prev = signatures[i - 1];
          const children = graph.nextBySignature.get(prev) || [];
          if (!children.includes(sig)) {
            sendJson(res, 400, { error: `Invalid chain step from index ${i - 1} to ${i}` });
            return;
          }
        }
        signatures[i] = sig;
      }

      const normalizedWords = (words && words.length === signatures.length)
        ? words.map((w, i) => {
          const val = String(w || "").toLowerCase();
          return graph.wordsBySignature.get(signatures[i]).has(val)
            ? val
            : graph.representativeWord(signatures[i]);
        })
        : signatures.map((sig) => graph.representativeWord(sig));

      const data = loadDataFile();
      let date = requestedDate;
      if (autoDate || !date) {
        const maxDate = maxScheduledDate(data.curated);
        date = maxDate ? addDays(maxDate, 1) : todayIsoLocal();
      }
      if (!date) {
        sendJson(res, 400, { error: "Could not resolve publish date." });
        return;
      }
      const nextEntry = {
        id: crypto.randomUUID(),
        date,
        signatures,
        words: normalizedWords,
        createdAt: new Date().toISOString()
      };

      const filtered = data.curated.filter((p) => p.date !== date);
      filtered.push(nextEntry);
      data.curated = filtered;
      saveDataFile(data);

      sendJson(res, 200, { ok: true, puzzle: nextEntry });
      return;
    }

    if (pathname.startsWith("/api/admin/puzzles/") && req.method === "DELETE") {
      if (!isAuthorized(urlObj, req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const id = decodeURIComponent(pathname.replace("/api/admin/puzzles/", ""));
      if (!id) {
        sendJson(res, 400, { error: "Puzzle id is required." });
        return;
      }

      const data = loadDataFile();
      const before = data.curated.length;
      data.curated = data.curated.filter((p) => p.id !== id);
      const removed = before - data.curated.length;

      if (!removed) {
        sendJson(res, 404, { error: "Puzzle not found." });
        return;
      }

      saveDataFile(data);
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    if (pathname === "/api/admin/puzzles/batch" && req.method === "POST") {
      if (!isAuthorized(urlObj, req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const startDate = normalizeDate(payload.startDate) || todayIsoLocal();
      const days = Math.min(90, Math.max(1, Number(payload.days || 30)));
      const skipExisting = payload.skipExisting !== false;

      const data = loadDataFile();
      const byDate = new Map(data.curated.map((p) => [p.date, p]));
      const usedSignatureChains = new Set(data.curated.map((p) => p.signatures.join("|")));
      const created = [];
      const reused = [];

      for (let i = 0; i < days; i += 1) {
        const date = addDays(startDate, i);
        if (!date) continue;

        if (byDate.has(date)) {
          reused.push({ date, reason: "already_exists" });
          if (skipExisting) continue;
        }

        const suggestion = createUniqueSuggestion(graph, usedSignatureChains);
        if (!suggestion) {
          reused.push({ date, reason: "no_suggestion_available" });
          continue;
        }

        const entry = {
          id: crypto.randomUUID(),
          date,
          signatures: suggestion.signatures,
          words: suggestion.words,
          createdAt: new Date().toISOString()
        };

        byDate.set(date, entry);
        created.push(entry);
      }

      data.curated = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      saveDataFile(data);

      sendJson(res, 200, {
        ok: true,
        startDate,
        days,
        createdCount: created.length,
        skippedOrReusedCount: reused.length,
        created,
        details: reused
      });
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: err.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Word Ladder Forge server running on http://localhost:${PORT}`);
  if (ADMIN_TOKEN === "changeme") {
    console.log("Admin token is default. Set ADMIN_TOKEN before production use.");
  }
});
