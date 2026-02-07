const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "changeme";
const DATABASE_URL = process.env.DATABASE_URL || "";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "puzzles.json");
const DICTIONARY_FILE = path.join(ROOT, "dictionary.txt");

const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 8;
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

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Set it to your Supabase Postgres connection string.");
}

const useSsl = !/(localhost|127\.0\.0\.1)/i.test(DATABASE_URL);
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS puzzles (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      signatures_json JSONB NOT NULL,
      words_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);
  await db.query("CREATE INDEX IF NOT EXISTS idx_puzzles_date ON puzzles(date);");
  await db.query(`
    CREATE TABLE IF NOT EXISTS puzzle_records (
      date TEXT PRIMARY KEY,
      player TEXT,
      elapsed_ms INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);

  // One-time migration from legacy JSON schedule if DB is empty.
  const existingCount = Number((await db.query("SELECT COUNT(*)::int AS count FROM puzzles;")).rows[0].count || 0);
  if (existingCount > 0 || !fs.existsSync(DATA_FILE)) return;

  try {
    const payload = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const curated = Array.isArray(payload.curated) ? payload.curated : [];
    if (!curated.length) return;

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      for (const row of curated) {
        await client.query(
          `INSERT INTO puzzles (id, date, signatures_json, words_json, created_at)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::timestamptz)
           ON CONFLICT (date) DO UPDATE SET
             id = EXCLUDED.id,
             signatures_json = EXCLUDED.signatures_json,
             words_json = EXCLUDED.words_json,
             created_at = EXCLUDED.created_at`,
          [
            row.id || crypto.randomUUID(),
            row.date,
            JSON.stringify(Array.isArray(row.signatures) ? row.signatures : []),
            JSON.stringify(Array.isArray(row.words) ? row.words : []),
            row.createdAt || new Date().toISOString()
          ]
        );
      }
      await client.query("COMMIT");
      console.log(`Migrated ${curated.length} puzzle(s) from JSON to Postgres.`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Failed to migrate JSON puzzles into Postgres:", err.message);
  }
}

async function loadDataFile() {
  try {
    const result = await db.query(`
      SELECT id, date, signatures_json, words_json, created_at
      FROM puzzles
      ORDER BY date ASC
    `);
    const curated = result.rows.map((row) => ({
      id: row.id,
      date: row.date,
      signatures: Array.isArray(row.signatures_json) ? row.signatures_json : [],
      words: Array.isArray(row.words_json) ? row.words_json : [],
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
    }));
    return { curated };
  } catch (_err) {
    return { curated: [] };
  }
}

async function saveDataFile(data) {
  const curated = Array.isArray(data.curated) ? data.curated : [];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM puzzles");
    for (const row of curated) {
      await client.query(
        `INSERT INTO puzzles (id, date, signatures_json, words_json, created_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::timestamptz)`,
        [
          row.id || crypto.randomUUID(),
          row.date,
          JSON.stringify(Array.isArray(row.signatures) ? row.signatures : []),
          JSON.stringify(Array.isArray(row.words) ? row.words : []),
          row.createdAt || new Date().toISOString()
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

function resolvePuzzleForDate(date, data) {
  const exact = data.curated.find((p) => p.date === date);
  if (!exact) return null;
  return { ...exact, source: "curated" };
}

async function getRecordForDate(date) {
  const result = await db.query(
    `SELECT date, player, elapsed_ms, created_at
     FROM puzzle_records
     WHERE date = $1`,
    [date]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    date: row.date,
    player: row.player || null,
    elapsedMs: Number(row.elapsed_ms),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
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
      const data = await loadDataFile();
      const date = todayIsoLocal();
      const puzzle = resolvePuzzleForDate(date, data);
      if (!puzzle) {
        sendJson(res, 404, { error: "No curated puzzle scheduled for today." });
        return;
      }
      const record = await getRecordForDate(puzzle.date);
      const addedLetters = [];
      for (let i = 1; i < puzzle.signatures.length; i += 1) {
        addedLetters.push(addedLetterBetween(puzzle.signatures[i - 1], puzzle.signatures[i]));
      }

      sendJson(res, 200, {
        date: puzzle.date,
        source: puzzle.source,
        signatures: puzzle.signatures,
        words: puzzle.words,
        addedLetters,
        record
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

    if (pathname === "/api/score" && req.method === "POST") {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const puzzleDate = normalizeDate(String(payload.puzzleDate || ""));
      const elapsedMs = Number(payload.elapsedMs);
      const rawPlayer = String(payload.player || "").trim();
      const player = rawPlayer ? rawPlayer.slice(0, 24) : "Anonymous";

      if (!puzzleDate) {
        sendJson(res, 400, { ok: false, error: "Invalid puzzle date." });
        return;
      }
      if (!Number.isFinite(elapsedMs) || elapsedMs < 1000 || elapsedMs > 3_600_000) {
        sendJson(res, 400, { ok: false, error: "Invalid elapsed time." });
        return;
      }

      const existingResult = await db.query(
        `SELECT elapsed_ms, player
         FROM puzzle_records
         WHERE date = $1`,
        [puzzleDate]
      );
      const existing = existingResult.rows[0] || null;

      if (!existing) {
        await db.query(
          `INSERT INTO puzzle_records (date, player, elapsed_ms, created_at)
           VALUES ($1, $2, $3, $4::timestamptz)`,
          [puzzleDate, player, Math.round(elapsedMs), new Date().toISOString()]
        );
        sendJson(res, 200, {
          ok: true,
          isNewRecord: true,
          record: await getRecordForDate(puzzleDate)
        });
        return;
      }

      if (Math.round(elapsedMs) < Number(existing.elapsed_ms)) {
        await db.query(
          `UPDATE puzzle_records
           SET player = $1, elapsed_ms = $2, created_at = $3::timestamptz
           WHERE date = $4`,
          [player, Math.round(elapsedMs), new Date().toISOString(), puzzleDate]
        );
        sendJson(res, 200, {
          ok: true,
          isNewRecord: true,
          record: await getRecordForDate(puzzleDate)
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        isNewRecord: false,
        record: await getRecordForDate(puzzleDate)
      });
      return;
    }

    if (pathname === "/api/admin/puzzles" && req.method === "GET") {
      if (!isAuthorized(urlObj, req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const data = await loadDataFile();
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

      const data = await loadDataFile();
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
      await saveDataFile(data);

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

      const data = await loadDataFile();
      const before = data.curated.length;
      data.curated = data.curated.filter((p) => p.id !== id);
      const removed = before - data.curated.length;

      if (!removed) {
        sendJson(res, 404, { error: "Puzzle not found." });
        return;
      }

      await saveDataFile(data);
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: err.message || "Server error" });
  }
});

async function startServer() {
  await initDatabase();
  server.listen(PORT, () => {
    console.log(`Word Ladder Forge server running on http://localhost:${PORT}`);
    if (ADMIN_TOKEN === "changeme") {
      console.log("Admin token is default. Set ADMIN_TOKEN before production use.");
    }
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
