# Claude → OpenAI Proxy

Ein OpenAI-kompatibler Endpunkt vor Claude, mit API-Key-Verwaltung und Web-Interface,
lauffähig als einzelner Docker-Container.

Jede Anwendung, die mit der OpenAI-API spricht, kann damit Claude nutzen — Base-URL und
Key eintragen, fertig.

```
Deine Apps ──► http://proxy:3000/v1  ──►  Claude
(OpenAI-API)      Keys · Limits · Logs      (Abo oder API-Key)
```

---

## Was drin ist

| | |
|---|---|
| **OpenAI-Endpunkt** | `/v1/chat/completions` (Streaming + non-Streaming), `/v1/models`, `/v1/completions` |
| **Zwei Backends** | Claude-Abo (Pro/Max, ohne Token-Abrechnung) oder Anthropic-API-Key |
| **Key-Verwaltung** | Beliebig viele Keys, je mit Rate-Limit, Budget, Modell-Whitelist, Ablaufdatum |
| **Web-Interface** | Übersicht, Keys, Logs, Playground, fertige Code-Snippets — unter `/admin` |
| **Modell-Aliase** | `gpt-4o`, `gpt-4`, `gpt-3.5-turbo` … werden auf Claude-Modelle gemappt |
| **Nutzungs-Tracking** | Requests, Tokens und geschätzte Kosten pro Key und Modell |
| **Vision** | Bilder werden durchgereicht (`image_url`, auch als `data:`-URI) |
| **Function Calling** | Vollständig im `anthropic-api`-Backend |

---

## Schnellstart

```bash
cp .env.example .env
```

### 1. Backend wählen

**Variante A — Claude-Abo (Pro/Max).** Keine Abrechnung pro Token, es gelten die
Rate-Limits deines Abos.

```bash
docker compose build
docker compose run --rm claude-proxy claude setup-token
```

Der Befehl zeigt eine URL. Im Browser öffnen, anmelden, den zurückgegebenen Token
kopieren und in die `.env` eintragen:

```
BACKEND=claude-code
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

Der Token ist ein Jahr gültig.

**Variante B — Anthropic-API-Key.** Abrechnung pro Token, dafür mit Function Calling.

```
BACKEND=anthropic-api
ANTHROPIC_API_KEY=sk-ant-api03-...
```

**Variante C — erst mal ohne alles testen.** Ein Echo-Backend, das die komplette
Kette bedient, damit du deine Anwendung anbinden kannst, bevor Zugangsdaten stehen.

```
BACKEND=mock
```

### 2. Starten

```bash
docker compose up -d
```

### 3. Einloggen

Das Web-Interface läuft auf <http://localhost:3000/admin>.

Ohne gesetztes `ADMIN_PASSWORD` wird beim ersten Start eines erzeugt und in die Logs
geschrieben:

```bash
docker compose logs claude-proxy | grep -A2 "Admin password"
```

### 4. Key anlegen und anbinden

Unter **API-Keys → Neuer Key** einen Key erzeugen. Das Geheimnis wird genau einmal
angezeigt. Unter **Anbinden** stehen fertige Snippets für curl, Python und Node.

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="sk-cp-...")

r = client.chat.completions.create(
    model="claude-opus-5",
    messages=[{"role": "user", "content": "Hallo!"}],
)
print(r.choices[0].message.content)
```

---

## Unraid

Das Template liegt in [`unraid/claude-proxy.xml`](unraid/claude-proxy.xml).

### Einmalig: Image veröffentlichen

Das Image wird bei jedem Push nach `main` von GitHub Actions gebaut und nach
`ghcr.io/gottschalkfelix4-source/claudproxy:latest` gepusht. **GHCR-Pakete sind
anfangs privat** — Unraid kann es dann nicht ziehen. Nach dem ersten
erfolgreichen Build einmal umstellen:

GitHub → Profil → **Packages** → `claudproxy` → *Package settings* → *Change
visibility* → **Public**.

### Container anlegen

Auf dem Unraid-Server unter **Docker → Add Container** ganz oben ins Feld
*Template* die URL einfügen:

```
https://raw.githubusercontent.com/gottschalkfelix4-source/claudproxy/main/unraid/claude-proxy.xml
```

Alternativ die XML nach `/boot/config/plugins/dockerMan/templates-user/` legen;
sie taucht dann in der Vorlagenliste auf.

Danach nur noch **Backend** wählen und **Apply**. Die Vorgaben passen für Unraid:
Daten unter `/mnt/user/appdata/claude-proxy/`, PUID 99 / PGID 100.

### Anmeldung für das Abo-Backend

1. Container starten (zunächst ohne Token — er meldet sich als „degraded", das ist erwartet).
2. Auf der Docker-Seite auf das Container-Icon klicken → **Console**.
3. Dort `claude setup-token` ausführen, die angezeigte URL im Browser öffnen, anmelden.
4. Den ausgegebenen Token in **Edit → Claude OAuth Token** eintragen, Container neu starten.

Das Feld ist als Passwort maskiert, ebenso der Anthropic-API-Key und das
Admin-Passwort.

Web-Interface danach unter `http://<unraid-ip>:3000/admin`, der Endpunkt für
andere Container unter `http://<unraid-ip>:3000/v1`.

### Rechte

Der Container startet als root, gleicht die Eigentümerschaft der gemounteten
Verzeichnisse an `PUID:PGID` an und legt die Rechte erst dann ab — deshalb kann
`claude setup-token` in ein appdata-Verzeichnis schreiben, das `nobody:users`
gehört. Wer das nicht will, startet mit `--user` und überspringt den Schritt.

---

## Die beiden Backends im Vergleich

| | `claude-code` (Abo) | `anthropic-api` (API-Key) |
|---|---|---|
| Abrechnung | Im Abo enthalten | Pro Token |
| Limits | Abo-Rate-Limits | API-Rate-Limits |
| Streaming | ✅ | ✅ |
| Vision | ✅ | ✅ |
| System-Prompt | ✅ | ✅ |
| Function Calling | ❌ | ✅ |
| Mehrere Turns | Verlauf wird serialisiert (siehe unten) | Nativ |
| Kostenangabe | Schätzung des Harness | Nach Listenpreis |

**Zur Serialisierung:** Der Claude-Code-Harness nimmt über seinen Eingabekanal nur
*User*-Nachrichten entgegen. Ein mehrstufiger Verlauf kann deshalb nicht Zug um Zug
eingespielt werden — frühere Turns werden in einen Transcript-Block innerhalb der
einzigen User-Nachricht geschrieben, der neueste Turn bleibt unverändert. In der
Praxis funktioniert das gut; wer native Mehrfach-Turns und Function Calling braucht,
nimmt das `anthropic-api`-Backend.

---

## Anwendungen anbinden

Die meisten Tools brauchen nur zwei Werte:

```
OPENAI_BASE_URL=http://localhost:3000/v1
OPENAI_API_KEY=sk-cp-...
```

Läuft die Anwendung selbst in Docker, ist die Adresse aus deren Sicht
`http://claude-proxy:3000/v1` — sofern beide im selben Compose-Netz hängen.

| Anwendung | Wo eintragen |
|---|---|
| **Open WebUI** | Settings → Connections → OpenAI API |
| **LibreChat** | `librechat.yaml`, Custom Endpoint |
| **Continue** (VS Code) | `config.json`, Provider `openai` mit `apiBase` |
| **Aider** | `--openai-api-base` / `--openai-api-key` |
| **LangChain** | `ChatOpenAI(base_url=..., api_key=...)` |
| **Cursor** | Settings → Models → OpenAI API Key → Override Base URL |

Sendet eine Anwendung fest verdrahtet `gpt-4o`, wird das automatisch auf
`claude-opus-5` gemappt — sie muss nicht angepasst werden.

---

## Modelle

| Modell-ID | Kontext | $/1M rein | $/1M raus |
|---|---|---|---|
| `claude-opus-5` | 1M | 5 | 25 |
| `claude-fable-5` | 1M | 10 | 50 |
| `claude-opus-4-8` | 1M | 5 | 25 |
| `claude-sonnet-5` | 1M | 2 | 10 |
| `claude-haiku-4-5` | 200K | 1 | 5 |

Preise dienen nur der Kostenschätzung im Dashboard und der Budget-Durchsetzung — im
`claude-code`-Backend fällt keine Abrechnung pro Token an.

**Aliase:** `opus`, `sonnet`, `haiku`, `gpt-4`, `gpt-4o`, `gpt-4-turbo`, `gpt-5`,
`o1`, `o3` → Opus 5 · `gpt-4o-mini`, `gpt-3.5-turbo` → Haiku 4.5 · `gpt-5-mini` →
Sonnet 5. Präfixe wie `anthropic/` oder `openai/` werden abgeschnitten, Datums-Suffixe
ebenfalls.

Ein Modell, das auch darüber nicht aufzulösen ist (etwa `llama-3-70b`), landet auf
`DEFAULT_MODEL`, statt den Request abzulehnen — damit eine Anwendung mit fest
verdrahtetem Modellnamen nicht ins Leere läuft. Wer Fehler statt stiller Umleitung
will, setzt pro Key eine Modell-Whitelist; dann gibt es ein `403`.

---

## API-Keys

Jeder Key kann einzeln beschränkt werden:

- **Rate-Limit** — Requests pro Minute
- **Budget** — Obergrenze in USD (geschätzt); danach `429`
- **Modell-Whitelist** — nur bestimmte Modelle nutzbar
- **Ablaufdatum**
- **Aktiv/inaktiv** — abschalten, ohne zu löschen

Gespeichert wird nur ein SHA-256-Hash. Ein verlorener Key lässt sich nicht
wiederherstellen, nur ersetzen.

---

## Endpunkte

| Methode | Pfad | |
|---|---|---|
| `POST` | `/v1/chat/completions` | Streaming und non-Streaming |
| `GET` | `/v1/models` | Modell-Liste |
| `GET` | `/v1/models/{id}` | Einzelnes Modell |
| `POST` | `/v1/completions` | Legacy, ohne Streaming |
| `POST` | `/v1/embeddings` | `501` — Anthropic bietet keine Embeddings |
| `GET` | `/health` | Statusprüfung, kein Key nötig |
| | `/admin` | Web-Interface |

Unterstützte Request-Felder: `model`, `messages`, `stream`, `stream_options`,
`max_tokens` / `max_completion_tokens`, `stop`, `tools` / `functions`, `tool_choice`,
`response_format`, `reasoning_effort`, `user`.

`temperature` und `top_p` werden angenommen, aber verworfen: die aktuelle
Claude-Generation lehnt Sampling-Parameter mit `400` ab. Sie durchzureichen würde jeden
Request scheitern lassen, der von einem üblichen OpenAI-Client kommt.

---

## Konfiguration

Alle Einstellungen sind Umgebungsvariablen, dokumentiert in
[`.env.example`](.env.example). Die wichtigsten:

| Variable | Default | |
|---|---|---|
| `BACKEND` | `claude-code` | `claude-code`, `anthropic-api` oder `mock` |
| `DEFAULT_MODEL` | `claude-opus-5` | Wenn der Client kein Modell schickt |
| `DEFAULT_EFFORT` | *(API-Default)* | `low` … `max`; senkt Kosten und Latenz |
| `EXPOSE_THINKING` | `false` | Gedankengang als `reasoning_content` mitliefern |
| `REQUIRE_AUTH` | `true` | Nur in vertrauenswürdigen Netzen abschalten |
| `MAX_TOKENS_LIMIT` | `64000` | Obergrenze pro Request |
| `LOG_RETENTION_DAYS` | `30` | `0` = nie löschen |

---

## Betrieb

```bash
docker compose logs -f claude-proxy     # Logs
docker compose restart claude-proxy     # Neustart
docker compose down                     # Stoppen (Daten bleiben)
curl localhost:3000/health              # Status
```

Zwei benannte Volumes halten den Zustand: `proxy-data` (SQLite-Datenbank mit Keys,
Nutzung, Einstellungen) und `claude-config` (Claude-Code-Zugangsdaten). Beide
überstehen ein `docker compose down` und einen Rebuild.

**Backup:**

```bash
docker compose cp claude-proxy:/data/proxy.db ./proxy-backup.db
```

Unter Unraid liegt dieselbe Datei direkt unter
`/mnt/user/appdata/claude-proxy/data/proxy.db` und wird vom appdata-Backup
miterfasst.

---

## Sicherheit

Der Proxy ist für ein privates Netz gedacht. Wenn er aus dem Internet erreichbar sein
soll:

- Einen Reverse Proxy mit TLS davorsetzen und `TRUST_PROXY=true` setzen
- Ein starkes `ADMIN_PASSWORD` vergeben
- `REQUIRE_AUTH` auf `true` lassen
- Den Port nur lokal binden (`127.0.0.1:3000:3000`), wenn nur der Reverse Proxy
  zugreifen soll

Das Admin-Login ist gegen Brute-Force gesichert (8 Fehlversuche pro IP, dann fünf
Minuten Sperre). Sessions laufen nach zwölf Stunden ab.

---

## Ohne Docker

```bash
npm install
npm run build
BACKEND=mock ADMIN_PASSWORD=geheim npm start
```

Braucht Node ≥ 22.5 wegen des eingebauten `node:sqlite`.

**Tests** decken die OpenAI-↔-Anthropic-Übersetzung und die Modellauflösung ab:

```bash
npm test
```

---

## Fehlersuche

**„Backend ist nicht einsatzbereit"** — `/health` und das Dashboard nennen den Grund.
Meist fehlt `CLAUDE_CODE_OAUTH_TOKEN` oder `ANTHROPIC_API_KEY`.

**`401` vom Claude-Code-Backend** — Token abgelaufen. Neu erzeugen:

```bash
docker compose run --rm claude-proxy claude setup-token
```

**`429` trotz freiem Rate-Limit** — Beim `claude-code`-Backend greifen die Limits
deines Abos. Das Dashboard zeigt den Fehlertext des Requests.

**Client bekommt `400` bei `temperature`** — Sollte nicht vorkommen; der Proxy
entfernt Sampling-Parameter. Falls doch, den Fehlertext aus den Logs melden.

**Streaming bricht ab** — Ein Reverse Proxy puffert SSE. Bei nginx:
`proxy_buffering off;`.

---

## Aufbau

```
src/
  index.ts          Express-App, Boot
  config.ts         Umgebungsvariablen
  db.ts             SQLite: Keys, Nutzung, Einstellungen
  auth.ts           API-Key-Prüfung, Admin-Session
  models.ts         Modell-Registry, Aliase, Kostenschätzung
  translate.ts      OpenAI ↔ Anthropic, beide Richtungen
  types.ts          Gemeinsame Typen, Engine-Interface
  engines/
    claudeCode.ts   Abo-Backend über den Claude-Agent-SDK
    anthropicApi.ts API-Backend
    mock.ts         Echo-Backend zum Testen
  routes/
    v1.ts           OpenAI-Endpunkte
    admin.ts        Admin-API
  web/              Web-Interface (Vanilla JS, keine externen Assets)
```

Die Engines teilen sich ein schmales Interface (`complete` und `stream`), sodass die
OpenAI-Übersetzung nur einmal existiert und für beide Backends gilt.
