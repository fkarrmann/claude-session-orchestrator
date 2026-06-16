#!/usr/bin/env node
/**
 * PZ Sessions — Tablero + Sala de chat para orquestar sesiones paralelas de Claude.
 *
 * Tablero (izquierda): worktrees activos, colisiones, limpieza segura.
 * Sala de chat (derecha): cada sesión se presenta con un nombre y un chip de color,
 *   anuncia qué hace y avisa cuando termina. El usuario también puede escribir.
 *
 * Cero dependencias. Node puro. Corre con: node server.js  (o como servicio launchd).
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG = require('./config');   // lee pz.config.json (repo, branch, puerto) — ver config.js
const MAIN_REPO = CONFIG.repo;        // repo cuyos worktrees se orquestan
const MAIN_BRANCH = CONFIG.mainBranch;
const PORT = CONFIG.port;             // PZ_PORT override para una instancia de prueba sin chocar la viva
const REPO_NAME = CONFIG.repoName;    // basename — para detectar worktrees "named"
const OWNER = CONFIG.owner;           // nombre del dueño: trigger "@owner" + firma de respuestas de Telegram
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REFRESH_MS = 8000;   // re-escaneo de git en background
const REGISTRY = path.join(__dirname, 'registry.json'); // identidad por worktree (nombre+label) — legacy/fallback
const CHAT = path.join(__dirname, 'chat.json');          // línea de tiempo de mensajes
const SESSIONS = path.join(__dirname, 'sessions.json');  // sesiones VIVAS de Claude (por sessionId) — el modelo real
const CLAIMS = path.join(__dirname, 'claims.json');      // archivos tomados (por path absoluto)
const SESSION_TTL_MS = 30 * 60 * 1000;                    // una sesión se considera viva 30' tras su último latido

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sh(cmd, cwd = MAIN_REPO, opts = {}) {
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
    return opts.raw ? out : out.trim();
  } catch (e) {
    const out = (e.stdout || '').toString();
    return opts.raw ? out : out.trim();
  }
}
// escritura atómica: tmp + rename (el server y los procesos pz escriben chat.json a la vez)
function writeJSONAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, file); }
  catch { try { fs.unlinkSync(tmp); } catch {} }
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function readChat() {
  const arr = readJSON(CHAT, []);
  return Array.isArray(arr) ? arr.slice(-200) : [];
}
function canon(p) { try { return fs.realpathSync(p); } catch { return p; } }
// Sesiones de Claude vivas (latido < TTL). Devuelve {sessionId: {...}}.
function readLiveSessions() {
  const all = readJSON(SESSIONS, {});
  const out = {};
  for (const k of Object.keys(all)) {
    const s = all[k];
    if (s && s.lastSeen && (Date.now() - new Date(s.lastSeen).getTime() < SESSION_TTL_MS)) out[k] = s;
  }
  return out;
}

// ─── Recolección del estado de git ───────────────────────────────────────────
function parseWorktrees() {
  const out = sh('git worktree list --porcelain');
  return out.split('\n\n').filter(Boolean).map((b) => {
    const wt = { path: null, head: null, branch: null, detached: false };
    for (const l of b.split('\n')) {
      if (l.startsWith('worktree ')) wt.path = l.slice(9);
      else if (l.startsWith('HEAD ')) wt.head = l.slice(5);
      else if (l.startsWith('branch ')) wt.branch = l.slice(7).replace('refs/heads/', '');
      else if (l === 'detached') wt.detached = true;
    }
    return wt;
  }).filter((w) => w.path);
}
function classifyKind(p) {
  if (p === MAIN_REPO) return 'main';
  if (p.includes('/.claude/worktrees/')) return 'auto';
  if (p.startsWith('/tmp/') || p.startsWith('/private/tmp/')) return 'tmp';
  if (REPO_NAME && path.basename(p).startsWith(REPO_NAME + '-')) return 'named';
  return 'other';
}

// Base de comparación: el main REAL (remoto). El checkout local de main puede
// quedar cientos de commits atrás y mentir en los ↑/↓ de todos los worktrees.
let BASE_REF = MAIN_BRANCH;
function resolveBaseRef() {
  BASE_REF = sh(`git rev-parse --verify -q origin/${MAIN_BRANCH}`) ? `origin/${MAIN_BRANCH}` : MAIN_BRANCH;
}

function gather() {
  resolveBaseRef();
  const registry = readJSON(REGISTRY, {});
  const liveSessions = Object.values(readLiveSessions());
  const worktrees = parseWorktrees();

  const prByBranch = {};
  try {
    const prJson = sh(`gh pr list --state all --json number,headRefName,state,title,url,isDraft --limit 400`);
    if (prJson) for (const pr of JSON.parse(prJson)) {
      const cur = prByBranch[pr.headRefName];
      const rank = (s) => ({ OPEN: 3, MERGED: 2, CLOSED: 1 }[s] || 0);
      if (!cur || rank(pr.state) > rank(cur.state)) prByBranch[pr.headRefName] = pr;
    }
  } catch {}

  const merged = new Set(
    sh(`git branch --merged ${BASE_REF} --format=%(refname:short)`).split('\n').map((s) => s.trim()).filter(Boolean)
  );

  const sessions = worktrees.map((w) => {
    const cwd = w.path;
    const exists = fs.existsSync(cwd);
    const branch = w.detached ? null : w.branch;
    const kind = classifyKind(cwd);

    let dirtyFiles = [], stagedCount = 0, ahead = 0, behind = 0, lastSubject = '', lastRel = '', lastIso = '', upstreamGone = false;
    if (exists) {
      // raw: el trim() global comía el espacio inicial de la primera línea y el
      // slice(3) terminaba mordiendo la primera letra del nombre del archivo
      dirtyFiles = sh('git status --porcelain', cwd, { raw: true }).split('\n')
        .filter((l) => l.length > 3)
        .map((l) => { const p = l.slice(3); const i = p.indexOf(' -> '); return (i >= 0 ? p.slice(i + 4) : p).trim(); })
        .filter(Boolean);
      stagedCount = sh('git diff --cached --name-only', cwd).split('\n').filter(Boolean).length;
      const m = sh(`git rev-list --left-right --count ${BASE_REF}...HEAD`, cwd).match(/^(\d+)\s+(\d+)$/);
      if (m) { behind = +m[1]; ahead = +m[2]; }
      const parts = sh('git log -1 --format=%s%x1f%cr%x1f%cI', cwd).split('\x1f');
      lastSubject = parts[0] || ''; lastRel = parts[1] || ''; lastIso = parts[2] || '';
      if (branch && sh(`git for-each-ref --format='%(upstream:track)' refs/heads/${branch}`, cwd).includes('gone')) upstreamGone = true;
    }
    // Sesiones de Claude vivas que están EN este worktree (mismo toplevel).
    const top = canon(cwd);
    const here = liveSessions.filter((s) => canon(s.top || s.cwd || '') === top);

    const pr = branch ? prByBranch[branch] : null;
    const isMerged = branch ? (merged.has(branch) || (pr && pr.state === 'MERGED')) : false;
    const dirty = dirtyFiles.length > 0;
    const ageDays = lastIso ? (Date.now() - new Date(lastIso).getTime()) / 86400000 : 999;
    const isActive = dirty || (ahead > 0 && !isMerged && ageDays <= 4);
    const cleanable = kind !== 'main' && !dirty && (isMerged || upstreamGone || (ahead === 0 && kind === 'auto'));
    const touched = [...dirtyFiles];

    const reg = registry[branch] || registry[cwd] || null;
    // Identidad: preferir las sesiones VIVAS acá; fallback al registry legacy.
    const liveNamed = here.filter((s) => s.name);
    const sessionName = (liveNamed[0] && liveNamed[0].name) || (reg && reg.sessionName) || null;
    const label = (liveNamed[0] && liveNamed[0].label) || (reg && reg.label) || null;
    return {
      path: cwd, name: path.basename(cwd), kind, branch, detached: w.detached, exists,
      dirtyCount: dirtyFiles.length, stagedCount, ahead, behind, lastSubject, lastRel, lastIso, upstreamGone,
      pr: pr ? { number: pr.number, state: pr.state, url: pr.url, draft: pr.isDraft } : null,
      isMerged, isActive, cleanable, touched,
      sessionName, label,
      liveSessions: here.map((s) => ({ name: s.name || null, sessionId: s.sessionId, label: s.label || null, lastSeen: s.lastSeen })),
      // sólo las sesiones PRESENTADAS cuentan para la alarma: una recién abierta
      // (heartbeat del hook de arranque, sin join todavía) no es riesgo real aún
      multiSession: liveNamed.length >= 2,
    };
  });

  // Un worktree con sesiones de Claude vivas adentro cuenta como activo.
  for (const s of sessions) if (s.liveSessions && s.liveSessions.length) s.isActive = true;

  // ⛔ EL peligro central: 2+ sesiones de Claude en el MISMO directorio → commits enredados.
  const sharedDirs = sessions
    .filter((s) => s.liveSessions && s.liveSessions.filter((x) => x.name).length >= 2)
    .map((s) => ({ path: s.path, branch: s.branch, names: s.liveSessions.filter((x) => x.name).map((x) => x.name) }));
  for (const s of sessions) if (s.multiSession) s.colliding = true;

  // Colisiones: mismo archivo sin guardar en 2+ sesiones activas
  const fileOwners = {};
  for (const s of sessions.filter((x) => x.isActive)) for (const f of s.touched) (fileOwners[f] = fileOwners[f] || []).push(s);
  const collisions = Object.entries(fileOwners)
    .filter(([, o]) => new Set(o.map((s) => s.path)).size > 1)
    .map(([file, o]) => ({ file, owners: Array.from(new Set(o.map((s) => s.sessionName || s.name))) }))
    .sort((a, b) => b.owners.length - a.owners.length);
  const colliding = new Set();
  for (const c of collisions) for (const s of sessions.filter((x) => x.isActive)) if (c.owners.includes(s.sessionName || s.name)) colliding.add(s.path);
  for (const s of sessions) s.colliding = colliding.has(s.path) || !!s.multiSession;

  return {
    generatedAt: new Date().toISOString(), host: os.hostname(), sessions, collisions, sharedDirs,
    counts: {
      total: sessions.length, active: sessions.filter((s) => s.isActive).length,
      cleanable: sessions.filter((s) => s.cleanable).length,
      withPr: sessions.filter((s) => s.pr && s.pr.state === 'OPEN').length,
      collisions: collisions.length,
      sharedDirs: sharedDirs.length,
    },
  };
}

// ─── Cache + refresco ────────────────────────────────────────────────────────
let cache = { generatedAt: null, sessions: [], collisions: [], sharedDirs: [], counts: {} };
let refreshing = false;
const FETCH_MS = 5 * 60 * 1000;  // traer origin/main fresco cada 5'
let lastFetch = 0;
function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    if (Date.now() - lastFetch > FETCH_MS) { sh(`git fetch origin ${MAIN_BRANCH} --quiet`); lastFetch = Date.now(); }
    cache = gather();
  } catch (e) { console.error('[gather]', e.message); } finally { refreshing = false; }
}
refresh();
setInterval(refresh, REFRESH_MS);

// ─── Posteo de mensajes al chat ──────────────────────────────────────────────
let msgCounter = 0;
function postMessage({ from, type, text, files, branch }) {
  if (!from || !text) return { ok: false, error: 'Falta nombre o texto.' };
  const chat = readJSON(CHAT, []);
  const msg = {
    id: Date.now() + '-' + (msgCounter++),
    from: String(from).slice(0, 40),
    type: ['claim', 'done', 'warn', 'ask', 'note', 'join'].includes(type) ? type : 'note',
    text: String(text).slice(0, 1000),
    files: Array.isArray(files) ? files.slice(0, 20) : [],
    branch: branch || null,
    ts: new Date().toISOString(),
  };
  chat.push(msg);
  writeJSONAtomic(CHAT, chat.slice(-1000));
  return { ok: true, msg };
}

// ─── Notificaciones macOS ────────────────────────────────────────────────────
// Lo único que REQUIERE al usuario: preguntas (ask) y alertas (warn) de la sala.
// El resto del chat es coordinación entre sesiones y no molesta.
const NOTIFY_TYPES = { ask: '❓ Pregunta', warn: '⚠️ Ojo' };
// osascript nativo: PROBADO que se muestra en esta Mac. Limitación conocida: el
// click abre Script Editor (macOS no permite definir la acción). Se intentó
// applet propio (osacompile + bundle id + codesign) y terminal-notifier: macOS 26
// descarta en silencio las notificaciones de ambos. El camino para click útil /
// avisos remotos es el bot de Telegram (pendiente).
let lastNotifiedTs = new Date().toISOString(); // al arrancar no replaya historia
function checkNotify() {
  try {
    const chat = readChat();
    if (!chat.length) return;
    const ownerWord = OWNER ? new RegExp('\\b' + escRe(OWNER) + '\\b', 'i') : null;  // mención del owner
    const ownerAt = OWNER ? new RegExp('@' + escRe(OWNER) + '\\b', 'i') : null;       // @owner (con arroba)
    const ownerStart = OWNER ? new RegExp('^' + escRe(OWNER), 'i') : null;            // sus propios mensajes
    // no hacer eco de lo que entró por Telegram (firmado "X (Telegram)") ni de los propios mensajes del owner
    const notMine = (m) => !/\(telegram\)\s*$/i.test(m.from || '') && !(ownerStart && ownerStart.test(m.from || ''));
    // Banner local (macOS): ask/warn, y mención del owner por su nombre (si está configurado)
    const isForBanner = (m) => (NOTIFY_TYPES[m.type] || (ownerWord && ownerWord.test(m.text))) && notMine(m);
    // Telegram (el teléfono): SOLO opt-in explícito — preguntas formales (ask, llevan
    // botones y esperan respuesta) o mensajes con "@owner" CON arroba (decisión deliberada
    // de "esto me llega al teléfono"). Los warns/notes de coordinación NO van.
    const isForTg = (m) => (m.type === 'ask' || (ownerAt && ownerAt.test(m.text))) && notMine(m);
    const fresh = chat.filter((m) => m.ts > lastNotifiedTs);
    lastNotifiedTs = chat[chat.length - 1].ts;
    const news = fresh.filter(isForBanner);
    if (news.length) {
        // UNA notificación por ráfaga, con resumen si entraron varias
        const clean = (s) => String(s).replace(/['"\\$`|]/g, '').slice(0, 180);
        const m = news[news.length - 1];
        const tag = NOTIFY_TYPES[m.type] || '💬 Mensaje';
        const sub = news.length > 1 ? `${news.length} avisos nuevos — el último:` : `${tag} de ${clean(m.from)}`;
        const body = news.length > 1 ? `${tag} de ${clean(m.from)}: ${clean(m.text)}` : clean(m.text);
        // notificación nativa solo en macOS; en otros SO degrada en silencio (queda el tablero + Telegram)
        if (process.platform === 'darwin') sh(`osascript -e 'display notification "${body}" with title "PZ Sessions" subtitle "${sub}" sound name "Glass"'`);
    }
    // Telegram: uno por mensaje (las preguntas llevan sus propios botones)
    for (const x of fresh.filter(isForTg).slice(-3)) {
        console.log(`[tg→owner] ${x.type} de ${x.from}: ${String(x.text).slice(0, 80)}`);
        tgNotify(x);
    }
  } catch {}
}
setInterval(checkNotify, 3000);

// ─── Telegram — bot dedicado de alertas (opcional) ───────────────────────────
// Asks/menciones de la sala llegan por DM: las preguntas con botones ✅/❌ y opción
// de respuesta escrita; todo vuelve a la sala firmado "<owner> (Telegram)" (autor
// no-sesión → pz ask --wait lo detecta como respuesta del usuario). Config en
// telegram.json ({ token, adminUsername }, chatId se guarda tras /start) — chmod 600.
// Sin telegram.json o sin /start (chatId null) → no manda nada, espera en silencio.
const TG_CONF = path.join(__dirname, 'telegram.json');
// PZ_NO_TELEGRAM=1 lo apaga (instancia de prueba: dos consumidores de getUpdates se roban los updates entre sí)
let tg = process.env.PZ_NO_TELEGRAM ? null : readJSON(TG_CONF, null);
const tgSent = {}; // message_id Telegram → {askId, from} (rutea botones y reply-to)
function tgSave() { try { fs.writeFileSync(TG_CONF, JSON.stringify(tg, null, 2), { mode: 0o600 }); } catch {} }
async function tgApi(method, payload) {
  if (!tg || !tg.token) return null;
  try {
    const r = await fetch('https://api.telegram.org/bot' + tg.token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    return await r.json();
  } catch { return null; }
}
async function tgNotify(m) {
  if (!tg || !tg.chatId) return;
  const head = m.type === 'ask' ? '❓ Pregunta de ' : m.type === 'warn' ? '⚠️ Aviso de ' : '💬 Mensaje de ';
  const payload = {
    chat_id: tg.chatId,
    text: head + m.from + ':\n\n' + m.text + (m.type === 'ask' ? '\n\n(botones, o contestá respondiendo a este mensaje)' : ''),
  };
  if (m.type === 'ask') payload.reply_markup = { inline_keyboard: [[
    { text: '✅ Aceptar', callback_data: 'a:' + m.id },
    { text: '❌ Cancelar', callback_data: 'c:' + m.id },
  ]] };
  const r = await tgApi('sendMessage', payload);
  if (r && r.ok) tgSent[r.result.message_id] = { askId: m.id, from: m.from };
}
function askerOf(askId) {
  const m = readChat().find((x) => x.id === askId);
  return m ? m.from : null;
}
async function tgHandle(u) {
  const adminLc = ((tg && tg.adminUsername) || '').toLowerCase();
  if (u.callback_query) {
    const cq = u.callback_query;
    const okUser = ((cq.from && cq.from.username) || '').toLowerCase() === adminLc;
    const mm = okUser && String(cq.data || '').match(/^([ac]):(.+)$/);
    if (mm) {
      const verdict = mm[1] === 'a' ? '✅ Aceptar' : '❌ Cancelar';
      const asker = askerOf(mm[2]) || (tgSent[cq.message && cq.message.message_id] || {}).from;
      const who = OWNER || (cq.from && cq.from.first_name) || 'Owner';
      postMessage({ from: who + ' (Telegram)', type: 'note', text: '→ ' + (asker ? asker + ': ' : '') + verdict });
      if (cq.message) await tgApi('editMessageText', {
        chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        text: cq.message.text + '\n\n— Respondiste: ' + verdict,
      });
    }
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: mm ? 'Enviado a la sala ✓' : undefined });
    return;
  }
  const msg = u.message;
  if (!msg || !msg.text) return;
  const fromLc = ((msg.from && msg.from.username) || '').toLowerCase();
  if (msg.text.startsWith('/start')) {
    if (fromLc === adminLc && tg) {
      tg.chatId = msg.chat.id; tgSave();
      await tgApi('sendMessage', { chat_id: msg.chat.id, text: '✅ Listo. Acá te van a llegar las preguntas (❓) y avisos (⚠️) de las sesiones de Claude.\nRespondé con los botones o escribiendo — todo entra a la sala.' });
    }
    return;
  }
  if (fromLc !== adminLc) return;
  // respuesta escrita: si es reply a una pregunta puntual, la ruteo a ese asker
  const ref = msg.reply_to_message && tgSent[msg.reply_to_message.message_id];
  const who = OWNER || (msg.from && msg.from.first_name) || 'Owner';
  postMessage({ from: who + ' (Telegram)', type: 'note', text: (ref && ref.from ? '→ ' + ref.from + ': ' : '') + msg.text.slice(0, 900) });
  await tgApi('setMessageReaction', { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] });
}
let tgOffset = 0, tgPolling = false;
async function tgPoll() {
  if (!tg || !tg.token || tgPolling) return;
  tgPolling = true;
  try {
    const r = await tgApi('getUpdates', { offset: tgOffset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
    if (r && r.ok) for (const u of r.result) { tgOffset = u.update_id + 1; await tgHandle(u); }
  } catch {} finally { tgPolling = false; }
}
setInterval(tgPoll, 1500); // long-poll de 25s; el guard tgPolling evita solaparse

// ─── Limpieza segura ─────────────────────────────────────────────────────────
function cleanWorktree(wtPath, branch) {
  const s = cache.sessions.find((x) => x.path === wtPath);
  if (!s) return { ok: false, error: 'No encontrado en el último escaneo.' };
  if (!s.cleanable) return { ok: false, error: 'No es candidato seguro de limpieza.' };
  if (s.dirtyCount > 0) return { ok: false, error: 'Tiene cambios sin guardar.' };
  const rm = sh(`git worktree remove "${wtPath}"`);
  if (fs.existsSync(wtPath)) return { ok: false, error: `No se pudo quitar el worktree. ${rm}` };
  if (branch && branch !== MAIN_BRANCH) {
    // defensa: el branch viene del scan validado, pero igual exigimos un ref shell-safe
    // antes de interpolarlo (refs raros con metacaracteres no llegan a `git branch`)
    if (!/^[\w./+-]+$/.test(branch)) return { ok: false, error: `Nombre de branch no seguro: ${branch}` };
    // isMerged ya se verificó contra origin/main; `git branch -d` compara contra el
    // HEAD local (que puede estar viejo) y se negaría → -D es seguro acá
    const flag = s.isMerged || s.upstreamGone ? '-D' : '-d';
    sh(`git branch ${flag} ${branch}`);
  }
  refresh();
  return { ok: true };
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
function body(req) { return new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); }); }

// Anti-CSRF / DNS-rebinding: el server bindea 127.0.0.1, pero cualquier página web
// abierta en el browser podría POSTear a localhost:4646 (el Content-Type JSON no
// alcanza: un body text/plain que sea JSON válido pasa sin preflight). Exigimos que
// Host sea localhost y, si viene Origin (request cross-site del browser), que también lo sea.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function sameOrigin(req) {
  if (!LOCAL_HOST.test(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  return !origin || LOCAL_ORIGIN.test(origin);
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.url.startsWith('/api/') && !sameOrigin(req)) return json(403, { ok: false, error: 'forbidden (cross-origin)' });

  if (req.url === '/api/state') return json(200, { ...cache, chat: readChat() });
  if (req.url === '/api/chat') return json(200, { chat: readChat() });
  if (req.url === '/api/say' && req.method === 'POST') {
    let p = {}; try { p = JSON.parse(await body(req)); } catch {}
    const r = postMessage(p); return json(r.ok ? 200 : 400, r);
  }
  if (req.url === '/api/clean' && req.method === 'POST') {
    let p = {}; try { p = JSON.parse(await body(req)); } catch {}
    const r = cleanWorktree(p.path, p.branch); return json(r.ok ? 200 : 400, r);
  }
  if (req.url === '/api/refresh' && req.method === 'POST') { refresh(); return json(200, { ok: true }); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🎛️  PZ Sessions  →  http://localhost:${PORT}`);
  if (!CONFIG.configured) {
    console.log(`  ⚠️  Falta configurar el repo a vigilar.`);
    console.log(`     Copiá pz.config.example.json → pz.config.json y poné "repo",`);
    console.log(`     o corré:  node pz.js install <ruta-al-repo>\n`);
  } else {
    console.log(`  Escaneando: ${MAIN_REPO}  ·  refresco ${REFRESH_MS / 1000}s\n`);
  }
});

// ─── Frontend ────────────────────────────────────────────────────────────────
const HTML = /* html */ `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PZ Sessions</title>
<style>
  :root{
    --pz-body:#0b0c0c;--pz-bg:#0b0f14;--pz-card:#111826;--pz-card-in:#0d1420;
    --pz-border:#1a2536;--pz-border-h:#23314a;--pz-text:#e6edf3;--pz-muted:#7f8ea3;
    --pz-accent:#58a6ff;--pz-accent-rgb:88,166,255;
    --pz-green:#4cc38a;--pz-amber:#f0883e;--pz-red:#f85149;--pz-purple:#a78bfa;--pz-teal:#2dd4bf;
    --pz-rail-w:400px;--hd-h:54px;
    --mono:'SF Mono',Menlo,Consolas,ui-monospace,monospace}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden;
    background:var(--pz-body);color:var(--pz-text);
    font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  .ic{flex:none;vertical-align:-2px}
  code{font-family:var(--mono);font-size:.86em;background:var(--pz-card-in);border:1px solid var(--pz-border);border-radius:5px;padding:1px 5px;color:var(--pz-text)}

  header{flex:none;height:var(--hd-h);display:flex;align-items:center;gap:14px;padding:0 18px;
    background:rgba(11,12,12,.86);backdrop-filter:blur(12px);border-bottom:1px solid var(--pz-border)}
  h1{font-size:15px;margin:0;font-weight:700;display:flex;align-items:center;gap:8px;letter-spacing:.2px}
  h1 .ic{color:var(--pz-accent)}
  .stats{display:flex;gap:7px;flex-wrap:wrap;margin-left:auto}
  .stat{background:var(--pz-card);border:1px solid var(--pz-border);border-radius:8px;padding:4px 10px;font-size:12px;color:var(--pz-muted);white-space:nowrap}
  .stat b{color:var(--pz-text);font-weight:700}
  .stat.warn b{color:var(--pz-amber)}.stat.bad{border-color:rgba(248,81,73,.4)}.stat.bad b{color:var(--pz-red)}
  .icon-btn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;background:var(--pz-card);border:1px solid var(--pz-border);color:var(--pz-muted);border-radius:8px;cursor:pointer;transition:all .15s}
  .icon-btn:hover{border-color:var(--pz-accent);color:var(--pz-accent)}
  .updated{font-size:11px;color:var(--pz-muted);min-width:128px;text-align:right}

  .danger-strip{flex:none;display:flex;align-items:center;gap:9px;padding:9px 18px;font-size:12.5px;
    background:rgba(248,81,73,.1);border-bottom:1px solid rgba(248,81,73,.35);color:#ff9d9d}
  .danger-strip b{color:#ffb4b4}.danger-strip .ic{color:var(--pz-red)}
  .danger-strip code{background:rgba(248,81,73,.12);border-color:rgba(248,81,73,.3);color:#ffd0d0}

  .layout{flex:1;min-height:0;display:flex}

  /* ── Chat: la columna principal ── */
  .chat{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;background:var(--pz-body)}
  .chat-presence{flex:none;display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--pz-border)}
  .presence-lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;color:var(--pz-muted);margin-right:2px;display:flex;align-items:center;gap:6px}
  .chat-log{flex:1;overflow-y:auto;padding:18px 18px 8px;display:flex;flex-direction:column;gap:14px;
    scrollbar-width:thin;scrollbar-color:rgba(var(--pz-accent-rgb),.25) transparent}
  .chat-log::-webkit-scrollbar{width:6px}
  .chat-log::-webkit-scrollbar-track{background:transparent}
  .chat-log::-webkit-scrollbar-thumb{background:rgba(var(--pz-accent-rgb),.25);border-radius:10px}
  .chat-log::-webkit-scrollbar-thumb:hover{background:rgba(var(--pz-accent-rgb),.4)}
  .msg{display:flex;flex-direction:column;gap:5px;max-width:860px}
  .msg-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .chip{font-size:11.5px;font-weight:700;padding:2px 10px;border-radius:20px;border:1px solid;white-space:nowrap}
  .mtype{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:6px;border:1px solid var(--pz-border);color:var(--pz-muted)}
  .mtype.claim{color:var(--pz-amber);border-color:rgba(240,136,62,.35);background:rgba(240,136,62,.08)}
  .mtype.done{color:var(--pz-green);border-color:rgba(76,195,138,.35);background:rgba(76,195,138,.08)}
  .mtype.warn{color:var(--pz-red);border-color:rgba(248,81,73,.4);background:rgba(248,81,73,.08)}
  .mtype.ask{color:var(--pz-accent);border-color:rgba(var(--pz-accent-rgb),.4);background:rgba(var(--pz-accent-rgb),.08)}
  .mtype.join{color:var(--pz-purple);border-color:rgba(167,139,250,.35);background:rgba(167,139,250,.08)}
  .msg-time{font-size:10.5px;color:var(--pz-muted);margin-left:auto}
  .msg-body{font-size:13.5px;line-height:1.5;color:var(--pz-text);background:var(--pz-card);border:1px solid var(--pz-border);
    border-radius:12px;border-top-left-radius:4px;padding:9px 13px;word-break:break-word;white-space:pre-wrap;transition:border-color .2s}
  .msg:hover .msg-body{border-color:var(--pz-border-h)}
  .msg-files{font-size:11px;color:var(--pz-muted);font-family:var(--mono);margin-top:5px}
  .chat-empty{color:var(--pz-muted);font-size:13px;text-align:center;margin:auto;max-width:340px;line-height:1.6}
  .chat-compose{flex:none;border-top:1px solid var(--pz-border);padding:11px 14px;display:flex;flex-direction:column;gap:8px;background:var(--pz-bg)}
  .chat-compose .row{display:flex;gap:8px}
  .chat-compose input,.chat-compose select,.chat-compose textarea{background:var(--pz-card-in);border:1px solid var(--pz-border);color:var(--pz-text);
    border-radius:8px;padding:8px 10px;font-size:12.5px;font-family:inherit;transition:border-color .2s}
  .chat-compose input:focus,.chat-compose select:focus,.chat-compose textarea:focus{outline:none;border-color:rgba(var(--pz-accent-rgb),.5)}
  #cName{width:140px;flex:none}#cType{flex:none}
  #cText{flex:1;resize:none;min-height:38px;max-height:120px;line-height:1.4}
  .send-btn{display:flex;align-items:center;justify-content:center;gap:6px;background:var(--pz-accent);border:0;color:#04121f;border-radius:8px;padding:0 16px;cursor:pointer;font-size:13px;font-weight:700;transition:filter .15s}
  .send-btn:hover{filter:brightness(1.1)}

  /* ── Rail: el tablero, compacto ── */
  .rail{width:var(--pz-rail-w);flex:none;overflow-y:auto;border-left:1px solid var(--pz-border);background:var(--pz-bg);padding:16px 14px 28px;
    scrollbar-width:thin;scrollbar-color:rgba(var(--pz-accent-rgb),.25) transparent}
  .rail::-webkit-scrollbar{width:6px}
  .rail::-webkit-scrollbar-track{background:transparent}
  .rail::-webkit-scrollbar-thumb{background:rgba(var(--pz-accent-rgb),.25);border-radius:10px}
  .rail::-webkit-scrollbar-thumb:hover{background:rgba(var(--pz-accent-rgb),.4)}
  .sec{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--pz-muted);font-weight:700;margin:18px 2px 9px;display:flex;align-items:center;gap:6px}
  .sec:first-child{margin-top:0}.sec.bad{color:var(--pz-red)}
  .s-row{background:var(--pz-card);border:1px solid var(--pz-border);border-radius:10px;padding:11px 12px 12px 14px;position:relative;overflow:hidden;transition:border-color .2s,box-shadow .2s}
  .s-row+.s-row{margin-top:8px}
  .s-row:hover{border-color:var(--pz-border-h);box-shadow:0 2px 12px rgba(0,0,0,.2)}
  .s-row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--pz-muted);opacity:.5}
  .s-row.active::before{background:var(--pz-green);opacity:1}
  .s-row.colliding::before{background:var(--pz-red);opacity:1}
  .s-top{display:flex;align-items:center;gap:8px;margin-bottom:7px}
  .s-name{font-weight:700;font-size:13px}
  .s-kind{margin-left:auto;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--pz-muted);border:1px solid var(--pz-border);border-radius:5px;padding:1px 5px}
  .s-branch{display:inline-block;font-family:var(--mono);font-size:11px;color:var(--pz-teal);background:var(--pz-card-in);border:1px solid var(--pz-border);border-radius:6px;padding:2px 7px;margin-bottom:7px;word-break:break-all}
  .s-branch.detached{color:var(--pz-muted)}
  .s-label{font-size:12px;color:var(--pz-text);margin-bottom:8px}
  .s-sub{font-size:12px;color:var(--pz-muted);margin-bottom:8px}
  .s-pills{display:flex;flex-wrap:wrap;gap:6px}
  .pill{font-size:10.5px;font-weight:600;border-radius:6px;padding:2px 8px;border:1px solid var(--pz-border);color:var(--pz-muted);background:var(--pz-card-in);white-space:nowrap}
  .pill.green{color:var(--pz-green);border-color:rgba(76,195,138,.3)}
  .pill.amber{color:var(--pz-amber);border-color:rgba(240,136,62,.3)}
  .pill.red{color:var(--pz-red);border-color:rgba(248,81,73,.35)}
  .pill.blue{color:var(--pz-accent);border-color:rgba(var(--pz-accent-rgb),.3)}
  .pill.purple{color:var(--pz-purple);border-color:rgba(167,139,250,.3)}
  .pill.dim{color:var(--pz-muted)}
  .pill a{color:inherit;text-decoration:none}
  .s-note{font-size:11px;color:#ff9d9d;margin-top:8px;line-height:1.4}
  .danger-box{background:rgba(248,81,73,.06);border:1px solid rgba(248,81,73,.3);border-radius:10px;padding:2px 2px}
  .danger-row{display:flex;align-items:center;gap:8px;padding:7px 11px;border-bottom:1px solid var(--pz-border);font-size:12px}
  .danger-row:last-child{border:0}
  .danger-row code{color:var(--pz-amber);background:none;border:0;padding:0}
  .danger-row .who{margin-left:auto;color:var(--pz-muted);font-size:11px;text-align:right}
  .hint{font-size:11px;color:var(--pz-muted);margin:7px 2px 0;line-height:1.4}
  .clean-card{background:var(--pz-card);border:1px dashed var(--pz-border);border-radius:10px;padding:9px 11px;display:flex;align-items:center;gap:10px;font-size:12px;transition:border-color .2s}
  .clean-card+.clean-card{margin-top:7px}
  .clean-card:hover{border-color:var(--pz-border-h)}
  .clean-card .nm{font-weight:600;color:var(--pz-text);word-break:break-word}
  .clean-card .rs{font-size:11px;color:var(--pz-muted);margin-top:1px}
  .clean-btn{margin-left:auto;flex:none;display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;border:1px solid rgba(248,81,73,.2);background:transparent;color:#ff9d9d;border-radius:7px;padding:5px 9px;cursor:pointer;transition:all .15s}
  .clean-btn:hover{background:rgba(248,81,73,.14);border-color:rgba(248,81,73,.4)}
  .empty{color:var(--pz-muted);font-size:12.5px;padding:4px 2px}

  .toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--pz-card);border:1px solid var(--pz-border);border-radius:10px;padding:10px 16px;font-size:13px;opacity:0;pointer-events:none;transition:.25s;z-index:50;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  .toast.show{opacity:1}.toast.ok{border-color:rgba(76,195,138,.4)}.toast.err{border-color:rgba(248,81,73,.4)}

  @media(max-width:820px){
    .layout{flex-direction:column-reverse}
    .rail{width:auto;flex:none;border-left:0;border-top:1px solid var(--pz-border);max-height:42vh}
    .chat{min-height:52vh}
    .msg{max-width:none}
  }
</style></head>
<body>
<header>
  <h1 id="brand"></h1>
  <div class="stats" id="stats"></div>
  <button class="icon-btn" id="refreshBtn" title="Refrescar"></button>
  <div class="updated" id="updated"></div>
</header>
<div id="danger"></div>
<div class="layout">
  <section class="chat">
    <div class="chat-presence" id="presence"></div>
    <div class="chat-log" id="chatlog"></div>
    <div class="chat-compose">
      <div class="row">
        <input id="cName" placeholder="tu nombre" />
        <select id="cType">
          <option value="note">nota</option>
          <option value="claim">me agarro</option>
          <option value="done">terminé</option>
          <option value="warn">ojo</option>
          <option value="ask">pregunta</option>
        </select>
      </div>
      <div class="row">
        <textarea id="cText" placeholder="escribir mensaje…  (Enter para enviar)"></textarea>
        <button class="send-btn" id="sendBtn" title="Enviar"></button>
      </div>
    </div>
  </section>
  <aside class="rail" id="rail"></aside>
</div>
<div class="toast" id="toast"></div>

<script>
const esc=(s)=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// chip de color ESTABLE derivado del nombre — la identidad de cada sesión
function hueOf(name){let h=0;const s=name||'?';for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h%360;}
function chip(name){if(!name)return '';const h=hueOf(name);
  return '<span class="chip" style="background:hsl('+h+',55%,18%);border-color:hsl('+h+',60%,42%);color:hsl('+h+',75%,72%)">'+esc(name)+'</span>';}
function fmtTime(iso){const d=new Date(iso),now=new Date();const diff=(now-d)/1000;
  const hm=d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',hour12:false});
  let rel; if(diff<60)rel='recién'; else if(diff<3600)rel='hace '+Math.floor(diff/60)+'m';
  else if(diff<86400 && d.getDate()===now.getDate())rel=hm; else rel=d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'})+' '+hm;
  return {rel,full:d.toLocaleString('es-AR')};}
const TYPE_LABEL={claim:'me agarro',done:'terminó',warn:'ojo',ask:'pregunta',join:'se sumó',note:''};

// ── Íconos (Bootstrap Icons, inline SVG — cero dependencias, sin emojis) ──
const ICON={
  chat:'<path d="M2.678 11.894a1 1 0 0 1 .287.801 11 11 0 0 1-.398 2c1.395-.323 2.247-.697 2.634-.893a1 1 0 0 1 .71-.074A8 8 0 0 0 8 14c3.996 0 7-2.807 7-6 0-3.192-3.004-6-7-6S1 4.808 1 8c0 1.468.617 2.83 1.678 3.894m-.493 3.905a22 22 0 0 1-.713.129c-.2.032-.352-.176-.273-.362a10 10 0 0 0 .244-.637l.003-.01c.248-.72.45-1.548.524-2.319C.743 11.37 0 9.76 0 8c0-3.866 3.582-7 8-7s8 3.134 8 7-3.582 7-8 7a9 9 0 0 1-2.347-.306c-.52.263-1.639.742-3.468 1.105"/>',
  danger:'<path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"/>',
  refresh:'<path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466"/>',
  send:'<path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.11ZM6.636 10.07l2.761 4.338L14.13 2.576zm6.787-8.201L1.591 6.602l4.339 2.76z"/>',
  people:'<path d="M15 14s1 0 1-1-1-4-5-4-5 3-5 4 1 1 1 1zm-7.978-1A.13.13 0 0 1 7 13h4.99q.01-.452-.32-1.005a4.5 4.5 0 0 0-1.166-1.249C9.879 10.219 9.05 10 8 10c-1.99 0-3 1.5-3 2.5 0 .456.291.81.32.5zM11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0"/>',
  broom:'<path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5M11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1zm1.958 1-.846 10.58a1 1 0 0 1-.997.92h-6.23a1 1 0 0 1-.997-.92L3.042 3.5z"/>',
};
const ic=(n,cls,sz)=>'<svg class="ic'+(cls?' '+cls:'')+'" width="'+(sz||14)+'" height="'+(sz||14)+'" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'+(ICON[n]||'')+'</svg>';
const pill=(t,k)=>'<span class="pill'+(k?' '+k:'')+'">'+esc(String(t))+'</span>';

// ── Chat (columna principal) ──
let atBottom=true;
function renderPresence(sessions){
  const el=document.getElementById('presence');const names=[];
  for(const s of sessions||[])for(const l of (s.liveSessions||[]))if(l.name&&!names.includes(l.name))names.push(l.name);
  if(!names.length){el.style.display='none';el.innerHTML='';return;}
  el.style.display='flex';
  el.innerHTML='<span class="presence-lbl">'+ic('people')+'En la sala</span>'+names.map(chip).join('');
}
function renderChat(chat){
  const log=document.getElementById('chatlog');
  if(!chat.length){log.innerHTML='<div class="chat-empty">Todavía nadie habló.<br>Las sesiones se presentan acá y avisan qué hacen — y vos también escribís.</div>';return;}
  log.innerHTML=chat.map(m=>{const t=fmtTime(m.ts);const tl=TYPE_LABEL[m.type]||'';
    return '<div class="msg"><div class="msg-top">'+chip(m.from)
      +(tl?'<span class="mtype '+m.type+'">'+tl+'</span>':'')
      +'<span class="msg-time" title="'+t.full+'">'+t.rel+'</span></div>'
      +'<div class="msg-body">'+esc(m.text)
      +(m.files&&m.files.length?'<div class="msg-files">'+m.files.map(esc).join(' · ')+'</div>':'')
      +'</div></div>';}).join('');
  if(atBottom)log.scrollTop=log.scrollHeight;
}
document.getElementById('chatlog').addEventListener('scroll',function(){
  atBottom=this.scrollHeight-this.scrollTop-this.clientHeight<40;});

async function loadChat(){const r=await fetch('/api/chat');const d=await r.json();renderChat(d.chat||[]);}
async function sendMsg(){
  const name=document.getElementById('cName').value.trim();
  const text=document.getElementById('cText').value.trim();
  const type=document.getElementById('cType').value;
  if(!name){toast('Poné tu nombre','err');return;}
  if(!text)return;
  localStorage.setItem('pzChatName',name);
  const r=await fetch('/api/say',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:name,type,text})});
  if((await r.json()).ok){document.getElementById('cText').value='';atBottom=true;loadChat();}
  else toast('No se pudo enviar','err');
}
document.getElementById('cText').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});
document.getElementById('sendBtn').addEventListener('click',sendMsg);

// ── Tablero (rail) ──
function prPill(pr){if(!pr)return '';const m={OPEN:'green',MERGED:'purple',CLOSED:'dim'},l={OPEN:'PR abierto',MERGED:'PR mergeado',CLOSED:'PR cerrado'};
  return '<span class="pill '+(m[pr.state]||'dim')+'"><a href="'+pr.url+'" target="_blank" rel="noopener">#'+pr.number+' · '+l[pr.state]+'</a></span>';}
function sessionRow(s){
  const cls=['s-row',s.kind];if(s.isActive)cls.push('active');if(s.colliding)cls.push('colliding');
  const pills=[];
  if(s.liveSessions&&s.liveSessions.length){
    const named=s.liveSessions.filter(x=>x.name).length, anon=s.liveSessions.length-named;
    let txt=named?(named+' sesión'+(named>1?'es':'')):'';
    if(anon)txt+=(txt?' · ':'')+anon+' s/present.';
    pills.push(pill(txt,named>=2?'red':'green'));
  }
  pills.push(s.dirtyCount>0?pill(s.dirtyCount+' sin guardar','amber'):pill('limpio','dim'));
  if(s.stagedCount>0)pills.push(pill(s.stagedCount+' en cola','amber'));
  if(s.ahead>0)pills.push(pill('+'+s.ahead+' vs main','blue'));
  if(s.isMerged)pills.push(pill('mergeado','purple'));
  if(s.upstreamGone)pills.push(pill('remoto borrado','red'));
  pills.push(prPill(s.pr));
  const head=(s.sessionName?chip(s.sessionName):'<span class="s-name">'+esc(s.name)+'</span>')+'<span class="s-kind">'+esc(s.kind)+'</span>';
  const body=s.label?'<div class="s-label">'+esc(s.label)+'</div>':(s.lastSubject?'<div class="s-sub">'+esc(s.lastSubject)+'</div>':'<div class="s-sub">sin commits</div>');
  const branch=s.branch?'<span class="s-branch">'+esc(s.branch)+'</span>':'<span class="s-branch detached">detached</span>';
  const note=s.multiSession?'<div class="s-note">2+ sesiones de Claude en este dir — riesgo de commit enredado (que se aíslen: pz isolate)</div>':(s.colliding?'<div class="s-note">comparte archivos sin guardar con otra sesión</div>':'');
  return '<div class="'+cls.join(' ')+'"><div class="s-top">'+head+'</div>'+branch+body+'<div class="s-pills">'+pills.filter(Boolean).join('')+'</div>'+note+'</div>';
}
function cleanCard(s){const reason=s.isMerged?'mergeado a main':s.upstreamGone?'remoto borrado':'worktree sin trabajo propio';
  return '<div class="clean-card"><div><div class="nm">'+esc(s.name)+'</div><div class="rs">'+(s.branch?esc(s.branch)+' · ':'')+reason+'</div></div>'
    +'<button class="clean-btn" data-path="'+esc(s.path)+'" data-branch="'+esc(s.branch||'')+'" data-name="'+esc(s.name)+'">'+ic('broom')+'limpiar</button></div>';}

async function loadState(){
  const rail=document.getElementById('rail');const ry=rail?rail.scrollTop:0;
  const r=await fetch('/api/state');const d=await r.json();
  renderState(d);
  const rail2=document.getElementById('rail');if(rail2)rail2.scrollTop=ry;
  renderPresence(d.sessions);renderChat(d.chat||[]);
}
function renderState(d){
  const c=d.counts;
  document.getElementById('stats').innerHTML='<span class="stat"><b>'+c.active+'</b> activas</span><span class="stat"><b>'+c.total+'</b> worktrees</span>'
    +'<span class="stat"><b>'+c.withPr+'</b> PR</span>'+((c.sharedDirs>0)?'<span class="stat bad"><b>'+c.sharedDirs+'</b> dir compartido</span>':'')
    +(c.collisions>0?'<span class="stat bad"><b>'+c.collisions+'</b> colisiones</span>':'')
    +(c.cleanable>0?'<span class="stat warn"><b>'+c.cleanable+'</b> limpiables</span>':'');
  document.getElementById('updated').textContent='actualizado '+new Date(d.generatedAt).toLocaleTimeString('es-AR');
  // franja roja full-width: lo más peligroso, imposible de no ver
  const dn=document.getElementById('danger');
  if(d.sharedDirs&&d.sharedDirs.length){
    dn.className='danger-strip';
    dn.innerHTML=ic('danger',null,16)+'<span><b>'+d.sharedDirs.length+' directorio'+(d.sharedDirs.length>1?'s':'')+' con 2+ sesiones de Claude</b> — riesgo de commit enredado. Que cada una se aísle: <code>pz isolate &lt;tarea&gt;</code></span>';
  }else{dn.className='';dn.innerHTML='';}
  const ss=d.sessions.slice().sort((a,b)=>{const rk=(s)=>(s.colliding?0:1)*100+(s.isActive?0:1)*10+({named:0,main:1,tmp:2,auto:3,other:4}[s.kind]||5);return rk(a)-rk(b)||b.ahead-a.ahead;});
  const active=ss.filter(s=>s.isActive||s.kind==='named'||s.kind==='main');
  const idle=ss.filter(s=>!(s.isActive||s.kind==='named'||s.kind==='main')&&!s.cleanable);
  const cleanable=ss.filter(s=>s.cleanable);
  let h='';
  if(d.sharedDirs&&d.sharedDirs.length){h+='<div class="sec bad">'+ic('danger')+'2+ sesiones en el mismo dir</div><div class="danger-box">'
    +d.sharedDirs.map(x=>'<div class="danger-row"><code style="color:var(--pz-red)">'+esc(x.branch||x.path)+'</code><span class="who">'+x.names.map(esc).join(' · ')+'</span></div>').join('')
    +'</div><div class="hint">Cada sesión debería aislarse en su worktree: <code>pz isolate &lt;tarea&gt;</code></div>';}
  if(d.collisions.length){h+='<div class="sec">Colisiones — mismo archivo en 2+ sesiones</div><div class="danger-box">'
    +d.collisions.map(x=>'<div class="danger-row"><code>'+esc(x.file)+'</code><span class="who">'+x.owners.map(esc).join(' · ')+'</span></div>').join('')+'</div>';}
  h+='<div class="sec">Sesiones activas</div>'+(active.length?active.map(sessionRow).join(''):'<div class="empty">Sin trabajo en curso.</div>');
  if(cleanable.length)h+='<div class="sec">'+ic('broom')+'Limpieza segura — '+cleanable.length+'</div>'+cleanable.map(cleanCard).join('');
  if(idle.length)h+='<div class="sec">Inactivas — '+idle.length+'</div>'+idle.map(sessionRow).join('');
  document.getElementById('rail').innerHTML=h;
}
document.getElementById('rail').addEventListener('click',e=>{
  const b=e.target.closest('.clean-btn');if(!b)return;
  cleanIt({path:b.dataset.path,branch:b.dataset.branch||null,name:b.dataset.name});
});
async function cleanIt(p){if(!confirm('¿Limpiar "'+p.name+'"?\\nQuita el worktree y borra '+(p.branch||'la rama')+'.'))return;
  const r=await fetch('/api/clean',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
  if((await r.json()).ok){toast('Limpiado: '+p.name,'ok');loadState();}else toast('No se pudo limpiar','err');}
async function hardRefresh(){await fetch('/api/refresh',{method:'POST'});setTimeout(loadState,400);}
let tT;function toast(m,k){const t=document.getElementById('toast');t.textContent=m;t.className='toast show '+(k||'');clearTimeout(tT);tT=setTimeout(()=>t.className='toast',2500);}

// init
document.getElementById('brand').innerHTML=ic('chat','',16)+' PZ Sessions';
document.getElementById('refreshBtn').innerHTML=ic('refresh');
document.getElementById('sendBtn').innerHTML=ic('send');
document.getElementById('refreshBtn').addEventListener('click',hardRefresh);
document.getElementById('cName').value=localStorage.getItem('pzChatName')||'';
loadState();setInterval(loadState,${REFRESH_MS});setInterval(loadChat,3000);
</script>
</body></html>`;
