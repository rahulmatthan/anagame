const tokenInput = document.getElementById("token");
const dateInput = document.getElementById("date");
const loadCuratedBtn = document.getElementById("loadCuratedBtn");
const curatedEl = document.getElementById("curated");
const statusEl = document.getElementById("status");
const startWordInput = document.getElementById("startWord");
const startManualBtn = document.getElementById("startManualBtn");
const undoManualBtn = document.getElementById("undoManualBtn");
const publishManualBtn = document.getElementById("publishManualBtn");
const manualStatusEl = document.getElementById("manualStatus");
const manualChainEl = document.getElementById("manualChain");
const manualOptionsEl = document.getElementById("manualOptions");

const now = new Date();
const y = now.getFullYear();
const m = String(now.getMonth() + 1).padStart(2, "0");
const d = String(now.getDate()).padStart(2, "0");
dateInput.value = `${y}-${m}-${d}`;
let manualChain = [];

function addDays(isoDate, days) {
  const dt = new Date(`${isoDate}T00:00:00`);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "err small" : "ok small";
}

function tokenParam() {
  return encodeURIComponent(tokenInput.value.trim());
}

function signatureOf(word) {
  return word.toLowerCase().split("").sort().join("");
}

function setManualStatus(msg, isError = false) {
  manualStatusEl.textContent = msg;
  manualStatusEl.className = isError ? "err small" : "ok small";
}

function renderManualChain() {
  if (!manualChain.length) {
    manualChainEl.textContent = "Chain: (none)";
    return;
  }
  manualChainEl.textContent = `Chain: ${manualChain.map((w) => w.toUpperCase()).join(" → ")}`;
}

function renderManualOptions(options, nextLength) {
  manualOptionsEl.innerHTML = "";
  if (!options.length) {
    manualOptionsEl.innerHTML = "<p class='muted'>No options available from this step in the dictionary.</p>";
    return;
  }

  const heading = document.createElement("p");
  heading.className = "muted";
  heading.textContent = `Pick a ${nextLength}-letter word:`;
  manualOptionsEl.appendChild(heading);

  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.flexWrap = "wrap";
  wrap.style.gap = "8px";

  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opt.canReachEight ? `${opt.word.toUpperCase()} *` : opt.word.toUpperCase();
    btn.title = opt.canReachEight
      ? "This option can still reach an 8-letter word."
      : "This option may dead-end before 8 letters.";
    btn.addEventListener("click", () => {
      manualChain.push(opt.word);
      renderManualChain();
      loadNextManualOptions();
    });
    wrap.appendChild(btn);
  });

  manualOptionsEl.appendChild(wrap);
}

async function fetchManualNext(word) {
  const token = tokenInput.value.trim();
  if (!token) {
    setManualStatus("Enter admin token first.", true);
    return null;
  }

  const resp = await fetch(`/api/admin/manual/next?token=${tokenParam()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word })
  });

  if (!resp.ok) {
    const raw = await resp.text();
    let err = null;
    try {
      err = JSON.parse(raw);
    } catch (_e) {
      err = null;
    }
    const detail = err && err.error ? err.error : raw || `HTTP ${resp.status}`;
    setManualStatus(`Could not get next options: ${detail}`, true);
    return null;
  }

  return resp.json();
}

async function loadNextManualOptions() {
  if (!manualChain.length) {
    renderManualOptions([], null);
    return;
  }

  const currentWord = manualChain[manualChain.length - 1];
  const data = await fetchManualNext(currentWord);
  if (!data) return;

  if (data.done) {
    renderManualOptions([], null);
    setManualStatus("Chain is complete at 8 letters. You can publish it.");
    return;
  }

  renderManualOptions(data.options || [], data.nextLength);
  const reachableCount = (data.options || []).filter((o) => o.canReachEight).length;
  setManualStatus(
    `Loaded ${(data.options || []).length} options for ${data.nextLength} letters. ` +
    `${reachableCount} can still reach 8 letters (marked with *).`
  );
}

async function startManualChain() {
  const word = startWordInput.value.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(word)) {
    setManualStatus("Start word must be exactly 3 letters.", true);
    return;
  }
  manualChain = [word];
  renderManualChain();
  await loadNextManualOptions();
}

async function publishManualChain() {
  const token = tokenInput.value.trim();
  if (!token) {
    setManualStatus("Token is required.", true);
    return;
  }
  if (manualChain.length !== 6) {
    setManualStatus("Manual chain must include 3 through 8 letters before publish.", true);
    return;
  }

  const signatures = manualChain.map((w) => signatureOf(w));
  const resp = await fetch(`/api/admin/puzzles?token=${tokenParam()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      autoDate: true,
      signatures,
      words: manualChain
    })
  });

  if (!resp.ok) {
    const raw = await resp.text();
    let err = null;
    try {
      err = JSON.parse(raw);
    } catch (_e) {
      err = null;
    }
    const detail = err && err.error ? err.error : raw || `HTTP ${resp.status}`;
    setManualStatus(`Failed to publish manual chain: ${detail}`, true);
    return;
  }

  const data = await resp.json().catch(() => ({}));
  const publishedDate = data && data.puzzle ? data.puzzle.date : "(assigned)";
  setManualStatus(`Published manual chain for ${publishedDate}.`);
  loadCurated();
}

function renderCurated(items) {
  curatedEl.innerHTML = "";
  if (!items.length) {
    curatedEl.innerHTML = "<p class='muted'>No scheduled puzzles.</p>";
    return;
  }

  items
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((item) => {
      const div = document.createElement("div");
      div.className = "suggestion";
      div.innerHTML = `
        <div><strong>${item.date}</strong></div>
        <div class="words">${item.words.map((w) => w.toUpperCase()).join(" → ")}</div>
        <div style="margin-top:8px;">
          <button type="button" data-delete-id="${item.id}">Delete</button>
        </div>
      `;

      const deleteBtn = div.querySelector("button[data-delete-id]");
      deleteBtn.addEventListener("click", async () => {
        const token = tokenInput.value.trim();
        if (!token) {
          setStatus("Enter admin token first.", true);
          return;
        }

        const shouldDelete = window.confirm(`Delete scheduled puzzle for ${item.date}?`);
        if (!shouldDelete) return;

        const resp = await fetch(`/api/admin/puzzles/${encodeURIComponent(item.id)}?token=${tokenParam()}`, {
          method: "DELETE"
        });

        if (!resp.ok) {
          const raw = await resp.text();
          let err = null;
          try {
            err = JSON.parse(raw);
          } catch (_e) {
            err = null;
          }
          const detail = err && err.error ? err.error : raw || `HTTP ${resp.status}`;
          setStatus(`Delete failed: ${detail}`, true);
          return;
        }

        setStatus(`Deleted puzzle for ${item.date}.`);
        loadCurated();
      });

      curatedEl.appendChild(div);
    });
}

async function loadCurated() {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus("Enter admin token first.", true);
    return;
  }

  const resp = await fetch(`/api/admin/puzzles?token=${tokenParam()}`);
  if (!resp.ok) {
    setStatus("Could not load scheduled puzzles (check token).", true);
    return;
  }

  const data = await resp.json();
  const curated = data.curated || [];
  renderCurated(curated);
  if (curated.length) {
    const maxDate = [...curated].map((p) => p.date).sort().pop();
    dateInput.value = addDays(maxDate, 1);
  } else {
    dateInput.value = `${y}-${m}-${d}`;
  }
  setStatus(`Loaded ${curated.length} scheduled puzzles.`);
}

loadCuratedBtn.addEventListener("click", loadCurated);
startManualBtn.addEventListener("click", startManualChain);
undoManualBtn.addEventListener("click", () => {
  if (!manualChain.length) return;
  manualChain.pop();
  renderManualChain();
  if (!manualChain.length) {
    manualOptionsEl.innerHTML = "";
    setManualStatus("Chain cleared.");
    return;
  }
  loadNextManualOptions();
});
publishManualBtn.addEventListener("click", publishManualChain);

renderManualChain();
