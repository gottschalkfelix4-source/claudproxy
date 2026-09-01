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
| **Web-Interface** | Übersicht, Keys, Logs, Playground, Einstellungen, Code-Snippets — unter `/admin` |
| **Alles im Browser** | Claude-Anmeldung und sämtliche Einstellungen; kein Neustart, keine Shell nötig |
| **Modell-Aliase** | `gpt-4o`, `gpt-4`, `gpt-3.5-turbo` … werden auf Claude-Modelle gemappt |
| **Nutzungs-Tracking** | Requests, Tokens und geschätzte Kosten pro Key und Modell |
| **Vision** | Bilder werden durchgereicht (`image_url`, auch als `data:`-URI) |
| **Function Calling** | Vollständig im `anthropic-api`-Backend |

---

## Schnellstart

```bash
cp .env.example .env
```

### 1. Starten

```bash
docker compose up -d
```

In die `.env` muss dafür nichts eingetragen werden — alles Weitere passiert im
Browser.

### 2. Einloggen

Das Web-Interface läuft auf <http://localhost:3000/admin>.

Ohne gesetztes `ADMIN_PASSWORD` wird beim ersten Start eines erzeugt und in die Logs
geschrieben:

```bash
docker compose logs claude-proxy | grep -A2 "Admin password"
```

Unter **Einstellungen** lässt es sich anschließend ändern.

### 3. Backend wählen

Unter **Einstellungen → Backend**:

- **Claude-Abo (Pro/Max)** — keine Abrechnung pro Token, es gelten die Rate-Limits
  deines Abos. Dafür in derselben Ansicht auf **Bei Claude anmelden** klicken: der
  angezeigte Link führt zur Anmeldung, den Code danach zurück ins Formular kopieren.
  Der Token wird gespeichert und ist ein Jahr gültig.
- **Anthropic API-Key** — Abrechnung pro Token, dafür mit Function Calling. Key
  direkt ins Feld eintragen.
- **Mock** — Echo-Backend ohne Zugangsdaten, um eine Anwendung anzubinden, bevor
  Credentials stehen.

Änderungen greifen sofort; ein Neustart ist nie nötig.

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

## Einstellungen

Alles unter **Einstellungen** im Web-Interface — Backend und Zugangsdaten,
Standardmodell, Reasoning Effort, Token-Grenzen, Key-Pflicht, Log-Aufbewahrung und
das Admin-Passwort. Änderungen wirken sofort auf den nächsten Request; ein Neustart
ist nicht nötig.

**Verhältnis zu den Umgebungsvariablen:** Die Werte aus `.env` beziehungsweise dem
Unraid-Template sind die Startwerte. Sobald ein Feld im Interface geändert wird,
landet es in der Datenbank und hat Vorrang. Jedes Feld zeigt seine Herkunft an —
*Standard*, *aus der Umgebung* oder *hier gesetzt* — und ein *Zurücksetzen* neben
einem selbst gesetzten Wert stellt den Umgebungswert wieder her.

Änderst du eine Umgebungsvariable, greift sie beim nächsten Start nur, wenn das Feld
nicht im Interface überschrieben wurde. Ausnahme ist `ADMIN_PASSWORD`: ein dort
geänderter Wert wird übernommen, ein unverändertes überschreibt ein im Interface
gesetztes Passwort dagegen nicht.

Nur diese Werte brauchen weiterhin einen Neustart, weil sie beim Start gebunden
werden: `PORT`, `HOST`, `DATA_DIR`, `CLAUDE_CONFIG_DIR`, `ENABLE_WEB_UI`, `PUID`,
`PGID`.

### Claude-Anmeldung im Browser

Der Proxy startet dafür `claude setup-token` als Unterprozess unter einem Pseudo-Terminal
(`script(1)`, Teil von util-linux und im Image enthalten — daher keine native
Abhängigkeit), liest die OAuth-URL aus dessen Ausgabe und reicht den Code, den du
einfügst, an dessen Eingabe weiter. Der Token landet anschließend in den
Einstellungen.

**Wichtig zu wissen:** `claude setup-token` schreibt *keine* Anmeldedatei — es gibt
den Token ausschließlich auf dem Terminal aus („Store this token securely. You won't
be able to see it again."). Die Terminalausgabe ist damit die einzige Quelle, weshalb
der Proxy den ausgelesenen Token vor dem Speichern auf Vollständigkeit prüft und
einen zu kurzen gar nicht erst übernimmt.

Eine gemountete `~/.claude` aus einem echten `claude login` funktioniert ebenfalls:
der Token daraus wird beim Request in die Umgebung übernommen. Ohne das schlägt der
SDK-Pfad mit „Not logged in" fehl, selbst wenn die Datei vorhanden ist.

Beim Absenden des Codes sind zwei Details entscheidend, die beide zu einer stumm
hängenden Anmeldung führen, wenn man sie falsch macht:

- **Carriage Return statt Newline.** Die CLI hält das Pseudo-Terminal im Raw-Modus
  und wertet nur CR als Enter; ein LF wird verschluckt.
- **Das Enter muss getrennt geschrieben werden.** Die CLI aktiviert Bracketed Paste
  und behandelt einen großen Einzel-Write als eingefügten Text — darin ist ein CR
  Inhalt, keine Bestätigung. Gemessen: zusammen geschrieben funktioniert es bis
  etwa 48 Zeichen und wird darüber stillschweigend geschluckt. Ein echter
  OAuth-Code ist `code#state` und rund 90 Zeichen lang, fällt also genau in diesen
  Bereich. Der Proxy schreibt deshalb erst den Code und 80 ms später das CR.

Lehnt der OAuth-Server den Code ab, meldet die CLI das und wartet auf „Press Enter
to retry"; der Proxy beantwortet diesen Prompt selbst, sodass das Formular sofort
wieder aufnahmebereit ist. Kommt binnen 90 Sekunden gar keine Antwort, kehrt es
ebenfalls zur Code-Eingabe zurück. Der Link bleibt in beiden Fällen gültig.

---

## Unraid

Das Template liegt in [`unraid/claude-proxy.xml`](unraid/claude-proxy.xml).

### Das Image

Wird bei jedem Push nach `main` von GitHub Actions gebaut und nach
`ghcr.io/gottschalkfelix4-source/claudproxy:latest` veröffentlicht. Es ist ohne
Anmeldung ziehbar, Unraid kommt also direkt heran — nichts weiter zu tun.

Sollte ein späterer Build das Paket doch privat anlegen (Unraid meldet dann
„manifest unknown" oder „unauthorized"), lässt sich das umstellen unter GitHub →
Profil → **Packages** → `claudproxy` → *Package settings* → *Change visibility* →
**Public**.

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

### Einrichten

Im Template selbst muss nichts ausgefüllt werden — die Felder dort sind nur
Startwerte, alles Weitere passiert im Web-Interface unter
`http://<unraid-ip>:3000/admin`.

1. Container starten. Ohne Token meldet er sich als „degraded" — das ist erwartet.
2. Das Admin-Passwort steht im Container-Log, falls du keines gesetzt hast.
3. Unter **Einstellungen** das Backend wählen und beim Claude-Abo auf **Bei Claude
   anmelden** klicken. Kein Zugriff auf die Container-Console nötig.

Der Endpunkt für andere Container lautet `http://<unraid-ip>:3000/v1`; die Adressen
stehen auch in der Übersicht und unter „Anbinden".

### Aktualisieren

Ein Neustart des Containers zieht **kein** neues Image — er startet dasselbe noch
einmal. Für eine neue Version auf der Docker-Seite unten **Check for Updates**
klicken; bei `claude-proxy` erscheint dann *update ready* → **Apply Update**.
Alternativ auf den Container klicken → **Force Update**.

Welche Version gerade läuft, steht in der Übersicht des Web-Interface unter der
Überschrift (Version, Build-Kürzel und Datum) und in `/health`:

```bash
curl -s http://<unraid-ip>:3000/health
```

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
| `GET` | `/health` | Läuft der Dienst? Immer `200`, Details im Body. Kein Key nötig |
| `GET` | `/ready` | Ist ein Backend einsatzbereit? `503`, solange nicht konfiguriert |
| | `/admin` | Web-Interface |

Unterstützte Request-Felder: `model`, `messages`, `stream`, `stream_options`,
`max_tokens` / `max_completion_tokens`, `stop`, `tools` / `functions`, `tool_choice`,
`response_format`, `reasoning_effort`, `user`.

`temperature` und `top_p` werden angenommen, aber verworfen: die aktuelle
Claude-Generation lehnt Sampling-Parameter mit `400` ab. Sie durchzureichen würde jeden
Request scheitern lassen, der von einem üblichen OpenAI-Client kommt.

---

## Konfiguration

Die Umgebungsvariablen sind die **Startwerte**; im laufenden Betrieb änderst du
alles unter [Einstellungen](#einstellungen) im Web-Interface. Vollständig
dokumentiert in [`.env.example`](.env.example), die wichtigsten:

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

**`401` vom Claude-Code-Backend** — Token abgelaufen. Unter **Einstellungen → Bei
Claude anmelden** neu anmelden. Wer lieber die Kommandozeile nimmt:

```bash
docker compose exec claude-proxy claude setup-token
```

**`429` trotz freiem Rate-Limit** — Beim `claude-code`-Backend greifen die Limits
deines Abos. Das Dashboard zeigt den Fehlertext des Requests.

**Client bekommt `400` bei `temperature`** — Sollte nicht vorkommen; der Proxy
entfernt Sampling-Parameter. Falls doch, den Fehlertext aus den Logs melden.

**Streaming bricht ab** — Ein Reverse Proxy puffert SSE. Bei nginx:
`proxy_buffering off;`.

**Eine Umgebungsvariable wirkt nicht** — Das Feld wurde vermutlich im Web-Interface
überschrieben; dort steht dann *hier gesetzt* daneben. Ein Klick auf *Zurücksetzen*
gibt den Umgebungswert wieder frei.

**Der Container gilt als „unhealthy"** — Bei Versionen vor dem 01.09.2026 gab
`/health` ein `503` zurück, solange kein Backend konfiguriert war; Docker und Unraid
werteten das als kranken Container, obwohl das Web-Interface lief. Aktualisiere das
Image. Seitdem antwortet `/health` mit `200`, sobald der Dienst läuft; die
Backend-Bereitschaft steht im Body und unter `/ready`.

**Ein Fix wirkt nicht** — Prüfe zuerst, welche Version läuft: in der Übersicht unter
der Überschrift, oder `curl -s http://<host>:3000/health`. Ein Container-Neustart
zieht kein neues Image, dafür braucht es *Force Update* (Unraid) beziehungsweise
`docker compose pull && docker compose up -d`.

**Die Anmeldung endet stumm im Timeout, das Protokoll zeigt den Code als Sternchen
und danach nichts** — Das war ein Fehler in Versionen vor dem 01.09.2026: das Enter
wurde zusammen mit dem Code geschrieben und ab etwa 48 Zeichen als Teil eines
Einfügevorgangs gewertet. Image aktualisieren.

**„OAuth access token is invalid" bei jeder Anfrage** — Versionen vor dem
01.09.2026 haben den Token aus der Terminalausgabe gelesen und dabei am
Zeilenumbruch abgeschnitten (ein Token ist rund 108 Zeichen, das Terminal bricht
bei 80 um). Der unvollständige Wert stand dann in den Einstellungen und
überschrieb die intakten Zugangsdaten im Container. Nach dem Update wird das beim
Start automatisch korrigiert — der Startlog vermerkt es. Falls nicht: unter
Einstellungen beim Feld *Claude OAuth-Token* auf *Zurücksetzen* klicken, dann
greifen die Zugangsdaten aus der Anmeldung.

**„Der Code wurde abgelehnt"** — Der Code auf der Claude-Seite ist länger, als das
Feld dort anzeigt. Mit dem Kopier-Symbol daneben kopieren statt ihn zu markieren.
Ein neuer Versuch ist sofort möglich, der Link bleibt gültig.

**Die Anmeldung hängt bei „Code wird geprüft"** — Nach 90 Sekunden ohne Antwort
kehrt das Formular von selbst zur Code-Eingabe zurück.

**„Die Claude-CLI wurde unerwartet beendet"** — Der Hintergrundprozess ist gestorben,
bevor der Code verarbeitet werden konnte. Das Protokoll unter der Anmeldung zeigt
die letzte Ausgabe und den Exit-Code. Anmeldung neu starten.

**Die Anmeldung schlägt ohne erkennbaren Grund fehl** — Auf **Verbindung prüfen**
klicken (neben dem Anmelde-Button). Die Autorisierungs-URL wird lokal erzeugt und
braucht kein Netz; erst der Austausch des Codes geht nach außen. Ein blockierter
Egress oder kaputtes DNS im Container sieht deshalb genau so aus, als würde der
Server nicht antworten — die Prüfung trennt beides.

---

## Aufbau

```
src/
  index.ts          Express-App, Boot
  config.ts         Umgebungsvariablen
  db.ts             SQLite: Keys, Nutzung, Einstellungen
  auth.ts           API-Key-Prüfung, Admin-Session
  models.ts         Modell-Registry, Aliase, Kostenschätzung
  settings.ts       Laufzeit-Einstellungen: Schema, Validierung, DB über Env
  claudeLogin.ts    OAuth-Anmeldung im Browser, treibt die CLI unter einem PTY
  translate.ts      OpenAI ↔ Anthropic, beide Richtungen
  types.ts          Gemeinsame Typen, Engine-Interface
  engines/
    claudeCode.ts   Abo-Backend über den Claude-Agent-SDK
    anthropicApi.ts API-Backend
    mock.ts         Echo-Backend zum Testen
  routes/
    v1.ts           OpenAI-Endpunkte
    admin.ts        Admin-API: Keys, Nutzung, Einstellungen, Anmeldung
  web/              Web-Interface (Vanilla JS, keine externen Assets)
```

Die Engines teilen sich ein schmales Interface (`complete` und `stream`), sodass die
OpenAI-Übersetzung nur einmal existiert und für beide Backends gilt.
