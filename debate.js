#!/usr/bin/env node
/**
 * debate — hilos de decisión entre agentes, para lo que NO se puede medir.
 *
 * Existe porque el chat plano sirve para coordinar ("tomo estos archivos") pero no
 * para decidir: el hilo se mezcla con el ruido y la decisión se pierde apenas pasan
 * diez mensajes. Tres reglas, las tres aprendidas de un debate real que salió bien:
 *
 *  · PROPUESTA SELLADA. Cada convocado escribe la suya a ciegas y recién se destapan
 *    todas juntas. Dos LLMs debatiendo tienden a que el segundo se acomode al primero
 *    por cordialidad; si no ve la ajena, no puede acomodarse. Es la regla que más
 *    cambia la calidad de lo que sale.
 *  · EVIDENCIA. Una objeción sin un comando corrido es una opinión. El campo está
 *    para pegar el comando y su salida — pz NO ejecuta nada (recibe texto de Telegram
 *    y de otras sesiones: ejecutar lo que llega por ahí sería regalar la máquina).
 *  · CIERRE ESCRITO. El debate termina en una decisión que se guarda en el vault. El
 *    chat se pierde; la decisión y el desacuerdo que quedó abierto, no.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJSON, mutate } = require('./state');
const LLM = require('./localLlm');

const FILE = path.join(__dirname, 'debates.json');
const OUT_DIR = process.env.PZ_DECISIONES_DIR ||
  path.join(os.homedir(), 'Documents', 'PicnicZero-Docs', 'Decisiones');

const nowISO = () => new Date().toISOString();
const load = () => readJSON(FILE, {});
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function nextId(all) {
  let n = 1;
  while (all['d' + n]) n++;
  return 'd' + n;
}

// ─── comandos ────────────────────────────────────────────────────────────────
async function abrir({ me, live }, args) {
  const tema = args.tema;
  if (!tema) return { err: 'Falta el tema. Ej: pz debate abrir "¿monolito o servicio aparte?" --criterio "menos piezas móviles"' };
  // convocados: los que se pasen, o todas las sesiones vivas con nombre (incluido yo)
  const convocados = args.con
    ? args.con.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.from(new Set([me, ...live]));
  // La TERCERA VOZ (modelo local) se convoca sola y propone ACÁ MISMO: en este
  // momento no existe ninguna otra propuesta, así que su ceguera está garantizada
  // por construcción. Si no está el servidor, se dice en voz alta y el debate sigue.
  let tercero = null, sinTercero = null;
  if (!args.sinTercero) {
    const motivo = await LLM.porQueNoEsta();
    if (motivo) sinTercero = motivo;
    else {
      try {
        const r = await LLM.proponer({ tema, criterio: args.criterio, convocados });
        tercero = { nombre: LLM.nombre, texto: r.texto, ms: r.ms };
        convocados.push(LLM.nombre);
      } catch (e) { sinTercero = (e && e.message) || String(e); }
    }
  }
  let id;
  mutate(FILE, {}, (all) => {
    id = nextId(all);
    all[id] = {
      id, tema, criterio: args.criterio || null, convocados,
      abiertoPor: me, ts: nowISO(), estado: 'propuestas',
      propuestas: tercero ? { [tercero.nombre]: { texto: tercero.texto, ts: nowISO() } } : {},
      objeciones: [], decision: null, veredicto: null,
    };
    return all;
  });
  const nota = tercero
    ? `\n🧩 Tercera voz convocada (${tercero.nombre}): ya dejó su propuesta sellada, escrita sin ver ninguna otra.`
    : sinTercero ? `\n⚠️ Sin tercera voz: ${sinTercero}` : '';
  return {
    id,
    say: `🧵 Debate ${id} — ${tema}` + (args.criterio ? `\nCriterio de éxito: ${args.criterio}` : '')
      + `\nConvocados: ${convocados.join(', ')}. Cada uno propone A CIEGAS (pz debate proponer ${id} "…"); se destapan todas juntas.` + nota,
    out: `🧵 Debate ${id} abierto. Convocados: ${convocados.join(', ')}${nota}\n   Proponé lo tuyo: pz debate proponer ${id} "<tu propuesta>"`,
  };
}

// ─── el arbitraje: cuando ya están todas a la vista ──────────────────────────
// No elige ganador. Dice si en realidad coinciden, cuál es el eje, quién trajo un
// dato y —lo más valioso— qué no vio NINGUNO. Es lo que un tercero de otra familia
// de modelos puede ver y los dos que discuten no.
async function arbitrarYGuardar(id) {
  const d = load()[id];
  if (!d || !Object.keys(d.propuestas).length) return null;
  try {
    const { veredicto, ms } = await LLM.arbitrar({ tema: d.tema, criterio: d.criterio, propuestas: d.propuestas });
    mutate(FILE, {}, (all) => { all[id].veredicto = { ...veredicto, por: LLM.nombre, ms, ts: nowISO() }; return all; });
    return veredicto;
  } catch { return null; }   // sin árbitro el debate sigue; el texto del destape lo aclara
}

function veredictoTexto(v) {
  if (!v) return '';
  return `\n\n⚖️ Árbitro (${v.por}):`
    + `\n   ¿Dicen lo mismo?: ${v.convergen ? 'SÍ — ojo, puede ser eco y no acuerdo' : 'no'}`
    + `\n   Eje real del desacuerdo: ${v.eje_del_desacuerdo || '—'}`
    + `\n   Trajo dato verificable: ${v.quien_trajo_dato_verificable || 'ninguno'}`
    + `\n   Experimento que lo zanja: ${v.que_experimento_lo_zanja || '—'}`
    + `\n   Punto ciego de todas las propuestas: ${v.punto_ciego || '—'}`;
}

async function proponer({ me }, id, texto) {
  if (!texto) return { err: `Falta tu propuesta. Ej: pz debate proponer ${id || '<id>'} "yo haría X porque Y"` };
  const d0 = load()[id];
  if (!d0) return { err: `No existe el debate ${id}. Ver: pz debate ver` };
  if (d0.estado === 'cerrado') return { err: `El debate ${id} ya está cerrado.` };
  if (d0.propuestas[me]) return { err: `Ya propusiste en ${id}. Si querés agregar algo, objetá: pz debate objetar ${id} "…"` };
  let d;
  mutate(FILE, {}, (all) => {
    all[id].propuestas[me] = { texto, ts: nowISO() };
    d = all[id];
    return all;
  });
  const faltan = d.convocados.filter((n) => !d.propuestas[n]);
  const v = faltan.length ? null : await arbitrarYGuardar(id);
  return {
    faltan,
    say: faltan.length
      ? `🔒 ${me} ya propuso en ${id} (sellada). Faltan: ${faltan.join(', ')}.`
      : `🔓 Debate ${id}: propusieron todos → DESTAPADO. Miren las propuestas y objeten con evidencia: pz debate ver ${id}` + veredictoTexto(v),
    out: faltan.length
      ? `🔒 Propuesta sellada en ${id}. Nadie la ve todavía. Faltan: ${faltan.join(', ')}`
      : `🔓 Propuesta guardada y con eso están TODAS: destapadas. Mirá: pz debate ver ${id}`,
  };
}

// destapar: sólo cuando propusieron todos, o a mano si alguien no aparece
function destapado(d, forzado) {
  return forzado || d.forzado || d.estado === 'cerrado' ||
    d.convocados.every((n) => d.propuestas[n]);
}

async function destapar({ me }, id) {
  const d0 = load()[id];
  if (!d0) return { err: `No existe el debate ${id}.` };
  const faltan = d0.convocados.filter((n) => !d0.propuestas[n]);
  if (!faltan.length) return { err: `${id} ya estaba destapado (propusieron todos).` };
  mutate(FILE, {}, (all) => { all[id].forzado = { por: me, ts: nowISO(), faltaban: faltan }; return all; });
  const v = await arbitrarYGuardar(id);
  return {
    say: `🔓 ${me} destapó ${id} sin esperar a ${faltan.join(', ')}. Las propuestas quedan a la vista.` + veredictoTexto(v),
    out: `🔓 Destapado ${id} (faltaban: ${faltan.join(', ')}). Mirá: pz debate ver ${id}`,
  };
}

function objetar({ me }, id, texto, evidencia) {
  if (!texto) return { err: `Falta la objeción. Ej: pz debate objetar ${id || '<id>'} "eso se cae con N grande" --evidencia "corrí X → 13/72 perdidos"` };
  const d0 = load()[id];
  if (!d0) return { err: `No existe el debate ${id}.` };
  if (!destapado(d0)) return { err: `${id} todavía está sellado: primero proponé lo tuyo (pz debate proponer ${id} "…").` };
  mutate(FILE, {}, (all) => { all[id].objeciones.push({ de: me, texto, evidencia: evidencia || null, ts: nowISO() }); return all; });
  return {
    say: `⚔️ Objeción de ${me} en ${id}: ${short(texto, 300)}` + (evidencia ? `\n   Evidencia: ${short(evidencia, 300)}` : `\n   (sin evidencia — es una opinión, no un dato)`),
    out: `⚔️ Objeción registrada en ${id}.` + (evidencia ? '' : '\n   Ojo: sin --evidencia es una opinión. Si se puede medir, medilo.'),
  };
}

function ver({ me }, id) {
  const all = load();
  if (!id) {
    const list = Object.values(all).sort((a, b) => b.ts.localeCompare(a.ts));
    if (!list.length) return { out: 'No hay debates. Abrí uno: pz debate abrir "<tema>" --criterio "<cómo decidimos>"' };
    return {
      out: list.map((d) => {
        const faltan = d.convocados.filter((n) => !d.propuestas[n]);
        const est = d.estado === 'cerrado' ? '✅ cerrado'
          : faltan.length && !d.forzado ? `🔒 sellado (faltan: ${faltan.join(', ')})`
            : '🔓 destapado';
        return `${d.id}  ${est}  — ${short(d.tema, 70)}`;
      }).join('\n'),
    };
  }
  const d = all[id];
  if (!d) return { err: `No existe el debate ${id}.` };
  const L = [`🧵 ${d.id} — ${d.tema}`];
  if (d.criterio) L.push(`   Criterio de éxito: ${d.criterio}`);
  L.push(`   Convocados: ${d.convocados.join(', ')}  ·  abrió: ${d.abiertoPor}`);
  const faltan = d.convocados.filter((n) => !d.propuestas[n]);
  if (!destapado(d)) {
    L.push('', `🔒 SELLADO — no se ven las propuestas hasta que estén todas. Faltan: ${faltan.join(', ')}`);
    L.push(d.propuestas[me] ? '   (la tuya ya está adentro)' : `   Falta la tuya: pz debate proponer ${id} "…"`);
  } else {
    L.push('', '🔓 Propuestas:');
    for (const n of d.convocados) {
      const p = d.propuestas[n];
      L.push(p ? `\n  ── ${n} ──\n  ${p.texto.split('\n').join('\n  ')}` : `\n  ── ${n} ── (no propuso)`);
    }
    if (d.veredicto) L.push(veredictoTexto(d.veredicto).replace(/^\n\n/, ''));
    if (d.objeciones.length) {
      L.push('', '⚔️ Objeciones:');
      for (const o of d.objeciones) {
        L.push(`  · ${o.de}: ${o.texto}`);
        L.push(o.evidencia ? `      evidencia: ${o.evidencia}` : '      (sin evidencia)');
      }
    }
  }
  if (d.decision) {
    L.push('', `✅ Decisión (${d.decision.por}): ${d.decision.texto}`);
    if (d.decision.abierto) L.push(`⚠️ Quedó abierto: ${d.decision.abierto}`);
    if (d.decision.nota) L.push(`📄 ${d.decision.nota}`);
  }
  return { out: L.join('\n') };
}

function cerrar({ me }, id, decision, abierto) {
  if (!decision) return { err: `Falta la decisión. Ej: pz debate cerrar ${id || '<id>'} --decision "vamos por X" [--abierto "<lo que no acordamos>"]` };
  const d0 = load()[id];
  if (!d0) return { err: `No existe el debate ${id}.` };
  if (d0.estado === 'cerrado') return { err: `${id} ya estaba cerrado: ${d0.decision.texto}` };
  let d;
  mutate(FILE, {}, (all) => {
    all[id].estado = 'cerrado';
    all[id].decision = { texto: decision, abierto: abierto || null, por: me, ts: nowISO() };
    d = all[id];
    return all;
  });
  const nota = escribirNota(d);
  if (nota) mutate(FILE, {}, (all) => { all[id].decision.nota = nota; return all; });
  return {
    // con desacuerdo abierto la decisión NO es de los agentes: se escala al humano (ask = teléfono)
    tipo: abierto ? 'ask' : 'note',
    say: abierto
      ? `✅ Debate ${id} cerrado — ${d.tema}\nDecisión: ${decision}\n⚠️ Pero quedó un desacuerdo que no podemos resolver entre nosotros: ${abierto}`
      : `✅ Debate ${id} cerrado — ${d.tema}\nDecisión: ${decision}` + (nota ? `\n📄 ${nota}` : ''),
    out: `✅ ${id} cerrado.` + (nota ? `\n   Decisión escrita en: ${nota}` : '\n   (no pude escribir la nota en el vault)')
      + (abierto ? '\n   El desacuerdo abierto se escaló al humano.' : ''),
  };
}

// ─── la decisión sobrevive al chat: queda en el vault ────────────────────────
function escribirNota(d) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const fecha = d.decision.ts.slice(0, 10);
    const slug = d.tema.toLowerCase().replace(/[^a-z0-9áéíóúñ ]/gi, '').trim()
      .replace(/\s+/g, '-').slice(0, 60).replace(/-+$/, '');   // sin guión colgando si cortó al medio
    const file = path.join(OUT_DIR, `${fecha} — ${slug || d.id}.md`);
    const L = [
      '---', 'tipo: decision', `debate: ${d.id}`, `fecha: ${fecha}`,
      `participantes: [${d.convocados.join(', ')}]`, '---', '',
      `# ${d.tema}`, '',
    ];
    if (d.criterio) L.push(`**Criterio de éxito:** ${d.criterio}`, '');
    L.push('## Decisión', '', d.decision.texto, '');
    if (d.decision.abierto) L.push('## Desacuerdo que quedó abierto', '', d.decision.abierto, '');
    L.push('## Propuestas', '');
    for (const n of d.convocados) {
      const p = d.propuestas[n];
      L.push(`### ${n}`, '', p ? p.texto : '_no propuso_', '');
    }
    if (d.veredicto) {
      const v = d.veredicto;
      L.push(`## Arbitraje independiente (${v.por})`, '',
        `- **¿Las propuestas convergen?** ${v.convergen ? 'Sí' : 'No'}`,
        `- **Eje del desacuerdo:** ${v.eje_del_desacuerdo || '—'}`,
        `- **Trajo dato verificable:** ${v.quien_trajo_dato_verificable || 'ninguno'}`,
        `- **Experimento que lo zanja:** ${v.que_experimento_lo_zanja || '—'}`,
        `- **Punto ciego de todas:** ${v.punto_ciego || '—'}`, '');
    }
    if (d.objeciones.length) {
      L.push('## Objeciones', '');
      for (const o of d.objeciones) {
        L.push(`- **${o.de}:** ${o.texto}`);
        L.push(o.evidencia ? `  - Evidencia: \`${o.evidencia}\`` : '  - _Sin evidencia (opinión)_');
      }
      L.push('');
    }
    fs.writeFileSync(file, L.join('\n'));
    return file;
  } catch { return null; }   // el vault puede no existir en otra máquina: el debate igual queda en debates.json
}

module.exports = { abrir, proponer, destapar, objetar, ver, cerrar, FILE, OUT_DIR };
