/**
 * Connectivity checks for the hosts the sign-in and the backends depend on.
 *
 * The OAuth authorize URL is generated locally (PKCE), so the first half of the
 * sign-in works even with no network at all — only the code exchange reaches
 * out. That makes a blocked egress or broken DNS look exactly like "the server
 * never answered", which is impossible to tell apart from the outside. These
 * checks separate the two.
 */

import dns from "node:dns/promises";

export interface HostCheck {
  host: string;
  purpose: string;
  dns: { ok: boolean; addresses?: string[]; error?: string };
  https: { ok: boolean; status?: number; ms?: number; error?: string };
}

const HOSTS: { host: string; purpose: string; path: string }[] = [
  {
    host: "claude.com",
    purpose: "Anmeldeseite und OAuth-Autorisierung",
    path: "https://claude.com/",
  },
  {
    host: "console.anthropic.com",
    purpose: "Token-Austausch beim Anmelden",
    path: "https://console.anthropic.com/",
  },
  {
    host: "platform.claude.com",
    purpose: "Rückleitung nach der Anmeldung",
    path: "https://platform.claude.com/",
  },
  {
    host: "api.anthropic.com",
    purpose: "Modell-Anfragen beider Backends",
    path: "https://api.anthropic.com/",
  },
];

async function checkDns(host: string): Promise<HostCheck["dns"]> {
  try {
    const records = await dns.lookup(host, { all: true, family: 0 });
    return { ok: true, addresses: records.slice(0, 3).map((r) => r.address) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkHttps(url: string): Promise<HostCheck["https"]> {
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);

  try {
    // A 401/403/404 still proves the connection reached the host, which is all
    // this checks; only a transport failure matters here.
    const res = await fetch(url, {
      method: "HEAD",
      signal: abort.signal,
      redirect: "manual",
    });
    return { ok: true, status: res.status, ms: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      ms: Date.now() - started,
      error: abort.signal.aborted ? "Zeitüberschreitung nach 8s" : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runDiagnostics(): Promise<{
  reachable: boolean;
  summary: string;
  hosts: HostCheck[];
}> {
  const hosts = await Promise.all(
    HOSTS.map(async (h) => ({
      host: h.host,
      purpose: h.purpose,
      dns: await checkDns(h.host),
      https: await checkHttps(h.path),
    })),
  );

  const failedDns = hosts.filter((h) => !h.dns.ok);
  const failedHttps = hosts.filter((h) => h.dns.ok && !h.https.ok);
  const reachable = failedDns.length === 0 && failedHttps.length === 0;

  let summary: string;
  if (reachable) {
    summary = "Alle benötigten Hosts sind erreichbar.";
  } else if (failedDns.length === hosts.length) {
    summary =
      "Kein Host ließ sich auflösen — im Container funktioniert die Namensauflösung nicht. " +
      "Prüfe die DNS-Einstellungen des Containers.";
  } else if (failedDns.length) {
    summary = `Namensauflösung fehlgeschlagen für: ${failedDns.map((h) => h.host).join(", ")}.`;
  } else {
    summary =
      `Erreichbar, aber keine Verbindung zu: ${failedHttps.map((h) => h.host).join(", ")}. ` +
      "Das deutet auf eine Firewall oder einen blockierten ausgehenden Port 443 hin.";
  }

  return { reachable, summary, hosts };
}
