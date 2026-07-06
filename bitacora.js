#!/usr/bin/env node
/**
 * bitacora.js — genera la BITÁCORA diaria de PZ Sessions, en DOS capas.
 *
 *   Capa 1 «Para Fede» (no técnica): qué cambió en criollo, DÓNDE se ve en la
 *   app, a qué estar atento. Agrupado por tema, no por sesión.
 *   Capa 2 «Técnico»: por PR — hash del merge, archivos, cómo revertir, qué
 *   quedó pendiente. Índice accionable para que otra sesión continúe o revierta.
 *
 * DOS PASOS:
 *   1) collect()   — DETERMINISTA (sin IA): lee la sala del día, agrupa por
 *      sesión, saca los PRs y los enriquece con `gh pr view`. Exacto y gratis.
 *   2) generate()  — IA headless (`claude -p`): redacta las dos capas sobre esa
 *      materia prima y las escribe a Obsidian. pz.js es quien escribe el archivo
 *      (claude sólo emite el markdown por stdout → sin permisos de escritura).
 *
 * Se dispara de tres formas, todas por la misma cocina:
 *   • `pz bitacora`            — ventana «día de trabajo» (ancla 05:00) de hoy
 *   • `pz bitacora --date D`   — un día calendario puntual (regenerar)
 *   • `pz bitacora --json`     — sólo la materia prima (para el tablero / debug)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CFG = require('./config');

const CHAT = path.join(__dirname, 'chat.json');
// carpeta de salida en el vault de Obsidian (override por env para tests)
const OUT_DIR = process.env.PZ_BITACORA_DIR ||
  path.join(os.homedir(), 'Documents', 'PicnicZero-Docs', 'Bitácora');

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const sh = (c, cwd) => { try { return execSync(c, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 }).trim(); } catch { return ''; } };
const pad = (n) => String(n).padStart(2, '0');

// ─── ventana temporal ────────────────────────────────────────────────────────
// El «día de trabajo» ancla a las 05:00 locales: una sesión que arranca a la
// noche y cruza medianoche queda en UN solo archivo (visto en la vida real:
// el Optimizador corrió 21:02→03:11). La bitácora de la fecha D cubre
// [D 05:00, D+1 05:00).
function workdayWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const since = new Date(y, m - 1, d, 5, 0, 0, 0).getTime();
  const until = since + 24 * 60 * 60 * 1000;
  return { sinceMs: since, untilMs: until, label: dateStr };
}
// fecha (YYYY-MM-DD) del día de trabajo al que pertenece "ahora": antes de las
// 05:00 todavía es el día anterior.
function currentWorkday(nowMs = Date.now()) {
  const t = new Date(nowMs - 5 * 60 * 60 * 1000);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

// ─── ventana SEMANAL (lunes→domingo, ancla 05:00) ──────────────────────────────
const fmtDate = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const humanDay = (dt) => `${dt.getDate()}-${MES[dt.getMonth()]}`;
// La semana que CONTIENE el instante ms: [lunes 05:00, lunes+7 05:00). Se identifica
// por su domingo (fecha de cierre) para el nombre de archivo y el label.
function weekWindowContaining(ms) {
  const d = new Date(ms - 5 * 60 * 60 * 1000);     // hora "de trabajo"
  const daysFromMon = (d.getDay() + 6) % 7;         // 0=lunes … 6=domingo
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysFromMon, 5, 0, 0, 0);
  const sinceMs = mon.getTime();
  const untilMs = sinceMs + 7 * 24 * 60 * 60 * 1000;
  const sun = new Date(sinceMs + 6 * 24 * 60 * 60 * 1000);   // domingo (cierre)
  return { sinceMs, untilMs, weekStart: fmtDate(mon), weekEnd: fmtDate(sun),
    label: `${humanDay(mon)} al ${humanDay(sun)}` };
}

// ─── extracción de PRs desde el texto de los mensajes ──────────────────────────
// "#433", "PR #433", "(PR #433)" → 433. Descarta ruidos tipo cache "v29" (sin #)
// y hashes. Sólo números de 2+ dígitos precedidos por '#'.
function extractPRs(text) {
  const out = new Set();
  const re = /#(\d{2,6})\b/g;
  let m;
  while ((m = re.exec(text || ''))) out.add(Number(m[1]));
  return out;
}

// ─── paso 1: recolección determinista ─────────────────────────────────────────
function collect(win) {
  const chat = readJSON(CHAT, []);
  const msgs = chat.filter((m) => {
    const t = Date.parse(m.ts);
    return Number.isFinite(t) && t >= win.sinceMs && t < win.untilMs;
  });

  const bySession = new Map();
  const prNums = new Set();
  const ensure = (name, branch) => {
    if (!bySession.has(name)) {
      bySession.set(name, { name, task: null, branch: branch || null, joined: null, ended: null,
        claims: [], dones: [], notes: [], asks: [], warns: [] });
    }
    return bySession.get(name);
  };

  for (const m of msgs) {
    const s = ensure(m.from, m.branch);
    if (m.branch) s.branch = m.branch;
    if (m.type === 'join') { s.joined = m.ts; s.task = (m.text || '').replace(/^me sumo\s*—\s*/, ''); }
    else if (m.type === 'done') { s.dones.push({ text: m.text, ts: m.ts }); s.ended = m.ts; }
    else if (m.type === 'note') s.notes.push({ text: m.text, ts: m.ts });
    else if (m.type === 'ask') s.asks.push({ text: m.text, ts: m.ts });
    else if (m.type === 'warn') s.warns.push({ text: m.text, ts: m.ts });
    else if (m.type === 'claim') s.claims.push(...(m.files || []));
    for (const n of extractPRs(m.text)) prNums.add(n);
  }

  // enriquecer cada PR con gh (corre en el repo orquestado, que tiene el remoto)
  const prs = [];
  for (const n of [...prNums].sort((a, b) => a - b)) {
    const raw = sh(`gh pr view ${n} --json number,title,url,state,mergedAt,mergeCommit,additions,deletions,files,author,body`, CFG.repo);
    if (!raw) continue;
    let pr;
    try { pr = JSON.parse(raw); } catch { continue; }
    prs.push({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      mergedAt: pr.mergedAt || null,
      mergeCommit: pr.mergeCommit && pr.mergeCommit.oid ? pr.mergeCommit.oid.slice(0, 10) : null,
      additions: pr.additions, deletions: pr.deletions,
      author: pr.author && (pr.author.name || pr.author.login) || null,
      files: (pr.files || []).map((f) => f.path).slice(0, 15),
      fileCount: (pr.files || []).length,
      body: (pr.body || '').slice(0, 300),
    });
  }

  const sessions = [...bySession.values()]
    .filter((s) => s.task || s.dones.length || s.notes.length || s.claims.length)
    .map((s) => ({ ...s, claims: [...new Set(s.claims)] }));

  return { window: { ...win, sinceISO: new Date(win.sinceMs).toISOString(), untilISO: new Date(win.untilMs).toISOString() },
    messageCount: msgs.length, sessions, prs };
}

// ─── paso 2: prompt de redacción para el Claude headless ───────────────────────
function buildPrompt(data) {
  return `Sos el CRONISTA de PicnicZero. Escribí la BITÁCORA del día de trabajo ${data.window.label} a partir de la materia prima (JSON) al final. Es la sala de coordinación de las sesiones de Claude que laburan el proyecto en paralelo; cada "done" con un #NNN es un Pull Request mergeado a producción.

Devolvé SÓLO el markdown del documento (sin explicaciones tuyas, sin bloques de código que lo envuelvan). Estructura EXACTA, en español rioplatense:

---
tipo: bitacora
fecha: ${data.window.label}
prs: [lista de números de PR]
sesiones: <cantidad>
---

# Bitácora — ${data.window.label}

## 📖 Para Fede
Público NO técnico (Fede tiene criterio alto pero no programa). Contá qué se logró en criollo, **agrupado por tema** (no por sesión ni por PR). Por cada cosa relevante decí **dónde lo va a ver en la app** (qué pantalla/flujo) y **a qué estar atento** (qué mirar, qué podría verse raro). Nada de jerga, paths ni nombres de archivo acá. Usá viñetas y **negritas** para lo importante. Si algo quedó pendiente de una decisión suya, decilo claro.

## 🔧 Técnico
Público: otra sesión de Claude que tenga que continuar, verificar o revertir. Por CADA PR, una entrada con: número + link, título, hash del merge (para \`git revert <hash>\`), archivos clave tocados, y qué depende de qué / qué quedó pendiente. Si dos PRs se pisan o hay orden de rebase, decilo. Formato compacto y escaneable.

## ⏳ Pendientes y a seguir
Bullets con lo que quedó abierto: decisiones esperando a Fede, follow-ups declarados por las sesiones, verificaciones en prod que faltan.

Reglas: no inventes PRs ni datos que no estén en el JSON. Si un tema no tiene PR (sólo notas), igual contalo. Sé conciso pero completo.

MATERIA PRIMA (JSON):
${JSON.stringify(data, null, 2)}`;
}

// ─── post-proceso: garantizar links a PRs (determinista, no depende del modelo) ──
// El modelo a veces cita "#425" sin link. Acá convertimos TODO #NNN que sea un PR
// conocido en un link clickeable — salvo que ya esté dentro de un link markdown.
function linkifyPRs(md, prs) {
  const url = {};
  for (const p of prs) if (p.url) url[String(p.number)] = p.url;
  return md.replace(/(^|[^[\w])#(\d{2,6})\b/g, (m, pre, n) =>
    url[n] ? pre + '[#' + n + '](' + url[n] + ')' : m);
}

// Respaldo durable + privado: commit + push de la carpeta a su repo GitHub
// privado (best-effort). Sólo actúa si OUT_DIR es un repo git; si no, no-op.
// Nunca rompe la generación: sin conexión, el commit local queda para el próximo push.
function gitBackup(message) {
  const opt = { cwd: OUT_DIR, stdio: 'ignore', timeout: 30000 };
  try { execSync('git rev-parse --is-inside-work-tree', { cwd: OUT_DIR, stdio: 'ignore' }); }
  catch { return { skipped: 'la carpeta no es un repo git' }; }
  try {
    execSync('git add -A', opt);
    execSync('git commit -q -m ' + JSON.stringify(message), opt);
  } catch { /* nada nuevo para commitear → igual intentamos push por si quedó algo pendiente */ }
  try { execSync('git push -q', opt); return { ok: true }; }
  catch (e) { return { pushError: (e && e.message) || 'push falló (¿sin conexión?)' }; }
}

// claude headless: prompt por stdin, markdown por stdout. Sin permisos de tools.
function callClaude(prompt) {
  try {
    const md = execSync('claude -p --output-format text', {
      input: prompt, encoding: 'utf8', timeout: 420000,
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    }).trim();
    return md ? { md } : { error: 'claude devolvió vacío' };
  } catch (e) { return { error: 'claude headless falló: ' + (e.message || e) }; }
}

// ─── generación DIARIA ─────────────────────────────────────────────────────────
function generate(opts = {}) {
  const dateStr = opts.date || currentWorkday();
  const win = workdayWindow(dateStr);
  const data = collect(win);

  if (opts.jsonOnly) return { data };
  if (!data.sessions.length && !data.prs.length) return { empty: true, date: dateStr, data };

  const r = callClaude(buildPrompt(data));
  if (r.error) return { error: r.error, data };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${dateStr}.md`);
  fs.writeFileSync(outPath, linkifyPRs(r.md, data.prs) + '\n');
  const backup = gitBackup(`Bitácora ${dateStr}`);
  return { path: outPath, date: dateStr, prCount: data.prs.length, sessionCount: data.sessions.length, backup, data };
}

// ─── recolección SEMANAL ───────────────────────────────────────────────────────
// PRs/sesiones de toda la semana (determinista, vía collect) + las narrativas
// "Para Fede" de las bitácoras diarias ya escritas, como contexto para sintetizar.
function collectWeek(win) {
  const data = collect(win);
  const dailies = [];
  const d0 = new Date(win.sinceMs);
  for (let i = 0; i < 7; i++) {
    const dt = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i, 12);
    const f = path.join(OUT_DIR, fmtDate(dt) + '.md');
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const m = txt.match(/##\s*📖\s*Para Fede([\s\S]*?)(?:\n##\s|$)/);
    if (m) dailies.push({ date: fmtDate(dt), paraFede: m[1].trim() });
  }
  return { ...data, dailies };
}

function buildWeeklyPrompt(data) {
  return `Sos el CRONISTA de PicnicZero. Escribí la BITÁCORA SEMANAL de la semana ${data.window.label} (lunes a domingo). Es un "resumen de los resúmenes": ALTURA DE SEMANA, no día por día. Tenés la materia prima (todos los PRs de la semana enriquecidos) y las narrativas "Para Fede" de las bitácoras diarias ya escritas.

Devolvé SÓLO el markdown (sin bloques que lo envuelvan). Estructura EXACTA, español rioplatense:

---
tipo: bitacora-semanal
semana: ${data.window.label}
desde: ${data.window.weekStart}
hasta: ${data.window.weekEnd}
prs: [lista de números]
---

# Bitácora semanal — ${data.window.label}

## 📖 Para Fede
Los GRANDES TEMAS de la semana (no día por día). Por cada iniciativa/tema: qué avanzó, qué shippeó, en qué estado quedó, y a qué estar atento. Contá la TENDENCIA de la semana (ej: "el foco fue seguridad + performance"). Criollo, sin jerga ni paths. Negritas para lo importante.

## 📊 Números de la semana
Bullets: total de PRs a producción, cantidad de iniciativas/temas activos, y un breakdown corto por tema (ej: "Optimizador: 6 · Seguridad: 8 · Performance: 5").

## 🔧 Por iniciativa
Agrupá TODOS los PRs por tema/iniciativa. Bajo cada tema, listá los PRs (#N + título corto) para que una sesión encuentre todo lo de un tema junto. Compacto.

## ⏳ Pendientes acumulados
Decisiones abiertas que siguen esperando a Fede al cierre de la semana (deduplicá lo que se repite entre días).

## 🗓️ El detalle día por día
Una línea por día con su fecha (ej: "1-jul", "2-jul") y un resumen de una frase — remitiendo a la bitácora diaria para el detalle.

Reglas: no inventes PRs ni datos fuera del JSON. Sintetizá, no repitas textual las diarias.

MATERIA PRIMA (JSON):
${JSON.stringify(data, null, 2)}`;
}

// ─── generación SEMANAL ────────────────────────────────────────────────────────
function generateWeekly(opts = {}) {
  const anchor = opts.lastWeek ? Date.now() - 7 * 24 * 60 * 60 * 1000
    : (opts.date ? new Date(opts.date + 'T12:00:00').getTime() : Date.now());
  const win = weekWindowContaining(anchor);
  const data = collectWeek(win);

  if (opts.jsonOnly) return { data };
  if (!data.sessions.length && !data.prs.length) return { empty: true, weekEnd: win.weekEnd, label: win.label, data };

  const r = callClaude(buildWeeklyPrompt(data));
  if (r.error) return { error: r.error, data };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `Semana-${win.weekEnd}.md`);
  fs.writeFileSync(outPath, linkifyPRs(r.md, data.prs) + '\n');
  const backup = gitBackup(`Bitácora semanal ${win.label}`);
  return { path: outPath, weekEnd: win.weekEnd, label: win.label, prCount: data.prs.length, sessionCount: data.sessions.length, backup, data };
}

module.exports = { collect, collectWeek, generate, generateWeekly, buildPrompt, buildWeeklyPrompt, linkifyPRs, gitBackup, workdayWindow, weekWindowContaining, currentWorkday, OUT_DIR };

// directo: `node bitacora.js [--date D] [--json] [--weekly] [--last-week]`
if (require.main === module) {
  const args = process.argv.slice(2);
  const date = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
  const jsonOnly = args.includes('--json');
  const weekly = args.includes('--weekly') || args.includes('--last-week');
  const lastWeek = args.includes('--last-week');
  const r = weekly ? generateWeekly({ date, jsonOnly, lastWeek }) : generate({ date, jsonOnly });
  if (jsonOnly) { console.log(JSON.stringify(r.data, null, 2)); process.exit(0); }
  if (r.empty) { console.log(`Sin actividad ${weekly ? 'esa semana' : 'ese día'} — no se generó bitácora.`); process.exit(0); }
  if (r.error) { console.error('✗ ' + r.error); process.exit(1); }
  console.log(weekly
    ? `✓ Bitácora semanal ${r.label}: ${r.prCount} PRs, ${r.sessionCount} sesiones → ${r.path}`
    : `✓ Bitácora ${r.date}: ${r.prCount} PRs, ${r.sessionCount} sesiones → ${r.path}`);
}
