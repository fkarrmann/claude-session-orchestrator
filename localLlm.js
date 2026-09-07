#!/usr/bin/env node
/**
 * localLlm — el modelo LOCAL como TERCERA VOZ del debate.
 *
 * Por qué meter un modelo PEOR en una discusión entre modelos mejores: porque los
 * dos que ya están vienen de la misma estirpe y se equivocan parecido. El riesgo
 * real de un debate entre IAs no es que digan pavadas: es que coincidan — el segundo
 * se acomoda al primero y sale un eco bien redactado en lugar de una segunda opinión.
 * Un modelo de otra familia se equivoca DISTINTO, y eso es justo lo que hace falta.
 * No se lo convoca para que gane: se lo convoca para que no dé la razón por los
 * motivos equivocados, y para marcar el punto ciego que comparten los otros dos.
 *
 * Además es local: gratis y sin límite. Puede participar en TODOS los debates, que
 * es la única forma de que una tercera voz signifique algo.
 *
 * GOTCHA medido (Qwen3.5-35B-A3B, 3 bits, llama.cpp): si no se le manda
 * enable_thinking=false, se gasta todo el presupuesto de tokens razonando y devuelve
 * la respuesta VACÍA. Con razonamiento: 18s y nada. Sin razonamiento: 3s y JSON limpio.
 */
const CFG = require('./config');

const BASE = String(CFG.localLlm.url || '').replace(/\/+$/, '');   // .../v1
const PING_MS = 2500;      // ¿está vivo? tiene que ser barato
const GEN_MS = 120000;     // generar puede tardar: 35B en 3 bits hace ~35 tokens/s

let _model = null;

async function post(pathname, body, ms) {
  const r = await fetch(BASE + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} de ${BASE + pathname}`);
  return r.json();
}

// El id del modelo se descubre solo: quien clone esto no tiene por qué tener el mismo.
async function modelo() {
  if (_model) return _model;
  if (CFG.localLlm.model) return (_model = CFG.localLlm.model);
  const r = await fetch(BASE + '/models', { signal: AbortSignal.timeout(PING_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status} pidiendo /models`);
  const j = await r.json();
  const id = (j.data && j.data[0] && j.data[0].id) || (j.models && j.models[0] && j.models[0].id);
  if (!id) throw new Error('el servidor no declara ningún modelo');
  return (_model = id);
}

// Devuelve el motivo por el que NO está, o null si está. Nunca tira: el debate
// tiene que poder seguir sin la tercera voz, pero diciéndolo en voz alta.
async function porQueNoEsta() {
  try { await modelo(); return null; }
  catch (e) {
    const m = (e && e.message) || String(e);
    if (/fetch failed|ECONNREFUSED|timeout|aborted/i.test(m)) return `no contesta en ${BASE} (¿está apagado? se prende con: qwen)`;
    return m;
  }
}

async function chat(messages, { maxTokens = 600 } = {}) {
  const model = await modelo();
  const t0 = Date.now();
  const j = await post('/chat/completions', {
    model, messages, temperature: 0.3, max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false },   // ver GOTCHA arriba
  }, GEN_MS);
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  const text = ((msg && msg.content) || '').trim();
  if (!text) throw new Error('respondió vacío (¿se quedó razonando? revisá enable_thinking)');
  return { text, ms: Date.now() - t0 };
}

// Los modelos chicos envuelven el JSON en ```json aunque les pidas que no.
function parseJSON(text) {
  const limpio = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(limpio); } catch {}
  const m = limpio.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error('no devolvió JSON parseable');
}

// ─── 1) su propuesta, a ciegas como la de todos ──────────────────────────────
async function proponer({ tema, criterio, convocados }) {
  const { text, ms } = await chat([
    { role: 'system', content:
      'Sos la TERCERA VOZ de un debate técnico entre dos agentes de IA que trabajan sobre el mismo repositorio. ' +
      'Tu valor no es ser el más brillante: es ser INDEPENDIENTE. Venís de otra familia de modelos y ves cosas que ellos no. ' +
      'Dás tu postura propia, concreta y corta. Si el tema requiere un dato que no tenés, decí qué medirías para saberlo. ' +
      'Nunca digas "depende" sin comprometerte con una opción. Máximo 120 palabras, sin markdown, sin preámbulos.' },
    { role: 'user', content:
      `Tema del debate: ${tema}\n` +
      (criterio ? `Criterio de éxito acordado: ${criterio}\n` : '') +
      `Otros participantes: ${convocados.join(', ')}\n\n` +
      'Escribí TU propuesta. No ves las de los demás (están selladas) y ellos no ven la tuya.' },
  ], { maxTokens: 400 });
  return { texto: text, ms };
}

// ─── 2) su arbitraje, cuando se destapan todas ───────────────────────────────
// Las propuestas van ANÓNIMAS ("Propuesta 1, 2, 3"): el árbitro es el mismo modelo
// que propuso, y con los nombres a la vista se elegía a sí mismo como el que trajo
// el dato. Sin nombres no puede hacerse la gamba, y de paso tampoco puede favorecer
// a un agente por prestigio. Los nombres se reponen al traducir el veredicto.
async function arbitrar({ tema, criterio, propuestas }) {
  const nombres = Object.keys(propuestas);
  // Etiquetas con PALABRA propia, no números: si son "Propuesta 1/2/3", el modelo
  // escribe "la 1 y la 3" y al reponer los nombres queda "la Fulano y 3".
  const ALFAB = ['ALFA', 'BETA', 'GAMMA', 'DELTA', 'OMEGA', 'SIGMA'];
  const etiqueta = (i) => `Propuesta ${ALFAB[i] || 'P' + (i + 1)}`;
  const deEtiqueta = {};
  nombres.forEach((n, i) => { deEtiqueta[etiqueta(i).toLowerCase()] = n; });
  const cuerpo = nombres.map((n, i) => `── ${etiqueta(i)} ──\n${propuestas[n].texto}`).join('\n\n');

  const { text, ms } = await chat([
    { role: 'system', content:
      'Sos el ÁRBITRO IMPARCIAL de un debate. No elegís ganador: mostrás la ESTRUCTURA del desacuerdo ' +
      'para que un humano decida rápido. Las propuestas vienen sin autor a propósito: juzgá el contenido. ' +
      'Sé duro con las afirmaciones sin dato. Devolvés SOLO JSON válido, sin markdown.' },
    { role: 'user', content:
      `Tema: ${tema}\n${criterio ? `Criterio de éxito: ${criterio}\n` : ''}\nPropuestas:\n\n${cuerpo}\n\n` +
      'Devolvé JSON con exactamente estas claves:\n' +
      '{"convergen": bool (¿dicen lo mismo con otras palabras?),\n' +
      ' "eje_del_desacuerdo": string (una frase: en qué difieren DE VERDAD),\n' +
      ` "quien_trajo_dato_verificable": string (exactamente "${etiqueta(0)}"… según corresponda, o "ninguno"),\n` +
      ' "que_experimento_lo_zanja": string (algo medible y barato),\n' +
      ' "punto_ciego": string (algo importante que NINGUNA propuesta menciona)}' },
  ], { maxTokens: 700 });

  const veredicto = parseJSON(text);
  // "Propuesta BETA" → el nombre real; si contestó cualquier otra cosa, se deja como vino
  const quien = String(veredicto.quien_trajo_dato_verificable || '').trim();
  const hit = Object.keys(deEtiqueta).find((k) => quien.toLowerCase().includes(k));
  veredicto.quien_trajo_dato_verificable = hit ? deEtiqueta[hit] : (quien || 'ninguno');
  // y en las frases largas: primero la etiqueta entera, después la palabra suelta
  // ("ALFA y GAMMA aceptan…"), que es como las cita cuando enumera.
  const reponer = (t) => {
    nombres.forEach((n, i) => {
      const sola = (ALFAB[i] || 'P' + (i + 1));
      t = t.replace(new RegExp('Propuesta\\s+' + sola, 'gi'), n)
           .replace(new RegExp('(?:la|el)\\s+' + sola + '\\b', 'gi'), n)
           .replace(new RegExp('\\b' + sola + '\\b', 'g'), n);
    });
    return t;
  };
  for (const campo of ['eje_del_desacuerdo', 'que_experimento_lo_zanja', 'punto_ciego']) {
    if (typeof veredicto[campo] === 'string') veredicto[campo] = reponer(veredicto[campo]);
  }
  return { veredicto, ms };
}

module.exports = { porQueNoEsta, proponer, arbitrar, chat, parseJSON, modelo, nombre: CFG.localLlm.nombre };
