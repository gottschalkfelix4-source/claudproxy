/* Claude Proxy admin UI — no build step, no external assets. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/** Everything rendered into innerHTML goes through this. */
function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

async function api(path, options = {}) {
  const res = await fetch("/admin/api" + path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401 && !path.startsWith("/login")) {
    showLogin();
    throw new Error("Nicht angemeldet");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmtInt = (n) => Number(n || 0).toLocaleString("de-DE");
const fmtUsd = (n) => "$" + Number(n || 0).toFixed(Number(n || 0) < 1 ? 4 : 2);
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString("de-DE") : "–");
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString("de-DE") : "–");

function fmtTokens(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(".", ",") + " M";
  if (v >= 1000) return (v / 1000).toFixed(1).replace(".", ",") + " k";
  return String(v);
}

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

let state = { status: null, keys: [], endpoints: null, fields: [] };

function showLogin() {
  $("#login").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#login-password")?.focus();
}

function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.classList.add("hidden");
  try {
    await api("/login", {
      method: "POST",
      body: JSON.stringify({ password: $("#login-password").value }),
    });
    $("#login-password").value = "";
    showApp();
    await boot();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */

$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => navigate(btn.dataset.page));
});

function navigate(page) {
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("hidden", p.id !== "page-" + page));
  location.hash = page;

  if (page === "dashboard") loadDashboard();
  if (page === "keys") loadKeys();
  if (page === "logs") loadLogs();
  if (page === "connect") renderConnect();
  if (page === "settings") loadSettings();
}

/* ------------------------------------------------------------------ */
/* dashboard                                                           */
/* ------------------------------------------------------------------ */

$("#refresh").addEventListener("click", loadDashboard);
$("#range").addEventListener("change", loadDashboard);

async function loadDashboard() {
  const days = $("#range").value;
  const [status, stats, endpoints] = await Promise.all([
    api("/status"),
    api("/stats?days=" + days),
    api("/endpoints"),
  ]);
  state.status = status;
  state.endpoints = endpoints;
  renderEndpointCard(endpoints);

  const banner = $("#engine-banner");
  if (status.ready) {
    banner.innerHTML = `<div class="banner ok">Backend <strong>${esc(
      status.backend,
    )}</strong> ist bereit · Standardmodell <code>${esc(status.defaultModel)}</code>${
      status.requireAuth ? "" : " · <strong>Auth deaktiviert</strong>"
    }</div>`;
  } else {
    banner.innerHTML = `<div class="banner err"><strong>Backend ${esc(
      status.backend,
    )} ist nicht einsatzbereit.</strong><br>${esc(status.detail)}</div>`;
  }

  const built = status.builtAt
    ? new Date(status.builtAt).toLocaleDateString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : null;
  $("#dash-sub").innerHTML =
    `Version ${esc(status.version)}` +
    (status.commit ? ` · Build <code>${esc(status.commit.slice(0, 7))}</code>` : "") +
    (built && built !== "Invalid Date" ? ` vom ${esc(built)}` : "") +
    ` · läuft seit ${Math.floor(status.uptimeSeconds / 60)} min`;

  const t = stats.totals || {};
  $("#s-requests").textContent = fmtInt(t.requests);
  $("#s-errors").innerHTML = t.errors
    ? `<span class="pill err">${fmtInt(t.errors)} Fehler</span>`
    : '<span class="pill ok">keine Fehler</span>';
  $("#s-tokens").textContent = fmtTokens(
    Number(t.promptTokens || 0) + Number(t.completionTokens || 0),
  );
  $("#s-tokens-split").textContent = `${fmtTokens(t.promptTokens)} rein · ${fmtTokens(
    t.completionTokens,
  )} raus`;
  $("#s-cost").textContent = fmtUsd(t.costUsd);
  $("#s-duration").textContent = Math.round(Number(t.avgDurationMs || 0)) + " ms";

  renderChart(stats.byDay || [], Number(days));
  renderTable(
    "#by-model",
    ["Modell", "Requests", "Tokens", "Kosten"],
    (stats.byModel || []).map((r) => [
      `<code>${esc(r.model || "–")}</code>`,
      fmtInt(r.requests),
      fmtTokens(r.tokens),
      fmtUsd(r.costUsd),
    ]),
  );
  renderTable(
    "#by-key",
    ["Key", "Requests", "Tokens", "Kosten"],
    (stats.byKey || []).map((r) => [
      esc(r.name),
      fmtInt(r.requests),
      fmtTokens(r.tokens),
      fmtUsd(r.costUsd),
    ]),
  );
}

/** Fills in days with no traffic, so a 7-day range always shows 7 bars. */
function fillDays(byDay, days) {
  const found = new Map(byDay.map((d) => [d.day, d]));
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(found.get(key) ?? { day: key, requests: 0, tokens: 0, costUsd: 0 });
  }
  return out;
}

function renderChart(byDay, days) {
  const chart = $("#chart");
  const labels = $("#chart-labels");
  if (!byDay.length) {
    chart.innerHTML = '<div class="muted" style="align-self:center">Noch keine Daten.</div>';
    labels.innerHTML = "";
    return;
  }

  byDay = fillDays(byDay, days);
  // Beyond ~30 bars the day labels stop being readable, so thin them out.
  const labelEvery = Math.ceil(byDay.length / 12);
  const max = Math.max(...byDay.map((d) => d.requests), 1);
  chart.innerHTML = byDay
    .map(
      (d) =>
        `<div class="bar" style="height:${Math.max(
          2,
          (d.requests / max) * 100,
        )}%" title="${esc(d.day)}: ${fmtInt(d.requests)} Requests, ${fmtUsd(d.costUsd)}"></div>`,
    )
    .join("");
  labels.innerHTML = byDay
    .map((d, i) =>
      i % labelEvery === 0
        ? `<span>${esc(d.day.slice(5).replace("-", "."))}</span>`
        : "<span></span>",
    )
    .join("");
}

function renderTable(sel, headers, rows) {
  const table = $(sel);
  if (!rows.length) {
    table.innerHTML = `<tr><td class="muted" style="padding:14px 10px">Noch keine Daten.</td></tr>`;
    return;
  }
  table.innerHTML =
    `<thead><tr>${headers
      .map((h, i) => `<th${i ? ' class="right"' : ""}>${esc(h)}</th>`)
      .join("")}</tr></thead>` +
    `<tbody>${rows
      .map(
        (r) =>
          `<tr>${r
            .map((c, i) => `<td${i ? ' class="right nowrap"' : ""}>${c}</td>`)
            .join("")}</tr>`,
      )
      .join("")}</tbody>`;
}

/* ------------------------------------------------------------------ */
/* keys                                                                */
/* ------------------------------------------------------------------ */

async function loadKeys() {
  const { keys } = await api("/keys");
  state.keys = keys;

  const table = $("#keys-table");
  if (!keys.length) {
    table.innerHTML = `<tr><td class="muted" style="padding:18px 10px">
      Noch keine Keys. Lege einen an, um den Endpunkt zu nutzen.</td></tr>`;
    return;
  }

  table.innerHTML =
    `<thead><tr>
       <th>Name</th><th>Key</th><th>Status</th><th class="right">Requests/min</th>
       <th class="right">Budget</th><th class="right">Zuletzt</th><th></th>
     </tr></thead><tbody>` +
    keys
      .map((k) => {
        const expired = k.expiresAt && k.expiresAt < Date.now();
        const overBudget = k.budgetUsd != null && k.spentUsd >= k.budgetUsd;
        const status = expired
          ? '<span class="pill err">abgelaufen</span>'
          : !k.enabled
            ? '<span class="pill muted">deaktiviert</span>'
            : overBudget
              ? '<span class="pill warn">Budget erreicht</span>'
              : '<span class="pill ok">aktiv</span>';

        const budget =
          k.budgetUsd == null
            ? `<span class="muted">${fmtUsd(k.spentUsd)}</span>`
            : `${fmtUsd(k.spentUsd)} / ${fmtUsd(k.budgetUsd)}`;

        const models = k.allowedModels?.length
          ? `<br><span class="muted" style="font-size:11.5px">nur ${esc(
              k.allowedModels.join(", "),
            )}</span>`
          : "";

        return `<tr>
          <td><strong>${esc(k.name)}</strong>${
            k.note ? `<br><span class="muted" style="font-size:12px">${esc(k.note)}</span>` : ""
          }${models}</td>
          <td class="mono muted nowrap">${esc(k.keyPrefix)}…</td>
          <td>${status}</td>
          <td class="right">${k.rateLimitPerMin ?? '<span class="muted">∞</span>'}</td>
          <td class="right nowrap">${budget}</td>
          <td class="right muted nowrap">${k.lastUsedAt ? fmtDate(k.lastUsedAt) : "nie"}</td>
          <td class="right nowrap">
            <button class="ghost sm" data-toggle="${esc(k.id)}">${
              k.enabled ? "Deaktivieren" : "Aktivieren"
            }</button>
            <button class="ghost sm" data-reset="${esc(k.id)}">Budget&nbsp;0</button>
            <button class="ghost sm danger" data-del="${esc(k.id)}">Löschen</button>
          </td>
        </tr>`;
      })
      .join("") +
    "</tbody>";

  table.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", async () => {
      const key = state.keys.find((k) => k.id === b.dataset.toggle);
      await api("/keys/" + b.dataset.toggle, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !key.enabled }),
      });
      loadKeys();
    }),
  );
  table.querySelectorAll("[data-reset]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/keys/${b.dataset.reset}/reset-spend`, { method: "POST" });
      loadKeys();
    }),
  );
  table.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      const key = state.keys.find((k) => k.id === b.dataset.del);
      if (!confirm(`Key „${key.name}“ endgültig löschen? Anwendungen damit verlieren den Zugang.`))
        return;
      await api("/keys/" + b.dataset.del, { method: "DELETE" });
      loadKeys();
    }),
  );
}

$("#new-key").addEventListener("click", openNewKeyModal);

function closeModal() {
  $("#modal-root").innerHTML = "";
}

function openNewKeyModal() {
  const models = state.status?.models ?? [];
  $("#modal-root").innerHTML = `
    <div class="modal-backdrop">
      <form class="modal" id="key-form">
        <h3>Neuer API-Key</h3>
        <p class="sub">Das Geheimnis wird genau einmal angezeigt.</p>

        <label class="field">
          <span class="lbl">Name</span>
          <input id="k-name" required placeholder="z. B. Open WebUI" />
          <span class="hint">Am besten ein Key pro Anwendung.</span>
        </label>

        <label class="field">
          <span class="lbl">Notiz</span>
          <input id="k-note" placeholder="optional" />
        </label>

        <div class="grid cols-2">
          <label class="field">
            <span class="lbl">Rate-Limit</span>
            <input id="k-rate" type="number" min="1" placeholder="leer = unbegrenzt" />
            <span class="hint">Requests pro Minute</span>
          </label>
          <label class="field">
            <span class="lbl">Budget (USD)</span>
            <input id="k-budget" type="number" min="0" step="0.5" placeholder="leer = unbegrenzt" />
            <span class="hint">Geschätzt nach Listenpreis</span>
          </label>
        </div>

        <label class="field">
          <span class="lbl">Gültig bis</span>
          <input id="k-expires" type="date" />
          <span class="hint">Leer lassen für unbegrenzte Gültigkeit.</span>
        </label>

        <label class="field">
          <span class="lbl">Erlaubte Modelle</span>
          <div style="border:1px solid var(--border);border-radius:8px;padding:10px">
            ${models
              .map(
                (m) => `<div class="checkbox-row">
                  <input type="checkbox" id="m-${esc(m.id)}" value="${esc(m.id)}" />
                  <label for="m-${esc(m.id)}">${esc(m.label)}
                    <span class="muted mono">${esc(m.id)}</span></label>
                </div>`,
              )
              .join("")}
          </div>
          <span class="hint">Nichts auswählen = alle Modelle erlaubt.</span>
        </label>

        <div class="modal-actions">
          <button type="button" class="ghost" id="k-cancel">Abbrechen</button>
          <button type="submit" class="primary">Key erstellen</button>
        </div>
      </form>
    </div>`;

  $("#k-cancel").addEventListener("click", closeModal);
  $("#key-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const allowed = $$("#key-form input[type=checkbox]:checked").map((c) => c.value);
    const expires = $("#k-expires").value;

    const body = {
      name: $("#k-name").value.trim(),
      note: $("#k-note").value.trim() || null,
      rateLimitPerMin: $("#k-rate").value ? Number($("#k-rate").value) : null,
      budgetUsd: $("#k-budget").value ? Number($("#k-budget").value) : null,
      expiresAt: expires ? new Date(expires + "T23:59:59").getTime() : null,
      allowedModels: allowed.length ? allowed : null,
    };

    try {
      const { secret } = await api("/keys", { method: "POST", body: JSON.stringify(body) });
      showSecret(secret);
      loadKeys();
    } catch (ex) {
      alert(ex.message);
    }
  });
}

function showSecret(secret) {
  $("#modal-root").innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h3>Key erstellt</h3>
        <p class="sub">Jetzt kopieren — er wird nicht wieder angezeigt.</p>
        <div class="secret-box" id="secret-value">${esc(secret)}</div>
        <div class="modal-actions">
          <button id="copy-secret">Kopieren</button>
          <button class="primary" id="secret-done">Fertig</button>
        </div>
      </div>
    </div>`;

  $("#copy-secret").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(secret);
      e.target.textContent = "Kopiert";
    } catch {
      // Clipboard needs a secure context; select the text instead.
      const range = document.createRange();
      range.selectNodeContents($("#secret-value"));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      e.target.textContent = "Markiert — mit Strg+C kopieren";
    }
  });
  $("#secret-done").addEventListener("click", closeModal);
}

/* ------------------------------------------------------------------ */
/* logs                                                                */
/* ------------------------------------------------------------------ */

$("#refresh-logs").addEventListener("click", loadLogs);
$("#log-key").addEventListener("change", loadLogs);

async function loadLogs() {
  if (!state.keys.length) {
    const { keys } = await api("/keys");
    state.keys = keys;
  }

  const select = $("#log-key");
  const current = select.value;
  select.innerHTML =
    '<option value="">Alle Keys</option>' +
    state.keys.map((k) => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join("");
  select.value = current;

  const { logs } = await api("/logs?limit=200" + (current ? "&keyId=" + current : ""));
  const table = $("#logs-table");

  if (!logs.length) {
    table.innerHTML = `<tr><td class="muted" style="padding:18px 10px">Noch keine Requests.</td></tr>`;
    return;
  }

  table.innerHTML =
    `<thead><tr>
       <th>Zeit</th><th>Key</th><th>Modell</th><th>Status</th>
       <th class="right">Tokens</th><th class="right">Kosten</th><th class="right">Dauer</th>
     </tr></thead><tbody>` +
    logs
      .map((l) => {
        const ok = l.status < 400;
        const badge = ok
          ? `<span class="pill ok">${l.status}</span>`
          : `<span class="pill err" title="${esc(l.error || "")}">${l.status}</span>`;
        return `<tr>
          <td class="muted nowrap">${fmtTime(l.ts)}</td>
          <td>${esc(l.key_name || "–")}</td>
          <td><code>${esc(l.resolved_model || "–")}</code>${
            l.streamed ? ' <span class="pill muted">stream</span>' : ""
          }</td>
          <td>${badge}${
            l.error
              ? `<br><span class="muted" style="font-size:11.5px">${esc(
                  String(l.error).slice(0, 90),
                )}</span>`
              : ""
          }</td>
          <td class="right nowrap">${fmtInt(l.prompt_tokens)} / ${fmtInt(l.completion_tokens)}</td>
          <td class="right nowrap">${fmtUsd(l.cost_usd)}</td>
          <td class="right muted nowrap">${fmtInt(l.duration_ms)} ms</td>
        </tr>`;
      })
      .join("") +
    "</tbody>";
}

/* ------------------------------------------------------------------ */
/* playground                                                          */
/* ------------------------------------------------------------------ */

$("#pg-send").addEventListener("click", async () => {
  const btn = $("#pg-send");
  const out = $("#pg-output");
  const meta = $("#pg-meta");

  btn.disabled = true;
  btn.textContent = "Läuft …";
  out.textContent = "";
  meta.textContent = "";

  const messages = [];
  if ($("#pg-system").value.trim()) {
    messages.push({ role: "system", content: $("#pg-system").value.trim() });
  }
  messages.push({ role: "user", content: $("#pg-prompt").value });

  try {
    const r = await api("/test", {
      method: "POST",
      body: JSON.stringify({ model: $("#pg-model").value, messages }),
    });
    if (r.ok) {
      out.textContent = r.text || "(leere Antwort)";
      meta.textContent =
        `${r.usage.promptTokens} rein · ${r.usage.completionTokens} raus · ` +
        `${fmtUsd(r.costUsd)} · ${r.durationMs} ms · ${r.finishReason}`;
    } else {
      out.innerHTML = `<span class="pill err">Fehler</span>\n\n${esc(r.error)}`;
    }
  } catch (ex) {
    out.innerHTML = `<span class="pill err">Fehler</span>\n\n${esc(ex.message)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Senden";
  }
});

/* ------------------------------------------------------------------ */
/* connect                                                             */
/* ------------------------------------------------------------------ */

async function renderConnect() {
  const ep = state.endpoints ?? (state.endpoints = await api("/endpoints"));
  renderEndpointTable(ep);

  const base = ep.primary.baseUrl;
  $("#c-base").value = base;
  const key = $("#c-key").value || "sk-cp-…";
  const model = state.status?.defaultModel ?? "claude-opus-5";
  $("#c-base").dataset.base = base;

  $("#snip-curl").textContent = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hallo!"}]
  }'`;

  $("#snip-python").textContent = `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="${key}")

response = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hallo!"}],
)
print(response.choices[0].message.content)`;

  $("#snip-node").textContent = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: "${key}",
});

const res = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hallo!" }],
});
console.log(res.choices[0].message.content);`;

  $("#snip-env").textContent = `OPENAI_BASE_URL=${base}
OPENAI_API_KEY=${key}

# manche Tools nutzen stattdessen:
OPENAI_API_BASE=${base}`;
}

$("#c-key").addEventListener("input", renderConnect);

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  await loadDashboard();

  const select = $("#pg-model");
  select.innerHTML = (state.status?.models ?? [])
    .map(
      (m) =>
        `<option value="${esc(m.id)}"${
          m.id === state.status.defaultModel ? " selected" : ""
        }>${esc(m.label)}</option>`,
    )
    .join("");

  const page = location.hash.slice(1);
  navigate(
    ["dashboard", "keys", "logs", "playground", "connect", "settings"].includes(page)
      ? page
      : "dashboard",
  );
}

(async () => {
  const { authenticated } = await api("/session").catch(() => ({ authenticated: false }));
  if (authenticated) {
    showApp();
    await boot();
  } else {
    showLogin();
  }
})();

/* ------------------------------------------------------------------ */
/* endpoints                                                           */
/* ------------------------------------------------------------------ */

function renderEndpointCard(ep) {
  $("#ep-base").textContent = ep.primary.baseUrl;

  const alts = ep.alternatives ?? [];
  $("#ep-alternatives").innerHTML = alts.length
    ? alts
        .map((a) => `<div><code>${esc(a.baseUrl)}</code><span>${esc(a.label)}</span></div>`)
        .join("")
    : '<span class="muted">Keine weiteren Adressen erkannt.</span>';
}

function renderEndpointTable(ep) {
  const rows = [
    ["Base URL (das brauchst du)", ep.primary.baseUrl],
    ["Chat Completions", ep.primary.chat],
    ["Modell-Liste", ep.primary.models],
    ["Health (ohne Key)", ep.primary.health],
    ["Web-Interface", ep.primary.admin],
  ];

  $("#ep-table").innerHTML =
    "<tbody>" +
    rows
      .map(
        ([label, url]) =>
          `<tr><td style="white-space:nowrap">${esc(label)}</td>
             <td><code>${esc(url)}</code></td></tr>`,
      )
      .join("") +
    (ep.alternatives ?? [])
      .map(
        (a) =>
          `<tr><td style="white-space:nowrap">${esc(a.label)}<br>
             <span class="muted" style="font-size:11.5px">${esc(a.hint ?? "")}</span></td>
             <td><code>${esc(a.baseUrl)}</code></td></tr>`,
      )
      .join("") +
    "</tbody>";
}

/** Copy buttons name their source element via data-copy. */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (btn) {
    const el = document.getElementById(btn.dataset.copy);
    const text = el?.textContent || el?.value || "";
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Kopiert";
    } catch {
      btn.textContent = "Strg+C";
    }
    setTimeout(() => (btn.textContent = original), 1400);
    return;
  }

  const goto = e.target.closest("[data-goto]");
  if (goto) {
    e.preventDefault();
    navigate(goto.dataset.goto);
  }
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

const GROUPS = [
  {
    id: "backend",
    title: "Backend",
    hint: "Woher die Antworten kommen und womit sich der Proxy authentifiziert.",
  },
  {
    id: "model",
    title: "Modell & Antwortverhalten",
    hint: "Gilt für alle Requests, sofern der Client nichts anderes mitschickt.",
  },
  {
    id: "access",
    title: "Zugriff",
    hint: "Wer den Endpunkt nutzen darf und wie die Client-IP ermittelt wird.",
  },
  { id: "maintenance", title: "Wartung", hint: "Aufbewahrung der Protokolldaten." },
];

async function loadSettings() {
  const { fields } = await api("/settings");
  state.fields = fields;
  renderSettings(fields);
  refreshLoginUi();
}

function renderSettings(fields) {
  $("#settings-groups").innerHTML = GROUPS.map((g) => {
    const rows = fields.filter((f) => f.group === g.id).map(settingRow).join("");
    if (!rows) return "";
    return `<div class="card settings-group">
      <h3>${esc(g.title)}</h3>
      <p class="group-hint">${esc(g.hint)}</p>
      ${rows}
    </div>`;
  }).join("");

  $$("[data-reset-setting]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api("/settings/reset", {
        method: "POST",
        body: JSON.stringify({ key: btn.dataset.resetSetting }),
      });
      await loadSettings();
      settingsMessage("ok", "Auf den Ausgangswert zurückgesetzt.");
    }),
  );

  $$(".toggle input").forEach((box) =>
    box.addEventListener("change", () => {
      box.nextElementSibling.textContent = box.checked ? "An" : "Aus";
    }),
  );
}

function settingRow(f) {
  const id = "set-" + f.key;
  let control;

  if (f.type === "boolean") {
    control = `<label class="toggle">
      <input type="checkbox" id="${id}" data-key="${esc(f.key)}" ${
        f.value === "true" ? "checked" : ""
      } />
      <span>${f.value === "true" ? "An" : "Aus"}</span>
    </label>`;
  } else if (f.type === "select") {
    control = `<select id="${id}" data-key="${esc(f.key)}">${(f.options ?? [])
      .map(
        (o) =>
          `<option value="${esc(o.value)}"${o.value === f.value ? " selected" : ""}>${esc(
            o.label,
          )}</option>`,
      )
      .join("")}</select>`;
  } else if (f.type === "secret") {
    const hint = f.isSet
      ? "gesetzt — leer lassen, um ihn zu behalten"
      : "nicht gesetzt";
    control = `<input type="password" id="${id}" data-key="${esc(f.key)}"
      placeholder="${esc(hint)}" autocomplete="new-password" />`;
  } else {
    control = `<input type="${f.type === "number" ? "number" : "text"}" id="${id}"
      data-key="${esc(f.key)}" value="${esc(f.value)}"
      ${f.min !== undefined ? `min="${f.min}"` : ""} ${
        f.max !== undefined ? `max="${f.max}"` : ""
      } />`;
  }

  const meta = [];
  if (f.overridden) {
    meta.push('<span class="pill muted">hier gesetzt</span>');
    meta.push(`<button class="ghost sm" data-reset-setting="${esc(f.key)}">Zurücksetzen</button>`);
  } else if (f.envPresent) {
    meta.push('<span class="pill muted">aus der Umgebung</span>');
  } else {
    meta.push('<span class="pill muted">Standard</span>');
  }

  return `<div class="setting-row">
    <div>
      <div class="setting-label">${esc(f.label)}</div>
      <div class="setting-desc">${esc(f.description)}</div>
    </div>
    <div class="setting-control">
      ${control}
      <div class="setting-meta">${meta.join("")}</div>
    </div>
  </div>`;
}

function settingsMessage(kind, text) {
  $("#settings-msg").innerHTML = `<div class="banner ${kind}">${esc(text)}</div>`;
  if (kind === "ok") setTimeout(() => ($("#settings-msg").innerHTML = ""), 4000);
}

$("#save-settings").addEventListener("click", async () => {
  const btn = $("#save-settings");
  const patch = {};

  for (const f of state.fields) {
    const el = document.getElementById("set-" + f.key);
    if (!el) continue;
    patch[f.key] = f.type === "boolean" ? (el.checked ? "true" : "false") : el.value;
  }

  btn.disabled = true;
  btn.textContent = "Speichert …";
  try {
    await api("/settings", { method: "PUT", body: JSON.stringify(patch) });
    await loadSettings();
    settingsMessage("ok", "Gespeichert. Die Änderungen gelten ab sofort.");
    state.status = await api("/status");
  } catch (ex) {
    settingsMessage("err", ex.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Speichern";
  }
});

/* ---------------- Claude sign-in ---------------- */

let loginPoll = null;

async function refreshLoginUi() {
  let s;
  try {
    s = await api("/claude-login/status");
  } catch {
    return;
  }

  const box = $("#login-status");
  const stepStart = $("#login-step-start");
  const stepUrl = $("#login-step-url");
  const log = $("#login-log");
  if (!box) return;

  const tokenField = state.fields.find((f) => f.key === "CLAUDE_CODE_OAUTH_TOKEN");
  const haveCredentials = tokenField?.isSet || s.credentialsPresent;

  if (s.state === "waiting_for_code" || s.state === "exchanging") {
    stepStart.classList.add("hidden");
    stepUrl.classList.remove("hidden");
    if (s.url) {
      $("#login-url").textContent = s.url;
      $("#login-url").href = s.url;
    }
    box.innerHTML =
      s.state === "exchanging"
        ? '<div class="banner warn">Code wird geprüft …</div>'
        : s.message
          ? `<div class="banner err">${esc(s.message)}</div>`
          : "";
    $("#login-submit").disabled = s.state === "exchanging";
  } else {
    stepStart.classList.remove("hidden");
    stepUrl.classList.add("hidden");

    if (s.state === "done") {
      box.innerHTML = `<div class="banner ok">${esc(s.message ?? "Angemeldet.")}</div>`;
    } else if (s.state === "error") {
      box.innerHTML = `<div class="banner err">${esc(
        s.message ?? "Anmeldung fehlgeschlagen.",
      )}</div>`;
    } else if (haveCredentials) {
      box.innerHTML =
        '<div class="banner ok">Angemeldet — es liegen Claude-Zugangsdaten vor. ' +
        "Eine erneute Anmeldung ersetzt sie.</div>";
    } else {
      box.innerHTML =
        '<div class="banner warn">Noch nicht angemeldet. Ohne Zugangsdaten kann das ' +
        "Backend „Claude-Abo“ keine Anfragen beantworten.</div>";
    }
  }

  const wrap = $("#login-log-wrap");
  if (s.tail) {
    log.textContent = s.tail;
    wrap.classList.remove("hidden");
    // Open it unprompted when something went wrong — that is when it matters.
    if (s.state === "error" || (s.message && s.state === "waiting_for_code")) {
      wrap.open = true;
    }
  } else {
    wrap.classList.add("hidden");
  }

  const active = s.state === "waiting_for_code" || s.state === "exchanging";
  if (active && !loginPoll) loginPoll = setInterval(refreshLoginUi, 2500);
  if (!active && loginPoll) {
    clearInterval(loginPoll);
    loginPoll = null;
  }
}

$("#login-start").addEventListener("click", async () => {
  const btn = $("#login-start");
  btn.disabled = true;
  btn.textContent = "Startet …";
  $("#login-status").innerHTML =
    '<div class="banner warn">Die Claude-CLI wird gestartet, das dauert einen Moment …</div>';
  try {
    const r = await api("/claude-login/start", { method: "POST" });
    if (!r.ok && r.error) {
      $("#login-status").innerHTML = `<div class="banner err">${esc(r.error)}</div>`;
    }
  } catch (ex) {
    $("#login-status").innerHTML = `<div class="banner err">${esc(ex.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Bei Claude anmelden";
    await refreshLoginUi();
  }
});

$("#login-submit").addEventListener("click", async () => {
  const code = $("#login-code").value.trim();
  if (!code) return;

  const btn = $("#login-submit");
  btn.disabled = true;
  try {
    await api("/claude-login/code", { method: "POST", body: JSON.stringify({ code }) });
    $("#login-code").value = "";
    // The exchange takes a moment; the poller reports the outcome.
    setTimeout(async () => {
      await loadSettings();
      state.status = await api("/status");
    }, 3000);
  } catch (ex) {
    $("#login-status").innerHTML = `<div class="banner err">${esc(ex.message)}</div>`;
  } finally {
    btn.disabled = false;
    await refreshLoginUi();
  }
});

$("#login-cancel").addEventListener("click", async () => {
  await api("/claude-login/cancel", { method: "POST" }).catch(() => {});
  await refreshLoginUi();
});

/* ---------------- admin password ---------------- */

$("#pw-save").addEventListener("click", async () => {
  const msg = $("#pw-msg");
  try {
    await api("/password", {
      method: "POST",
      body: JSON.stringify({ current: $("#pw-current").value, next: $("#pw-next").value }),
    });
    msg.innerHTML = '<div class="banner ok">Passwort geändert.</div>';
    $("#pw-current").value = "";
    $("#pw-next").value = "";
  } catch (ex) {
    msg.innerHTML = `<div class="banner err">${esc(ex.message)}</div>`;
  }
});

/* ---------------- connectivity check ---------------- */

$("#diag-run").addEventListener("click", async () => {
  const btn = $("#diag-run");
  const out = $("#diag-result");
  btn.disabled = true;
  btn.textContent = "Prüft …";
  out.innerHTML = '<div class="banner warn">Prüfe die Verbindung zu den Anthropic-Hosts …</div>';

  try {
    const d = await api("/diagnostics");
    const rows = d.hosts
      .map((h) => {
        const dnsOk = h.dns.ok;
        const netOk = h.https.ok;
        const badge = !dnsOk
          ? '<span class="pill err">DNS fehlgeschlagen</span>'
          : !netOk
            ? '<span class="pill err">nicht erreichbar</span>'
            : `<span class="pill ok">erreichbar</span> <span class="muted">${h.https.ms} ms</span>`;
        const detail = !dnsOk
          ? esc(h.dns.error || "")
          : !netOk
            ? esc(h.https.error || "")
            : "";
        return `<tr>
          <td><code>${esc(h.host)}</code><br>
              <span class="muted" style="font-size:11.5px">${esc(h.purpose)}</span></td>
          <td class="right">${badge}${
            detail ? `<br><span class="muted" style="font-size:11.5px">${detail}</span>` : ""
          }</td>
        </tr>`;
      })
      .join("");

    out.innerHTML =
      `<div class="banner ${d.reachable ? "ok" : "err"}">${esc(d.summary)}</div>` +
      `<div class="table-wrap"><table><tbody>${rows}</tbody></table></div>`;
  } catch (ex) {
    out.innerHTML = `<div class="banner err">${esc(ex.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Verbindung prüfen";
  }
});
