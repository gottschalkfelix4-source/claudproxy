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

let state = { status: null, keys: [] };

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
}

/* ------------------------------------------------------------------ */
/* dashboard                                                           */
/* ------------------------------------------------------------------ */

$("#refresh").addEventListener("click", loadDashboard);
$("#range").addEventListener("change", loadDashboard);

async function loadDashboard() {
  const days = $("#range").value;
  const [status, stats] = await Promise.all([api("/status"), api("/stats?days=" + days)]);
  state.status = status;

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

  $("#dash-sub").textContent = `Version ${status.version} · läuft seit ${Math.floor(
    status.uptimeSeconds / 60,
  )} min`;

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

function renderConnect() {
  const base = location.origin + "/v1";
  $("#c-base").value = base;
  const key = $("#c-key").value || "sk-cp-…";
  const model = state.status?.defaultModel ?? "claude-opus-5";

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
  navigate(["dashboard", "keys", "logs", "playground", "connect"].includes(page) ? page : "dashboard");
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
