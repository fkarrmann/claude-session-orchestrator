/**
 * umbral.js — PZ Sessions ↔ Umbral (la app de Clara, la secretaria del owner).
 *
 *   • La sala viaja a Umbral (POST /api/claudio/sala) y Clara la ve en su espejo (fuente pz.sala). Cada 30 s va lo
 *     nuevo desde el último OK de Umbral (cursor en umbral-state.json). Aunque no haya nada nuevo, igual avisa: así
 *     Umbral sabe que la sala sigue llegando y, si deja de llegar, lo marca en Sistemas.
 *   • Lo que se le pregunta al owner (ask sin --to, o un mensaje con @owner) es una tarjeta en Umbral
 *     (POST /sala/preguntas) en vez de un DM del bot de Telegram. Si Umbral no la toma, va por Telegram como antes, y
 *     queda en el log ([umbral✗→tg]).
 *   • Lo que contesta en Umbral vuelve a la sala firmado «<owner> (Umbral)» y dirigido a quien preguntó: `pz ask --wait`
 *     lo toma como respuesta (autor que no es una sesión). Recién después se marca entregada en Umbral.
 *   • Si contesta por otro lado (tablero, Telegram), la tarjeta se retira de Umbral: no contesta dos veces.
 *
 * Llave: ~/.claude/secrets/umbral_admin (la misma del gancho de pedidos de pz.js). Sin llave, o con PZ_NO_UMBRAL=1
 * (instancia de prueba), no hace nada y las preguntas siguen yendo por Telegram.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJSON, writeJSON } = require('./state');

const URL = (process.env.UMBRAL_URL || 'https://umbral-ldy3.onrender.com').replace(/\/+$/, '');
const LLAVE_ARCHIVO = path.join(os.homedir(), '.claude', 'secrets', 'umbral_admin');
const STATE = path.join(__dirname, 'umbral-state.json');
const CADA_MS = 30_000;
const POR_VEZ = 200;
const DESDE_EL_PRINCIPIO_MS = 24 * 3600_000;  // la primera vez, sólo lo del último día

function llave() {
  if (process.env.PZ_NO_UMBRAL) return null;
  try { return fs.readFileSync(LLAVE_ARCHIVO, 'utf8').trim() || null; } catch { return null; }
}

async function api(metodo, ruta, cuerpo) {
  const k = llave();
  if (!k) return { ok: false, error: 'sin llave' };
  try {
    const r = await fetch(`${URL}/api/claudio${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${k}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, json } : { ok: false, error: `HTTP ${r.status}: ${json.error || ''}`.trim() };
  } catch (e) { return { ok: false, error: e.message }; }
}

// { cursor: ts ISO del último mensaje que Umbral recibió, preguntas: { <id del mensaje>: { de, tarjeta } } }
const estado = () => ({ cursor: null, preguntas: {}, ...readJSON(STATE, {}) });
const guardar = (s) => writeJSON(STATE, s);

/**
 * @param {{ readChat: () => object[], postMessage: (m: object) => object, owner: () => string }} dep
 */
module.exports = function crear({ readChat, postMessage, owner }) {
  let ultimoError = null;
  const anotarError = (que, e) => {
    const msg = `${que}: ${e}`;
    if (msg !== ultimoError) console.log(`[umbral] ${msg}`);   // una vez por error distinto, no cada 30 s
    ultimoError = msg;
  };

  /** La sala, de a tandas, desde el cursor (inclusive: Umbral no duplica lo que ya tiene). */
  async function empujarSala() {
    const s = estado();
    const desde = s.cursor || new Date(Date.now() - DESDE_EL_PRINCIPIO_MS).toISOString();
    const nuevos = readChat().filter((m) => m.ts >= desde).slice(0, POR_VEZ);
    const r = await api('POST', '/sala', { mensajes: nuevos });
    if (!r.ok) return anotarError('no pude mandar la sala', r.error);
    if (ultimoError) { console.log('[umbral] la sala vuelve a llegar'); ultimoError = null; }
    if (nuevos.length) guardar({ ...estado(), cursor: nuevos[nuevos.length - 1].ts });
  }

  /** Una pregunta para el owner, como tarjeta. Devuelve true si Umbral la tomó (si no, que vaya por Telegram). */
  async function preguntar(m) {
    if (!llave()) return false;
    const r = await api('POST', '/sala/preguntas', { mensaje: m.id, de: m.from, texto: m.text, tipo: m.type, rama: m.branch || null });
    if (!r.ok) { anotarError(`la pregunta de ${m.from} no entró`, r.error); return false; }
    const s = estado();
    s.preguntas[m.id] = { de: m.from, tarjeta: r.json.tarjeta };
    try { guardar(s); } catch (e) { anotarError('no pude anotar la tarjeta', e.message); }   // la tarjeta ya está: no va también por Telegram
    console.log(`[umbral] tarjeta #${r.json.tarjeta}: ${m.type} de ${m.from}`);
    return true;
  }

  /** Lo que contestó en Umbral, a la sala (dirigido a quien preguntó). Después, entregada. */
  async function traerRespuestas() {
    const r = await api('GET', '/sala/respuestas');
    if (!r.ok) return anotarError('no pude traer respuestas', r.error);
    for (const x of r.json.respuestas || []) {
      const dijo = [x.opcion, x.texto].filter(Boolean).join('. ');
      const p = postMessage({ from: `${owner() || 'Owner'} (Umbral)`, type: 'note', to: x.para, text: `→ ${x.para}: ${dijo}` });
      if (!p.ok) { anotarError('no pude escribir una respuesta en la sala', p.error); return; }
      const s = estado();
      delete s.preguntas[x.mensaje];
      guardar(s);
      const e = await api('POST', `/sala/respuestas/${x.tarjeta}/entregada`);
      if (!e.ok) anotarError(`la respuesta de la tarjeta #${x.tarjeta} quedó escrita pero no marcada`, e.error);
      console.log(`[umbral→sala] ${x.para}: ${dijo.slice(0, 80)}`);
    }
  }

  /**
   * El owner escribió en la sala por otro lado (tablero o Telegram). Para `pz ask --wait` eso ya es respuesta: a quien
   * nombra (to, o «→ X:»), o a todas si no nombra a nadie. Esas tarjetas se retiran de Umbral.
   */
  async function alContestarAfuera(m) {
    const s = estado();
    const a = m.to || (String(m.text).match(/^→\s*([^:]+):/) || [])[1];
    const cuales = Object.entries(s.preguntas).filter(([, p]) => !a || p.de.toLowerCase() === a.trim().toLowerCase());
    for (const [id] of cuales) {
      const r = await api('POST', `/sala/preguntas/${encodeURIComponent(id)}/retirar`, { motivo: `${owner() || 'El owner'} contestó en la sala (${/\(telegram\)\s*$/i.test(m.from) ? 'por Telegram' : 'desde el tablero'}).` });
      if (!r.ok) { anotarError('no pude retirar una tarjeta', r.error); continue; }
      const t = estado();
      delete t.preguntas[id];
      guardar(t);
    }
  }

  let corriendo = false;
  async function vuelta() {
    if (corriendo || !llave()) return;
    corriendo = true;
    try { await empujarSala(); await traerRespuestas(); } catch (e) { anotarError('la vuelta falló', e.message); } finally { corriendo = false; }
  }

  return {
    activo: () => Boolean(llave()),
    preguntar,
    alContestarAfuera,
    vuelta,
    arrancar() { vuelta(); return setInterval(vuelta, CADA_MS); },
  };
};
