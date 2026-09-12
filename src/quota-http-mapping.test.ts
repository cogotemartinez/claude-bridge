import assert from "node:assert/strict";
import test from "node:test";
import {
  CLI_ERROR_AS_CONTENT_PREFIX,
  isQuotaExhaustedText,
  quotaAwareErrorStatus,
  quotaRetryAfterSeconds,
} from "./error-as-content.ts";

// El camino REAL, que ninguna prueba cubría: el servidor no ve el texto del
// CLI, ve `err.message`, y el worker se lo entrega envuelto. Las pruebas
// viejas le daban el texto crudo a las funciones, así que pasaban en verde
// mientras en producción toda cuota agotada salía 500.

const CRUDO = "You've hit your limit · resets 8:10am";
const ENVUELTO = `${CLI_ERROR_AS_CONTENT_PREFIX}${CRUDO}`;
const AHORA = new Date("2026-08-28T07:25:00-03:00");

test("el prefijo del worker es lo que rompía la deteccion anclada", () => {
  // Esta es la falla, escrita como prueba: el detector anclado NO puede ver la
  // línea de cuota si el mensaje viene envuelto. Por eso clasificar sobre el
  // mensaje crudo del Error estaba mal desde el primer día.
  assert.equal(isQuotaExhaustedText(CRUDO), true);
  assert.equal(isQuotaExhaustedText(ENVUELTO), false);
});

test("una cuota agotada envuelta por el worker mapea a 429 con Retry-After", () => {
  const r = quotaAwareErrorStatus(ENVUELTO, false, AHORA);
  assert.equal(r.status, 429);
  assert.equal(r.headers?.["Retry-After"], String(45 * 60));
});

test("sin envolver tambien mapea a 429: el desenvolvedor no rompe el caso directo", () => {
  assert.equal(quotaAwareErrorStatus(CRUDO, false, AHORA).status, 429);
});

test("un error cualquiera sigue siendo 500 y un timeout 504", () => {
  assert.equal(quotaAwareErrorStatus(`${CLI_ERROR_AS_CONTENT_PREFIX}API Error: 500 boom`, false).status, 500);
  assert.equal(quotaAwareErrorStatus("CLI error: exit 1", false).status, 500);
  assert.equal(quotaAwareErrorStatus("CLI timeout after 600000ms", true).status, 504);
});

test("cuota sin hora parseable: 429 igual, pero sin inventar la espera", () => {
  const r = quotaAwareErrorStatus(`${CLI_ERROR_AS_CONTENT_PREFIX}You've hit your limit · resets soon`, false);
  assert.equal(r.status, 429);
  assert.equal(r.headers, undefined);
});

// ── El limite SEMANAL: el reset viene con fecha, no con hora ────────────────
// Medido en los logs del puente del 08 al 11-09-2026: 204 episodios de cuota,
// 156 con la forma `resets Sep 11 at 11am`. Esa es la pared que dejó a Jarvis
// 3,5 dias sin poder correr un modelo, y era justo la que no se parseaba.

test("cuota semanal: el reset con fecha da la espera REAL, de dias", () => {
  const ahora = new Date(2026, 8, 8, 13, 10, 0); // 8-sep 13:10, hora local
  const esperado = Math.round((new Date(2026, 8, 11, 11, 0, 0).getTime() - ahora.getTime()) / 1000);
  const s = quotaRetryAfterSeconds(
    "You've hit your weekly limit · resets Sep 11 at 11am (America/Buenos_Aires)",
    ahora,
  );
  assert.equal(s, esperado);
  assert.ok(s > 24 * 3600, `una pared semanal dura mas de un dia, dio ${s}s`);
});

test("cuota semanal: el mapeo HTTP lleva ese Retry-After de dias", () => {
  const ahora = new Date(2026, 8, 8, 13, 10, 0);
  const r = quotaAwareErrorStatus(
    `${CLI_ERROR_AS_CONTENT_PREFIX}You've hit your weekly limit · resets Sep 11 at 11am (America/Buenos_Aires)`,
    false,
    ahora,
  );
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers?.["Retry-After"]) > 24 * 3600);
});

test("un nombre que no es mes no se convierte en fecha inventada", () => {
  assert.equal(quotaRetryAfterSeconds("You've hit your weekly limit · resets Monday at 11am"), undefined);
});

test("la forma sin fecha sigue leyendose igual que antes", () => {
  const ahora = new Date(2026, 7, 28, 7, 25, 0);
  const esperado = Math.round((new Date(2026, 7, 28, 8, 10, 0).getTime() - ahora.getTime()) / 1000);
  assert.equal(quotaRetryAfterSeconds("You've hit your limit · resets 8:10am", ahora), esperado);
});
