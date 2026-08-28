/** Detector for CLI "error-as-content" responses.
 *
 *  The Claude CLI (OAuth/Max path) prints upstream API failures as plain
 *  stdout text — e.g. `API Error: 400 {"type":"error",...}` — instead of
 *  exiting non-zero or emitting an error result event. Without this check
 *  the bridge happily returns that text as the assistant completion, so
 *  callers (Hermes, openclaw) never see a real error and their retry /
 *  fallback logic never fires. Seen in production as jarvis replying
 *  "API Error: 400 ... out of extra usage" to a plain "hola".
 *
 *  Kept as a zero-import pure module so the test runner stays happy under
 *  --experimental-strip-types (same pattern as session-pool-decision.ts).
 */

/** Strict prefix: the CLI error line always starts with "API Error:"
 *  followed by an HTTP status code. Anchored + status-digit-checked so a
 *  legitimate assistant reply that merely *mentions* "API Error" later in
 *  the text never matches. */
const ERROR_AS_CONTENT_RE = /^\s*API Error:\s*\d{3}\b/;

/** Second shape of the same disease: when the Max/OAuth quota runs out the
 *  CLI does NOT print an `API Error:` line — it prints a plain sentence:
 *
 *      You've hit your limit · resets 8:10am (UTC)
 *
 *  and exits zero. The bridge then returned it as a normal completion with
 *  HTTP 200, so every caller counted a no-op turn as success. Measured on the
 *  openclaw fleet 2026-07-27: 447 cron runs recorded `status=ok` with this as
 *  their only output, which also kept `consecutiveErrors` at 0 and therefore
 *  suppressed every failure alert.
 *
 *  Deliberately strict — the `· resets` marker is required — because "you've
 *  hit your limit" on its own is something an assistant could legitimately
 *  say. The separator is accepted as `·`, `•` or `-`, and the possessive
 *  apostrophe as ASCII or typographic, since the CLI has used both.
 *
 *  The qualifier before "limit" is matched as one optional generic word rather
 *  than an enumeration. An earlier version allowed only `usage`, so when the
 *  CLI started printing `You've hit your session limit · resets 4:10am` that
 *  line sailed through as a real completion — which is how jarvis answered a
 *  Slack thread with the quota notice on 2026-08-16. Any new qualifier the CLI
 *  invents is now covered without another patch. */
const QUOTA_AS_CONTENT_RE = /^\s*You['’]ve hit your (?:\w+ )?limit\s*[·•-]\s*resets\b/i;

/** Prefix of the quota line used by the streaming gate to keep buffering. */
const QUOTA_LEAD = "You've hit your ";

/** Third shape of the same disease: an entitlement/authorization failure. The
 *  CLI prints it as plain prose — no `API Error:` line, no quota marker — and
 *  exits zero, so the bridge returned it as a normal completion:
 *
 *      Your organization has disabled Claude subscription access for Claude
 *      Code · Use an Anthropic API key instead, or ask your admin to enable
 *      access
 *
 *  Measured on the openclaw fleet 2026-08-22: four cron runs recorded
 *  `status=succeeded` with exactly this as their only output, and tony-briefing
 *  DELIVERED it to the finance channel as that day's briefing. The two existing
 *  patterns were verified against the real text and both return false.
 *
 *  Strict on purpose: the line has to OPEN with the entitlement clause and name
 *  Claude, so an assistant legitimately discussing org permissions ("your
 *  organization has disabled it, so…" mid-answer) is not caught. `not enabled`
 *  is included because it is the same notice in its negative phrasing. */
const ENTITLEMENT_AS_CONTENT_RE =
  /^\s*Your organization has (?:disabled|not enabled) [^\n]*\bClaude\b/i;

/** Prefix of the entitlement line, for the streaming gate. */
const ENTITLEMENT_LEAD = "Your organization has ";

/** How many leading chars we need before we can decide. "API Error: 400" is
 *  14; the quota lead `You've hit your limit · resets` is 30; the entitlement
 *  one, `Your organization has not enabled `, is 34 — exactly the old value,
 *  o sea que se decidía en el último byte disponible, sin margen. 40 deja
 *  espacio para un calificador más sin volver a tocar esto. Streaming handlers buffer up
 *  to this many chars before forwarding the first delta, so this is also the
 *  worst-case added latency on a normal reply — a few dozen bytes. */
export const ERROR_SNIFF_CHARS = 40;

/** True when the accumulated assistant text IS a CLI-printed failure rather
 *  than a real completion — either an `API Error:` line or a quota-exhaustion
 *  notice. Callers should only trust this when the turn produced no tool
 *  calls. */
export function isErrorAsContent(text: string): boolean {
  return (
    ERROR_AS_CONTENT_RE.test(text) ||
    QUOTA_AS_CONTENT_RE.test(text) ||
    ENTITLEMENT_AS_CONTENT_RE.test(text)
  );
}

/** Fixed lead every CLI error line starts with, before the HTTP status. */
const ERROR_LEAD = "API Error: ";

/** True when `text` (a partial prefix) could still turn out to be an
 *  error-as-content response once more chars arrive. Used by the streaming
 *  gate: keep buffering while this holds and the prefix is shorter than
 *  ERROR_SNIFF_CHARS.
 *
 *  Status-agnostic: probing against the literal lead `"API Error: "` (plus
 *  "the chars after it are still digits") keeps buffering for ANY status
 *  code. A previous version hardcoded the probe to `"API Error: 400"`, which
 *  bailed early on the first status digit for non-4xx codes — so a streamed
 *  `API Error: 529 ...` (overload) or `500/503` (upstream) leaked its partial
 *  line to the caller as a real delta and disabled retry. */
export function couldBeErrorAsContent(text: string): boolean {
  if (text.length >= ERROR_SNIFF_CHARS) return isErrorAsContent(text);
  const trimmed = text.replace(/^\s*/, "");
  // Still building up the literal "API Error: " lead itself.
  if (ERROR_LEAD.startsWith(trimmed)) return true;
  // Past the lead — keep buffering only while what follows is still a
  // plausible (digits-only so far) HTTP status code.
  if (trimmed.startsWith(ERROR_LEAD)) {
    const rest = trimmed.slice(ERROR_LEAD.length);
    if (/^\d{1,3}$/.test(rest)) return true;
  }
  // Same probe for the quota line. Compared case-insensitively and with the
  // apostrophe normalized, so a streamed `You’ve hit your …` keeps buffering
  // instead of leaking its first delta and disabling retry.
  const probe = trimmed.toLowerCase().replace(/’/g, "'");
  const lead = QUOTA_LEAD.toLowerCase();
  if (probe.length > 0 && (lead.startsWith(probe) || probe.startsWith(lead))) return true;
  // Y el mismo probe para la línea de entitlement: sin esto un error de este
  // tipo que llega STREAMEADO filtra su primer delta como si fuera respuesta
  // real y deshabilita el retry — el patrón nuevo solo serviría para el caso
  // no-streaming.
  const entitlementLead = ENTITLEMENT_LEAD.toLowerCase();
  if (probe.length > 0 && (entitlementLead.startsWith(probe) || probe.startsWith(entitlementLead))) {
    return true;
  }
  return isErrorAsContent(text);
}

/**
 * El instante del reset que anuncia la línea de cuota, si lo trae.
 *
 * El CLI escribe `You've hit your limit · resets 4pm (America/Buenos_Aires)` o
 * `resets 8:10am`. Cuando el gateway recibe esto como un 500 genérico lo trata
 * como error transitorio y quema sus 3 reintentos en 7 minutos — contra una
 * cuota que vuelve dentro de horas. Medido en la flota: el 21 y el 23-ago cada
 * episodio convirtió 1 corrida planificada en 4 intentos y después PERDIÓ la
 * corrida (una de ellas semanal).
 *
 * Devuelve segundos hasta el reset (para `Retry-After`), o undefined si la
 * línea no dice nada parseable. Deliberadamente tolerante: si no se entiende la
 * hora, mejor no inventar una espera.
 */
export function quotaRetryAfterSeconds(text: string, now = new Date()): number | undefined {
  const m = /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = m[3]?.toLowerCase();
  if (Number.isNaN(hour) || hour > 23 || minute > 59) return undefined;
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  // Un reset "ya pasado" es el de mañana: la línea siempre mira hacia adelante.
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  const secs = Math.round((target.getTime() - now.getTime()) / 1000);
  // 24h es el techo NATURAL: el "si ya pasó, es el de mañana" de arriba hace
  // que el resultado nunca pueda ser mayor por construcción. Poner menos
  // descartaba casos legítimos — con 6h se caía el reset de las 4pm visto
  // desde la mañana (8h35m), y con 12h el reset nocturno (12h10m). La basura
  // ya la ataja la validación de hora/minuto.
  return secs > 0 && secs <= 24 * 3600 ? secs : undefined;
}

/** True cuando el texto ES la línea de cuota agotada (no un error cualquiera). */
export function isQuotaExhaustedText(text: string): boolean {
  return QUOTA_AS_CONTENT_RE.test(text);
}
