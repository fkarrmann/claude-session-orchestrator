#!/usr/bin/env node
/**
 * pz — CLI de las sesiones de Claude para la Sala de Sesiones.
 *
 * MODELO (v2): la unidad real es la SESIÓN de Claude (CLAUDE_CODE_SESSION_ID),
 * no el worktree. Dos sesiones en el MISMO directorio son el peligro real
 * (mezclan commits) — y ahora se distinguen y se frenan.
 *
 *   pz join "<Nombre>" ["<qué hacés>"]   presentarse (nombre + chip de color)
 *   pz say <tipo> "<texto>" [files]       postear al chat (claim|done|warn|ask|note)
 *   pz ask [--wait] [--timeout N] "<q>"   preguntar a la sala; --wait espera la respuesta
 *   pz claim <archivos|carpetas...>       tomar (carpeta = todo lo de adentro)
 *   pz release [archivos...]              soltar archivos (todos si no se especifica)
 *   pz isolate [<slug>] [--carry <archivos>]  (sólo desde la carpeta principal) worktree propio off main
 *   pz board [--for-hook]                 ver sesiones + colisiones + chat
 *   pz chat [N]                           sólo la sala (últimos N mensajes)
 *   pz whoami                             tu identidad
 *   pz leave                              salir de la sala (libera tus claims) — lo corre el hook SessionEnd
 *   pz guard                              árbitro de hooks PreToolUse (Edit/Write/Bash) — uso interno
 *   pz inbox                              hook PostToolUse/UserPromptSubmit: entrega chat nuevo a la sesión — uso interno
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { readJSON, writeJSON, mutate, napMs } = require('./state');  // estado compartido con server.js: escritura honesta + sin perder updates
const CFG = require('./config');                  // lee pz.config.json (repo, branch, etc.) — ver config.js
const DIR = __dirname;
const SESSIONS = path.join(DIR, 'sessions.json'); // sesiones vivas de Claude, por sessionId
const CLAIMS = path.join(DIR, 'claims.json');     // archivos tomados, por path absoluto
const CHAT = path.join(DIR, 'chat.json');
const MAIN_REPO = CFG.repo;                       // repo cuyos worktrees se orquestan
const MAIN_BRANCH = CFG.mainBranch;               // rama principal (isolate parte de origin/<MAIN_BRANCH>)
const REPO_NAME = CFG.repoName;                   // basename — para el descarte rápido del guard
const PZ_SCRIPT = CFG.pzScript;                   // ruta a este pz.js — para los mensajes del board (sin hardcodear)
const ENV_DIRS = CFG.envDirs;                     // dirs cuyos .env* copia `pz isolate` al worktree nuevo

const SESSION_TTL_MS = 30 * 60 * 1000;     // una sesión se considera viva 30' tras su último latido
// …y "en pausa" (se la sigue mostrando, con su nombre) hasta 24h sin latido: una sesión
// de la app puede quedar quieta horas sin estar cerrada. Antes se borraba a los 30' y
// volvía sin nombre — así fue como "Visualización de informes de cancha" nunca apareció.
const SESSION_KEEP_MS = 24 * 60 * 60 * 1000;
const TITLE_RECHECK_MS = 60 * 1000;        // cada cuánto buscar el título de una sesión que todavía no lo tiene
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;   // un claim caduca a las 2h (red de seguridad)

// ─── helpers ─────────────────────────────────────────────────────────────────
const sh = (c, cwd) => { try { return execSync(c, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 }).trim(); } catch { return ''; } };
const now = () => Date.now();
const fresh = (iso, ttl) => iso && (now() - new Date(iso).getTime() < ttl);

// path absoluto y canónico (resuelve /tmp→/private/tmp y symlinks del dir)
function canon(p) {
  if (!p) return p;
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch {}
  try { const d = fs.realpathSync(path.dirname(abs)); return path.join(d, path.basename(abs)); } catch {}
  return abs;
}
function toplevelOf(cwd) { return canon(sh('git rev-parse --show-toplevel', cwd) || cwd); }
// La carpeta principal del repo: ahí no trabaja nadie (la app le da a cada sesión su worktree).
const MAIN_TOP = MAIN_REPO ? canon(MAIN_REPO) : null;
const isMainFolder = (top) => !!MAIN_TOP && top === MAIN_TOP;
function commonDirOf(cwd) { const d = sh('git rev-parse --git-common-dir', cwd); return d ? canon(path.resolve(cwd, d)) : null; }
// Cortocircuito barato (sin git): la enorme mayoría de las invocaciones del hook
// son en OTROS proyectos → descartarlas por prefijo de path antes de tocar git.
function maybePz(cwd) {
  if (!cwd || !REPO_NAME) return false;   // sin repo configurado → inerte (fail-open en todos lados)
  return cwd.includes(REPO_NAME) || /^(?:\/private)?\/tmp\/pz-/.test(cwd) || /\/\.claude\/worktrees\//.test(cwd);
}
let _pzCommon = null;
function inPzRepo(cwd) {
  if (!maybePz(cwd)) return false;            // descarte rápido sin spawnear git
  if (_pzCommon === null) _pzCommon = commonDirOf(MAIN_REPO) || false;
  const c = commonDirOf(cwd);
  return !!c && !!_pzCommon && c === _pzCommon;
}

// ─── entrada de hooks (stdin JSON) ─────────────────────────────────────────────
// Sólo se lee para subcomandos que SIEMPRE corren como hook (guard/leave/board --for-hook).
function hookInput() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// ─── identidad de sesión ────────────────────────────────────────────────────
function sessionIdFrom(hook) {
  return (hook && hook.session_id) || process.env.CLAUDE_CODE_SESSION_ID || 'env-' + (process.env.TERM_SESSION_ID || process.ppid || 'unknown');
}
function ctx(hook) {
  const sid = sessionIdFrom(hook);
  const cwd = (hook && hook.cwd) || process.cwd();
  return { sid, cwd, top: toplevelOf(cwd), branch: sh('git rev-parse --abbrev-ref HEAD', cwd) || null };
}

// Devuelve sólo las sesiones VIVAS (latido < 30'). Las que están en pausa quedan
// guardadas hasta 24h pero no cuentan para frenos, claims ni alarmas.
function loadSessions() {
  const all = mutate(SESSIONS, {}, (all) => {
    let changed = false;
    for (const k of Object.keys(all)) if (!fresh(all[k].lastSeen, SESSION_KEEP_MS)) { delete all[k]; changed = true; }
    return changed ? all : null;
  });
  return Object.fromEntries(Object.entries(all).filter(([, s]) => fresh(s.lastSeen, SESSION_TTL_MS)));
}

// El título que la app (o /rename) le puso a la sesión. Claude Code lo anota en el
// registro de la conversación como {"type":"custom-title","customTitle":"…"}; vale el
// último. Sin registro o sin título todavía (la app lo pone tras el primer mensaje) → null.
function sessionTitle(transcript) {
  if (!transcript) return null;
  let txt; try { txt = fs.readFileSync(transcript, 'utf8'); } catch { return null; }
  for (let i = txt.lastIndexOf('"custom-title"'); i >= 0;) {
    const a = txt.lastIndexOf('\n', i) + 1, b = txt.indexOf('\n', i);
    try { const t = String(JSON.parse(txt.slice(a, b < 0 ? undefined : b)).customTitle || '').trim(); if (t) return t.slice(0, 40); } catch {}
    if (a === 0) break;
    i = txt.lastIndexOf('"custom-title"', a - 1);
  }
  return null;
}
// Nombre por defecto mientras no haya título: la rama, sin el prefijo de la herramienta.
function defaultName(loc) {
  const b = loc.branch && loc.branch !== 'HEAD' ? loc.branch.replace(/^(claude|pz|feat|feature|fix|chore)\//, '') : '';
  return (b || path.basename(loc.top || loc.cwd || '') || 'sesión').slice(0, 40);
}
// Los nombres son la dirección de la sala (--to): dos sesiones no pueden compartirlo.
function uniqueName(all, sid, base) {
  const taken = new Set(Object.values(all).filter((s) => s.sessionId !== sid && s.name).map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) { const cand = `${base.slice(0, 35)} (${n})`; if (!taken.has(cand)) return cand; }
}

// upsert + latido. patch: name/label (join), move + isolatedTo (isolate).
// hook: el JSON del hook, que trae el registro de la conversación (de ahí sale el título).
// Toda sesión queda con nombre: el que eligió con `pz join` o uno automático
// (título de la app, o la rama mientras no tenga título). El automático nunca pisa al elegido.
function heartbeat(c, patch = {}, hook = null) {
  const before = readJSON(SESSIONS, {})[c.sid] || {};
  const transcript = (hook && hook.transcript_path) || before.transcript || null;
  const auto = !patch.name && (!before.name || before.autoName);
  // leer el título fuera del lock (el registro puede pesar varios MB); los hooks de
  // herramientas lo buscan a lo sumo una vez por minuto, y ya encontrado, cada 10'
  const lastCheck = before.titleCheckedAt ? now() - new Date(before.titleCheckedAt).getTime() : Infinity;
  const atTurn = !!hook && ['SessionStart', 'UserPromptSubmit'].includes(hook.hook_event_name);   // arranque o mensaje nuevo: buscar siempre
  const checkTitle = auto && !!transcript && (atTurn || lastCheck > (before.titled ? 10 * TITLE_RECHECK_MS : TITLE_RECHECK_MS));
  const title = checkTitle ? sessionTitle(transcript) : null;
  // Una sesión aislada sigue reportando su carpeta de ARRANQUE en cada hook: si no, cada
  // latido la "mudaba" de vuelta (le pasó a "Canchas al mapa", que figuraba en la carpeta
  // principal trabajando en /tmp/pz-canchas).
  let loc = { cwd: c.cwd, top: c.top, branch: c.branch };
  if (patch.move) loc = patch.move;
  else if (before.isolatedTo && before.top === before.isolatedTo && c.top !== before.isolatedTo && c.top === before.home)
    loc = { cwd: before.cwd, top: before.top, branch: sh('git rev-parse --abbrev-ref HEAD', before.top) || before.branch };
  const inRepo = before.inRepo && loc.top === before.top ? true : inPzRepo(loc.cwd);
  return mutate(SESSIONS, {}, (all) => {
    const prev = all[c.sid] || {};
    let name = prev.name || null, autoName = !!prev.autoName, titled = !!prev.titled;
    if (patch.name) { name = patch.name; autoName = false; titled = false; }
    else if (!name || autoName) {
      autoName = true;
      if (title) { name = title === name ? name : uniqueName(all, c.sid, title); titled = true; }
      else if (!titled) {
        const base = defaultName(loc);
        if (!(name && (name === base || name.startsWith(base.slice(0, 35) + ' (')))) name = uniqueName(all, c.sid, base);
      }
    }
    all[c.sid] = {
      ...prev, // preserva campos extra (chatSeen, etc.)
      sessionId: c.sid,
      name, autoName, titled,
      label: patch.label !== undefined ? patch.label : (prev.label || null),
      cwd: loc.cwd, top: loc.top, branch: loc.branch,
      home: prev.home || c.top,                                    // dónde arrancó
      ...(patch.isolatedTo ? { isolatedTo: patch.isolatedTo } : {}),
      inRepo,
      transcript: transcript || prev.transcript || null,
      ...(checkTitle ? { titleCheckedAt: new Date().toISOString() } : {}),
      startedAt: prev.startedAt || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    // prune de paso: sólo lo que lleva más de 24h sin dar señales
    for (const k of Object.keys(all)) if (k !== c.sid && !fresh(all[k].lastSeen, SESSION_KEEP_MS)) delete all[k];
    return all;
  })[c.sid];
}
function myName(c) { const s = readJSON(SESSIONS, {})[c.sid]; return s && s.name; }
function liveOthersInTop(top, sid) {
  const all = loadSessions();
  return Object.values(all).filter((s) => s.top === top && s.sessionId !== sid && fresh(s.lastSeen, SESSION_TTL_MS));
}

// ─── claims (archivos tomados) ────────────────────────────────────────────────
function loadClaims() {
  const live = loadSessions();   // FUERA del lock de claims: nunca anidar dos locks
  return mutate(CLAIMS, {}, (all) => {
    let changed = false;
    for (const k of Object.keys(all)) {
      const cl = all[k];
      if (!fresh(cl.ts, CLAIM_TTL_MS) || !live[cl.sessionId]) { delete all[k]; changed = true; }
    }
    return changed ? all : null;
  });
}
function setClaim(absPath, c, opts = {}) {
  const name = myName(c) || 'sesión';   // lee SESSIONS antes de tomar el lock de CLAIMS
  mutate(CLAIMS, {}, (all) => {
    all[canon(absPath)] = { sessionId: c.sid, name, ts: new Date().toISOString(), ...(opts.dir ? { dir: true } : {}) };
    return all;
  });
}
function ownerOf(absPath, sid) {
  const all = loadClaims();
  const p = canon(absPath);
  const cl = all[p];
  if (cl && cl.sessionId !== sid) return cl;
  // claims de DIRECTORIO: si un ancestro fue tomado por otra sesión, aplica
  let dir = path.dirname(p);
  while (dir && dir !== path.dirname(dir)) {
    const dc = all[dir];
    if (dc && dc.dir && dc.sessionId !== sid) return { ...dc, dirPath: dir };
    dir = path.dirname(dir);
  }
  return null;
}
function releaseClaims(sid, files) {
  let n = 0;
  mutate(CLAIMS, {}, (all) => {
    for (const k of Object.keys(all)) {
      if (all[k].sessionId !== sid) continue;
      if (files && files.length && !files.map(canon).includes(k)) continue;
      delete all[k]; n++;
    }
    return n ? all : null;
  });
  return n;
}

// ─── chat ──────────────────────────────────────────────────────────────────
let counter = 0;
function post({ from, type, text, files, branch, to }) {
  mutate(CHAT, [], (chat) => {
  chat.push({
    id: now() + '-' + (counter++), from: String(from).slice(0, 40),
    ...(to ? { to: String(to).slice(0, 40) } : {}),
    type: ['claim', 'done', 'warn', 'ask', 'note', 'join'].includes(type) ? type : 'note',
    text: String(text).slice(0, 1000),
    files: files ? (Array.isArray(files) ? files : String(files).split(',')).map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : [],
    branch: branch || null, ts: new Date().toISOString(),
  });
  return chat.slice(-1000);
  });
}
// Una línea de la sala. SIEMPRE con el destinatario: sin él, dos avisos seguidos del mismo
// autor a dos sesiones distintas se leían como el mismo mensaje repetido.
function fmtMsg(m, meName) {
  const t = new Date(m.ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return `[${t}] ${m.from}${m.to ? ` → ${m.to === meName ? 'VOS' : m.to}` : ''} (${m.type}): ${m.text}`;
}
function markChatSeen(sid, ts) {
  mutate(SESSIONS, {}, (all) => {
    if (!all[sid]) return null;
    all[sid].chatSeen = ts;
    return all;
  });
}
const sleep = napMs;
// --flag "valor" → devuelve el valor y lo SACA de args (los subcomandos usan posicionales)
function takeFlag(args, flag, max = 40) {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, v === undefined ? 1 : 2);
  return v === undefined ? null : String(v).slice(0, max);
}

// ════════════════════════════════════════════════════════════════════════════
const [cmd, ...rest] = process.argv.slice(2);

// Si algo revienta (disco lleno, permisos, JSON ilegible): en los hooks callamos y
// dejamos pasar —un hook nunca frena a la sesión—, pero en el uso interactivo se
// muestra el error de verdad en vez de un "✓" que miente.
const HOOK_CMDS = new Set(['guard', 'inbox', 'leave']);
process.on('uncaughtException', (e) => {
  if (HOOK_CMDS.has(cmd) || rest.includes('--for-hook')) process.exit(0);
  console.error('✗ pz: ' + ((e && e.message) || e));
  process.exit(1);
});

// ─── guard (hook PreToolUse) ─ árbitro: allow (exit 0) / deny (exit 2 + stderr)
// FAIL-OPEN: ante cualquier duda/error, deja pasar. Sólo actúa dentro del repo configurado.
if (cmd === 'guard') {
  try {
    const hook = hookInput();
    const cwd0 = (hook && hook.cwd) || process.cwd();
    if (!maybePz(cwd0)) process.exit(0);     // descarte rápido sin git (otros proyectos)
    const c = ctx(hook);
    if (!inPzRepo(c.cwd)) process.exit(0);   // fuera del repo configurado: no tocar nada
    heartbeat(c, {}, hook);                  // latido (así otras sesiones me "ven" acá)

    const tool = hook.tool_name;
    const ti = hook.tool_input || {};

    // ── Edit/Write: frenar si otra sesión viva TOMÓ ese archivo ──
    // OJO: el repo relevante es el del ARCHIVO, no el cwd de la sesión (una
    // sesión con cwd en el repo configurado puede editar archivos de OTRO repo).
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
      const file = ti.file_path || ti.notebook_path;
      if (!file) process.exit(0);
      const absFile = canon(path.resolve(c.cwd, file));
      const fileDir = path.dirname(absFile);
      if (!inPzRepo(fileDir)) process.exit(0);   // archivo fuera del repo configurado → no tocar
      const owner = ownerOf(absFile, c.sid);
      if (owner) {
        const what = owner.dir ? `la carpeta ${path.basename(owner.dirPath || '')}/ (incluye este archivo)` : `este archivo (${path.basename(absFile)})`;
        process.stderr.write(
          `⛔ PZ Sessions: "${owner.name}" ya tomó ${what}.\n` +
          `   Editarlo ahora pisa su trabajo en el mismo working tree.\n` +
          `   Opciones: coordiná por chat (pz say ask "…"), pedíle que lo suelte (pz release),\n` +
          `   o aislate en tu propio worktree (pz isolate <tarea>) y trabajá la copia ahí.\n`);
        process.exit(2);
      }
      // auto-claim: el primero que edita un archivo en un worktree compartido lo "toma"
      if (liveOthersInTop(toplevelOf(fileDir), c.sid).length > 0) setClaim(absFile, c);
      process.exit(0);
    }

    // ── Bash: frenar el "commit todo a ciegas" en dir compartido y sucio ──
    if (tool === 'Bash') {
      // Sacar lo que está ENTRE COMILLAS (es dato, no comando) para no frenar
      // por un `git add -A` que aparece dentro de un mensaje/echo. Y exigir que
      // `git` esté en posición de comando (inicio o tras ; && || | ( newline).
      const command = String(ti.command || '')
        .replace(/'[^']*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const B = '(?:^|[;&|(\\n])\\s*';
      const isAddAll = new RegExp(B + 'git\\b[^|&;\\n]*?\\sadd\\s+(?:-A\\b|--all\\b|\\.(?:\\s|$))').test(command);
      const isCommitAll = new RegExp(B + 'git\\b[^|&;\\n]*?\\scommit\\b[^|&;\\n]*?\\s-(?:[A-Za-z]*a[A-Za-z]*)\\b').test(command)
        || new RegExp(B + 'git\\b[^|&;\\n]*?\\scommit\\b[^|&;\\n]*?--all\\b').test(command);
      if (isAddAll || isCommitAll) {
        const others = liveOthersInTop(c.top, c.sid);
        const dirty = sh('git status --porcelain', c.cwd);
        if (others.length > 0 && dirty) {
          const names = others.map((o) => o.name || 'otra sesión').join(', ');
          process.stderr.write(
            `⛔ PZ Sessions: hay otra(s) sesión(es) trabajando en ESTE mismo directorio (${names}).\n` +
            `   "git add -A" / "commit -a" acá barre TAMBIÉN los cambios de ellos → commit enredado.\n` +
            `   Hacé una de estas:\n` +
            `     • Stageá sólo TUS archivos por nombre:  git add ruta/a/tu-archivo  (y luego git commit)\n` +
            `     • O aislate y subí limpio:  pz isolate <tarea>   (mueve tu trabajo a un worktree propio)\n`);
          process.exit(2);
        }
      }
      process.exit(0);
    }
    process.exit(0);
  } catch { process.exit(0); } // fail-open
}

// ─── leave (hook SessionEnd) ─ libera claims + saca a la sesión de la sala ──
if (cmd === 'leave') {
  try {
    const c = ctx(hookInput());
    const n = releaseClaims(c.sid);
    mutate(SESSIONS, {}, (all) => { if (!all[c.sid]) return null; delete all[c.sid]; return all; });
    if (process.stdout.isTTY) console.log(`✓ Saliste de la sala. Solté ${n} archivo(s) tomado(s).`);
  } catch {}
  process.exit(0);
}

// ─── inbox (hooks PostToolUse / UserPromptSubmit) ─ entrega a Claude los mensajes
// nuevos de la sala mientras trabaja, sin que tenga que pedirlos. Silencioso si no hay nada.
if (cmd === 'inbox') {
  try {
    const hook = hookInput();
    const cwd0 = (hook && hook.cwd) || process.cwd();
    if (!maybePz(cwd0)) process.exit(0);
    const c = ctx(hook);
    if (!inPzRepo(c.cwd)) process.exit(0);
    const me = heartbeat(c, {}, hook);
    const chat = readJSON(CHAT, []);
    if (!chat.length) process.exit(0);
    const seen = new Date(me.chatSeen || me.startedAt).getTime();
    const news = chat.filter((m) => new Date(m.ts).getTime() > seen && m.from !== me.name);
    if (!news.length) process.exit(0);
    markChatSeen(c.sid, chat[chat.length - 1].ts);
    const fmt = (m) => fmtMsg(m, me.name);
    const forMe = news.filter((m) => m.to && m.to === me.name);
    const text = `📨 Sala PZ — ${news.length} mensaje(s) nuevo(s) mientras trabajás:\n`
      + news.slice(-10).map(fmt).join('\n')
      + (forMe.length
        ? `\n⏳ ${forMe.length} te lo escribieron A VOS y esperan respuesta: pz say note --to "${forMe[forMe.length - 1].from}" "..."`
        : `\n(Si te afecta o te preguntan algo, respondé: pz say note "...". Si no, seguí con lo tuyo.)`);
    if ((hook.hook_event_name || '') === 'PostToolUse') {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
    } else {
      console.log(text); // UserPromptSubmit: el stdout se inyecta al contexto
    }
  } catch {}
  process.exit(0);
}

// ─── ask ─ pregunta a la sala; con --wait se queda esperando la respuesta ──────
if (cmd === 'ask') {
  const c = ctx({});
  const name = myName(c);
  if (!name) { console.error('Primero presentate: pz join "<nombre>"'); process.exit(1); }
  heartbeat(c);
  // --to <agente>: la pregunta es para OTRA sesión, no para el humano. Sin --to,
  // un ask es una interrupción al humano (le suena el teléfono) — que es lo que debe ser.
  const to = takeFlag(rest, '--to');
  const wait = rest.includes('--wait');
  const ti = rest.indexOf('--timeout');
  const timeoutS = ti >= 0 ? Math.max(10, parseInt(rest[ti + 1], 10) || 90) : 90;
  const text = rest.filter((r, i) => r !== '--wait' && r !== '--timeout' && !(ti >= 0 && i === ti + 1))[0];
  if (!text) { console.error('Falta la pregunta. Ej: pz ask --wait "¿priorizo A o B?"'); process.exit(1); }
  post({ from: name, type: 'ask', text, branch: c.branch, to });
  const dest = to ? `para ${to}` : `para ${CFG.owner || 'el humano'} (le llega al teléfono)`;
  if (!wait) { console.log(`❓ [${name}] pregunta posteada ${dest}.`); process.exit(0); }
  console.log(`❓ Pregunta posteada ${dest}. Espero respuesta hasta ${timeoutS}s… (con --timeout N esperás más; ojo el timeout del Bash tool)`);
  const since = Date.now();
  while (Date.now() - since < timeoutS * 1000) {
    sleep(4000);
    heartbeat(c);
    const chat = readJSON(CHAT, []);
    const live = new Set(Object.values(loadSessions()).map((s) => s.name).filter(Boolean));
    // respuesta = mensaje posterior de OTRO autor que me menciona, o de alguien
    // que no es una sesión viva (o sea: el usuario escribiendo en el tablero)
    const replies = chat.filter((m) => new Date(m.ts).getTime() > since && m.from !== name)
      .filter((m) => m.to === name || m.text.toLowerCase().includes(name.toLowerCase()) || !live.has(m.from));
    if (replies.length) {
      markChatSeen(c.sid, chat[chat.length - 1].ts);
      console.log('💬 Respuesta(s):');
      for (const m of replies) console.log(`  [${m.from}] ${m.text}`);
      process.exit(0);
    }
  }
  console.log(`⏳ Sin respuesta en ${timeoutS}s. Decidí con tu mejor criterio y dejá constancia: pz say note "decidí X porque Y".`);
  process.exit(0);
}

if (cmd === 'join') {
  const c = ctx({});
  const name = rest[0];
  const what = rest.slice(1).join(' ').trim();
  if (!name) { console.error('Falta el nombre. Ej: pz join "Sinapsis" "armando la sala de chat"'); process.exit(1); }
  const me = heartbeat(c, { name, ...(what ? { label: what } : {}) });
  post({ from: name, type: 'join', text: what ? `me sumo — ${what}` : 'me sumo a la sala', branch: me.branch });
  const others = liveOthersInTop(me.top, c.sid);
  console.log(`✓ Sos "${name}"${me.branch ? ` en [${me.branch}]` : ''}${what ? ` — ${what}` : ''}`);
  if (isMainFolder(me.top)) {
    console.log(`⛔ Estás en la CARPETA PRINCIPAL: acá no se trabaja. Antes de editar, aislate:  pz isolate <tarea>`);
  } else if (others.length) {
    console.log(`⚠️  OJO: ${others.map((o) => o.name || 'otra sesión').join(', ')} ya está(n) en ESTE mismo directorio.`);
    console.log(`   Para no enredar commits, que una de las dos siga en una sesión nueva de la app (nace en su propio worktree).`);
  }
  process.exit(0);
}

if (cmd === 'say') {
  const c = ctx({});
  const name = myName(c);
  if (!name) { console.error('Primero presentate: pz join "<nombre>" "<qué hacés>"'); process.exit(1); }
  heartbeat(c);
  const to = takeFlag(rest, '--to');   // dirigido a un agente: le queda como turno pendiente
  const [type, text, files] = rest;
  if (!text) { console.error('Falta el texto. Ej: pz say claim "toco schedule" "main.js,styles.css"'); process.exit(1); }
  post({ from: name, type, text, files, branch: c.branch, to });
  console.log(`✓ [${name}]${to ? ` → ${to}` : ''} ${type}: ${text}`);
  process.exit(0);
}

if (cmd === 'claim') {
  const c = ctx({});
  const name = myName(c);
  if (!name) { console.error('Primero presentate: pz join "<nombre>"'); process.exit(1); }
  heartbeat(c);
  const files = rest.flatMap((r) => r.split(',')).map((s) => s.trim()).filter(Boolean);
  if (!files.length) { console.error('Decí qué archivos tomás. Ej: pz claim src/a.js src/b.css'); process.exit(1); }
  const taken = [];
  for (const f of files) {
    const abs = canon(path.resolve(c.cwd, f));
    const owner = ownerOf(abs, c.sid);
    if (owner) { console.log(`✗ ${f} ya lo tiene "${owner.name}"`); continue; }
    let isDir = false; try { isDir = fs.statSync(abs).isDirectory(); } catch {}
    setClaim(abs, c, { dir: isDir }); taken.push(isDir ? f.replace(/\/+$/, '') + '/' : f);
  }
  if (taken.length) { post({ from: name, type: 'claim', text: `tomo ${taken.length} archivo(s)/carpeta(s)`, files: taken, branch: c.branch }); console.log(`🔒 Tomaste: ${taken.join(', ')}`); }
  process.exit(0);
}

// ─── check ─ ¿puedo editar esto? Para agentes que NO tienen los hooks (a ellos
// nadie los frena: preguntan antes de editar). exit 2 = ocupado, igual que el guard.
if (cmd === 'check') {
  const c = ctx({});
  heartbeat(c);
  const files = rest.flatMap((r) => r.split(',')).map((s) => s.trim()).filter(Boolean);
  if (!files.length) { console.error('Decí qué archivos querés tocar. Ej: pz check src/a.js src/b.css'); process.exit(1); }
  let blocked = 0;
  for (const f of files) {
    const abs = canon(path.resolve(c.cwd, f));
    const owner = ownerOf(abs, c.sid);
    if (owner) {
      blocked++;
      console.log(`⛔ ${f} — lo tiene "${owner.name}"` + (owner.dir ? ` (tomó la carpeta ${path.basename(owner.dirPath || '')}/)` : ''));
    } else console.log(`✓ ${f} — libre`);
  }
  if (blocked) {
    console.log('\nNo lo edites: coordiná por chat (pz say ask "…"), esperá a que lo suelte,');
    console.log('o aislate en tu propia copia (pz isolate <tarea>).');
  }
  process.exit(blocked ? 2 : 0);
}

if (cmd === 'release') {
  const c = ctx({});
  const files = rest.flatMap((r) => r.split(',')).map((s) => s.trim()).filter(Boolean)
    .map((f) => canon(path.resolve(c.cwd, f)));
  const n = releaseClaims(c.sid, files.length ? files : null);
  console.log(`🔓 Solté ${n} archivo(s).`);
  process.exit(0);
}

// ─── isolate ─ worktree propio off origin/<main>, para quien arrancó en la carpeta principal.
// NUNCA usa git stash: el stash es de todo el repo (no de la sesión) y dos veces se llevó
// trabajo ajeno (2026-08-21 "Informe del Operador"; 2026-09-08, que además se borró con el
// worktree). --carry ahora COPIA sólo los archivos que la sesión nombra y no toca los originales.
if (cmd === 'isolate') {
  const c = ctx({});
  if (!inPzRepo(c.cwd)) { console.error(`No estás dentro del repo configurado (${MAIN_REPO || 'sin configurar'}); no hay de qué aislarse.`); process.exit(1); }
  // La app ya le da a cada sesión su propio worktree: aislarse sólo tiene sentido desde la
  // carpeta principal, o desde una carpeta que otra sesión viva está usando a la vez.
  const shared = liveOthersInTop(c.top, c.sid);
  if (!isMainFolder(c.top) && !shared.length) {
    console.log(`✓ Ya estás en tu propio worktree (${c.top}${c.branch ? `, rama ${c.branch}` : ''}): no hace falta aislarte.`);
    console.log('  Trabajá acá y subí con PR. pz isolate es sólo para sesiones que arrancan en la carpeta principal.');
    process.exit(0);
  }
  const ci = rest.indexOf('--carry');
  const carryArgs = ci >= 0 ? rest.slice(ci + 1).flatMap((r) => r.split(',')).map((s) => s.trim()).filter(Boolean) : [];
  if (ci >= 0 && !carryArgs.length) {
    console.error('✗ --carry necesita la lista de TUS archivos: pz isolate <tarea> --carry src/a.js src/b.css');
    console.error('  Se copian a tu worktree nuevo y los originales quedan donde estaban. Nunca se lleva "todo lo sucio":');
    console.error('  en esta carpeta hay cambios que no son tuyos.');
    process.exit(1);
  }
  // validar ANTES de crear nada: cada archivo tiene que existir y estar dentro de esta carpeta
  const carry = [], bad = [];
  for (const f of carryArgs) {
    const abs = canon(path.resolve(c.cwd, f));
    const rel = path.relative(c.top, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) bad.push(`${f} (está fuera de ${c.top})`);
    else if (!fs.existsSync(abs)) bad.push(`${f} (no existe acá; si lo borraste vos, borralo también en tu worktree nuevo)`);
    else carry.push({ abs, rel });
  }
  if (bad.length) { console.error('✗ No aislé nada. Revisá estos archivos de --carry:\n' + bad.map((b) => '  · ' + b).join('\n')); process.exit(1); }
  const slugArg = (ci >= 0 ? rest.slice(0, ci) : rest)[0];
  const slug = (slugArg || (c.branch && c.branch !== 'HEAD' ? c.branch.replace(/[^a-zA-Z0-9]+/g, '-') : 'tarea') + '-' + String(now()).slice(-5))
    .replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const target = `/tmp/pz-${slug}`;
  const newBranch = `pz/${slug}`;
  if (fs.existsSync(target)) { console.error(`Ya existe ${target}. Elegí otro slug: pz isolate <slug>`); process.exit(1); }

  console.log(`→ Aislando en worktree propio (off origin/${MAIN_BRANCH})… (esta carpeta no se toca)`);
  sh(`git fetch origin ${MAIN_BRANCH}`, c.cwd);
  const add = sh(`git worktree add -b ${newBranch} "${target}" origin/${MAIN_BRANCH}`, c.cwd);
  if (!fs.existsSync(target)) { console.error(`No se pudo crear el worktree. ${add}`); process.exit(1); }
  for (const { abs, rel } of carry) {
    try { fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true }); fs.cpSync(abs, path.join(target, rel), { recursive: true }); console.log(`  · copié ${rel} (el original queda donde estaba)`); }
    catch (e) { console.log(`  · ✗ no pude copiar ${rel}: ${(e && e.message) || e}`); }
  }
  // node_modules para que servers/tools corran en el worktree
  const nm = path.join(MAIN_REPO, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(path.join(target, 'node_modules'))) { try { fs.symlinkSync(nm, path.join(target, 'node_modules')); console.log('  · node_modules symlinkeado'); } catch {} }
  // .env y similares (no versionados): sin esto el server no levanta en el worktree.
  // Los dirs extra (más allá de la raíz) se configuran con "envDirs" en pz.config.json.
  for (const sub of ENV_DIRS) {
    let names = [];
    try { names = fs.readdirSync(path.join(c.top, sub)).filter((n) => n.startsWith('.env')); } catch {}
    for (const n of names) {
      const src = path.join(c.top, sub, n), dst = path.join(target, sub, n);
      if (fs.existsSync(dst)) continue;
      try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); console.log(`  · copié ${path.join(sub, n)}`); } catch {}
    }
  }
  // mover mi identidad de sesión a la nueva carpeta (y que los hooks, que siguen
  // reportando la carpeta de arranque, no me muden de vuelta)
  heartbeat(c, { move: { cwd: target, top: canon(target), branch: newBranch }, isolatedTo: canon(target) });

  console.log(`\n✓ Worktree listo:  ${target}   [${newBranch}]`);
  console.log(`  Trabajá ahí (Edit/Write con rutas dentro de ${target}). Subí con PR a main y borralo al terminar:`);
  console.log(`    cd "${target}"`);
  console.log(`    # … editás, verificás …`);
  console.log(`    git push -u origin ${newBranch} && gh pr create --base ${MAIN_BRANCH} --fill && gh pr merge --squash --delete-branch`);
  console.log(`    git worktree remove "${target}"   # si se niega por cambios, NO uses --force: mirá antes qué son`);
  process.exit(0);
}

// ─── install / uninstall ─ cablea (o quita) los 5 hooks en ~/.claude/settings.json ──
// Es lo que hace que la herramienta no llegue "muerta" a quien la clone: el motor
// (frenos, presencia, inbox) vive en los hooks, no en esta carpeta.
if (cmd === 'install' || cmd === 'uninstall') {
  (async () => {
    const os = require('os');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const node = process.execPath;   // el node con el que corre esto (Apple Silicon vs Intel, nvm, etc.)
    const pzPath = __filename;        // este pz.js
    const dry = rest.includes('--dry-run');
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // shell-quote para comillas simples
    const command = (sub) => node + ' ' + q(pzPath) + ' ' + sub;
    const SPECS = [
      { event: 'SessionStart', sub: 'board --for-hook' },
      { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', sub: 'guard' },
      { event: 'PostToolUse', sub: 'inbox' },
      { event: 'UserPromptSubmit', sub: 'inbox' },
      { event: 'SessionEnd', sub: 'leave' },
    ];

    // install acepta la ruta del repo y, opcional, --owner "Nombre" (o lo pregunta)
    if (cmd === 'install') {
      const oi = rest.indexOf('--owner');
      const ownerArg = oi >= 0 ? rest[oi + 1] : null;                       // valor que sigue a --owner
      const repoArg = rest.filter((r, i) => !r.startsWith('--') && !(oi >= 0 && i === oi + 1))[0];
      if (repoArg) {
        const abs = path.resolve(repoArg.startsWith('~') ? path.join(os.homedir(), repoArg.slice(1)) : repoArg);
        if (!fs.existsSync(path.join(abs, '.git'))) console.log(`⚠️  ${abs} no parece un repo git (no encontré .git) — lo configuro igual.`);
        const conf = readJSON(CFG.configPath, {});
        conf.repo = abs; conf.mainBranch = conf.mainBranch || 'main'; conf.port = conf.port || 4646;
        // owner: por flag, o preguntando (solo si es terminal interactiva y no estaba seteado)
        if (ownerArg) conf.owner = ownerArg.trim();
        else if (!conf.owner && !dry && process.stdin.isTTY) {
          const rl = require('readline/promises').createInterface({ input: process.stdin, output: process.stdout });
          const ans = (await rl.question('¿Tu nombre? (para menciones "@vos" y firmar las respuestas de Telegram; Enter para omitir): ')).trim();
          rl.close();
          if (ans) conf.owner = ans;
        }
        if (typeof conf.owner !== 'string') conf.owner = ''; // dejá el campo presente aunque vacío (descubrible)
        if (!dry) writeJSON(CFG.configPath, conf);
        console.log(`${dry ? '[dry-run] ' : '✓ '}repo configurado: ${abs}${conf.owner ? `  ·  owner: ${conf.owner}` : ''}  →  ${CFG.configPath}`);
      } else if (!CFG.configured) {
        console.error('Falta la ruta del repo. Uso: pz install <ruta-al-repo> [--owner "Nombre"]'); process.exit(1);
      }
    }

    // leer settings.json con cuidado: si existe pero no parsea, ABORTAR (no pisar la config del usuario)
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
      catch { console.error(`No pude parsear ${settingsPath} (¿JSON inválido?). Aborto para no pisarlo.`); process.exit(1); }
    }
    settings.hooks = settings.hooks || {};
    const isMine = (entry) => JSON.stringify(entry).includes(pzPath); // nuestras entradas referencian este pz.js
    for (const spec of SPECS) {
      const kept = (settings.hooks[spec.event] || []).filter((e) => !isMine(e)); // idempotente: saca las nuestras viejas
      if (cmd === 'install') {
        const entry = { hooks: [{ type: 'command', command: command(spec.sub) }] };
        if (spec.matcher) entry.matcher = spec.matcher;
        kept.push(entry);
      }
      if (kept.length) settings.hooks[spec.event] = kept; else delete settings.hooks[spec.event];
    }

    if (dry) {
      console.log(`[dry-run] ${settingsPath} → hooks quedarían:`);
      console.log(JSON.stringify({ hooks: settings.hooks }, null, 2));
      process.exit(0);
    }
    try { if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + '.pz-bak'); } catch {}
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeJSON(settingsPath, settings);
    if (cmd === 'install') {
      console.log(`✓ Hooks instalados en ${settingsPath}  (backup: settings.json.pz-bak)`);
      console.log(`  Arrancá el tablero:  node ${q(CFG.serverScript)}   →  http://localhost:${CFG.port}`);
    } else {
      console.log(`✓ Hooks de PZ Sessions removidos de ${settingsPath}`);
    }
    process.exit(0);
  })().catch((e) => { console.error('install:', e && e.message); process.exit(1); });
  return; // el resto del archivo es sincrónico; cortamos acá para dejar correr el IIFE async
}

if (cmd === 'bitacora') {
  const bit = require('./bitacora');
  const date = rest.includes('--date') ? rest[rest.indexOf('--date') + 1] : null;
  const weekly = rest.includes('--weekly') || rest.includes('--last-week');
  const lastWeek = rest.includes('--last-week');
  const run = (jsonOnly) => weekly ? bit.generateWeekly({ date, jsonOnly, lastWeek }) : bit.generate({ date, jsonOnly });
  if (rest.includes('--json')) { console.log(JSON.stringify(run(true).data, null, 2)); process.exit(0); }
  console.log(`📖 Generando bitácora ${weekly ? 'SEMANAL' : (date ? `de ${date}` : 'de hoy')}… (la IA redacta, puede tardar un par de minutos)`);
  const r = run(false);
  if (r.empty) { console.log(`Sin actividad ${weekly ? 'esa semana' : 'ese día'} — no se generó bitácora.`); process.exit(0); }
  if (r.error) {
    console.error('✗ ' + r.error);
    // El nocturno corre bajo launchd y nadie lee ese log: que el fallo aparezca
    // en la sala (y por lo tanto en el hook de arranque de la próxima sesión).
    post({ from: 'Bitácora 📖', type: 'warn', text: `No se pudo generar la bitácora ${weekly ? 'SEMANAL' : (date || 'de hoy')}: ${r.error}` });
    process.exit(1);
  }
  console.log(weekly
    ? `✓ Bitácora semanal ${r.label}: ${r.prCount} PRs, ${r.sessionCount} sesiones → ${r.path}`
    : `✓ Bitácora ${r.date}: ${r.prCount} PRs, ${r.sessionCount} sesiones → ${r.path}`);
  process.exit(0);
}

// ─── debate ─ hilos de decisión: propuesta sellada, objeción con evidencia, cierre escrito
if (cmd === 'debate') {
  const c = ctx({});
  const name = myName(c);
  if (!name) { console.error('Primero presentate: pz join "<nombre>" "<qué hacés>"'); process.exit(1); }
  heartbeat(c);
  const D = require('./debate');
  const sinTercero = rest.includes('--sin-tercero');
  if (sinTercero) rest.splice(rest.indexOf('--sin-tercero'), 1);
  const criterio = takeFlag(rest, '--criterio', 300);
  const con = takeFlag(rest, '--con', 200);
  const evidencia = takeFlag(rest, '--evidencia', 2000);
  const decision = takeFlag(rest, '--decision', 2000);
  const abierto = takeFlag(rest, '--abierto', 2000);
  const [sub, a1, a2] = rest;
  // convocados por defecto: las sesiones vivas que se PRESENTARON (con nombre automático
  // todavía no dijeron qué hacen; el debate se quedaría esperando su propuesta)
  const live = Object.values(loadSessions()).filter((s) => s.name && !s.autoName).map((s) => s.name);
  const api = { me: name, live };
  (async () => {
    let r;
    if (sub === 'abrir') { console.log('… convocando a la tercera voz (modelo local), aguantá unos segundos'); r = await D.abrir(api, { tema: a1, criterio, con, sinTercero }); }
    else if (sub === 'proponer') r = await D.proponer(api, a1, a2);
    else if (sub === 'destapar') r = await D.destapar(api, a1);
    else if (sub === 'objetar') r = D.objetar(api, a1, a2, evidencia);
    else if (sub === 'ver' || sub === undefined) r = D.ver(api, a1);
    else if (sub === 'cerrar') r = D.cerrar(api, a1, decision, abierto);
    else r = { err: `No conozco "pz debate ${sub}". Son: abrir, proponer, destapar, objetar, ver, cerrar.` };
    if (r.err) { console.error('✗ ' + r.err); process.exit(1); }
    if (r.say) post({ from: name, type: r.tipo || 'note', text: r.say, branch: c.branch });
    if (r.out) console.log(r.out);
    process.exit(0);
  })().catch((e) => { console.error('✗ pz debate: ' + ((e && e.message) || e)); process.exit(1); });
  return;
}

// Latido sólo para sesiones de Claude reales dentro del repo: una terminal humana (sin
// CLAUDE_CODE_SESSION_ID) o una sesión de otro proyecto que mira el tablero no es parte
// de la sala y no tiene que aparecer en la lista.
function presence(c, hook) {
  if (String(c.sid).startsWith('env-') || !inPzRepo(c.cwd)) return readJSON(SESSIONS, {})[c.sid] || null;
  return heartbeat(c, {}, hook);
}

if (cmd === 'whoami') {
  const c = ctx({});
  const s = readJSON(SESSIONS, {})[c.sid];
  if (s && s.name) console.log(`${s.name}${s.branch ? ` [${s.branch}]` : ''}${s.label ? ` — ${s.label}` : ''}  ·  sid:${c.sid.slice(0, 8)}  ·  ${s.cwd || c.cwd}`
    + (s.autoName ? '\n(nombre automático — ponete uno con onda: pz join "<nombre>" "<qué hacés>")' : ''));
  else console.log(`Sin identidad. Presentate: pz join "<nombre>" "<qué hacés>"  ·  sid:${String(c.sid).slice(0, 8)}`);
  process.exit(0);
}

// ─── chat ─ sólo la sala. Para releerla sin recortar el tablero a mano: un recorte casero
// (`pz board | sed -n '1,12p;/Últimos mensajes/,$p'`) imprimía cada mensaje DOS veces
// cuando el tablero era corto — ese fue el "doble" que se vio el 30-sep.
if (cmd === 'chat') {
  const c = ctx({});
  const me = presence(c);
  const n = Math.max(1, Math.min(100, parseInt(rest[0], 10) || 10));
  const chat = readJSON(CHAT, []);
  if (!chat.length) { console.log('💬 La sala está vacía.'); process.exit(0); }
  console.log(`💬 Últimos ${Math.min(n, chat.length)} mensajes de la sala (del más viejo al más nuevo):`);
  for (const m of chat.slice(-n)) console.log('  ' + fmtMsg(m, me && me.name));
  if (me) markChatSeen(c.sid, chat[chat.length - 1].ts);
  process.exit(0);
}

if (cmd === 'board') {
  const forHook = rest.includes('--for-hook');
  const hook = forHook ? hookInput() : {};
  const c = ctx(hook);
  if (forHook && !inPzRepo(c.cwd)) process.exit(0); // hook silencioso fuera del repo configurado
  // presencia desde el arranque, con nombre automático (aunque la sesión nunca haga join)
  const me = (forHook ? heartbeat(c, {}, hook) : presence(c)) || { top: c.top, branch: c.branch };
  const here = me.top || c.top;           // dónde trabaja (si se aisló, su worktree nuevo)
  const atMain = isMainFolder(here);
  const resumed = forHook && hook.source === 'resume';

  let state;
  try { state = JSON.parse(sh(`curl -s http://localhost:${CFG.port}/api/state`)); } catch { state = null; }
  const rowOf = (top) => state && (state.sessions || []).find((w) => canon(w.path) === top);
  const out = [];
  const othersHere = liveOthersInTop(here, c.sid);
  const namesHere = othersHere.map((o) => o.name || 'otra sesión').join(', ');

  // ⛔⛔ Lo primero: ¿arrancó en la carpeta principal? Ahí no trabaja nadie — tiene
  // restos viejos preparados para commit que no son de nadie. Avisar, no tocar.
  if (atMain) {
    const total = sh('git status --porcelain', here).split('\n').filter(Boolean).length;
    const staged = sh('git diff --cached --name-only', here).split('\n').filter(Boolean).length;
    const behind = sh(`git rev-list --count HEAD..origin/${MAIN_BRANCH}`, here);
    out.push('⛔⛔ ESTÁS EN LA CARPETA PRINCIPAL DEL REPO — ACÁ NO TRABAJA NADIE.');
    out.push(`   ${here}`);
    if (total) out.push(`   Tiene ${total} archivo(s) con cambios sin commitear${staged ? ` (${staged} ya preparados para commit)` : ''} que NO son tuyos: son restos viejos o de otras sesiones.`);
    if (+behind > 0) out.push(`   Además está ${behind} commits atrás de prod: lo que ves acá puede ser código viejo.`);
    if (othersHere.length) out.push(`   Y ahora mismo también hay otra(s) sesión(es) acá: ${namesHere}.`);
    out.push('   No edites, no commitees y no "limpies" nada acá: nada de add, commit, checkout, reset, stash ni merge.');
    out.push('   → Si vas a tocar código, ANTES aislate en tu propia copia, en UN comando:');
    out.push('       node "' + PZ_SCRIPT + '" isolate <tarea>');
    out.push('     (nace fresca de prod y sin esos restos; trabajás ahí y subís con PR)');
    out.push('   → Si sólo vas a leer o investigar podés quedarte, pero sin escribir nada.');
    out.push('');
  } else if (othersHere.length) {
    // carpeta compartida que NO es la principal (raro: la app le da a cada sesión la suya)
    out.push('⛔ OTRA SESIÓN ESTÁ EN ESTE MISMO DIRECTORIO: ' + namesHere);
    out.push('   Trabajar los dos acá enreda los commits (un `git add -A` barre el trabajo del otro).');
    out.push('   → Que una de las dos siga en una sesión nueva de la app (nace en su propio worktree).');
    out.push('   Mientras tanto el sistema frena `git add -A`/`commit -a` y editar archivos que la otra tomó.');
    out.push('');
  }

  // ⏳ ¿Me hablaron a MÍ y todavía no contesté? (lo que se dirige a un agente no
  // interrumpe al humano, así que el recordatorio tiene que estar acá.)
  const chatAll = readJSON(CHAT, []);
  const meName = me.name || null;
  if (meName) {
    const lastMine = [...chatAll].reverse().find((m) => m.from === meName);
    const sinceMine = lastMine ? new Date(lastMine.ts).getTime() : 0;
    const pending = chatAll.filter((m) => m.to === meName && new Date(m.ts).getTime() > sinceMine);
    if (pending.length) {
      out.push(`⏳ TE HABLARON A VOS y no contestaste (${pending.length}):`);
      for (const m of pending.slice(-3)) out.push(`  • ${m.from}: ${m.text.slice(0, 120)}`);
      out.push(`   Contestá: pz say note --to "${pending[pending.length - 1].from}" "..."`);
      out.push('');
    }
  }

  // 🦴 ¿Este worktree es un museo? Avisar ANTES de que la sesión saque conclusiones
  // de código fósil (fetch condicional adentro; fail-open si no hay red/remoto).
  // En la carpeta principal no: ya lo dijo arriba, y ahí NO se actualiza nada.
  const stale = atMain ? null : require('./staleness').measure(here, { fetch: true });
  if (stale && stale.level) {
    const offline = stale.fetchFailed ? ' (no pude contactar GitHub — comparo contra la última copia local de prod)' : '';
    if (stale.level === 'red') {
      out.push(`⛔ WORKTREE-MUSEO: estás ${stale.behind} commits detrás de prod (origin/${MAIN_BRANCH}); el último commit de acá es de hace ${stale.ageDays} días${offline}.`);
      out.push('   Lo que ves en este directorio NO es el código de producción — no saques conclusiones ni edites sin actualizar.');
      out.push('   → ¿Necesitás ESTE worktree sí o sí?: git fetch origin && git merge origin/' + MAIN_BRANCH);
      out.push('   → ¿Es trabajo nuevo? Mejor una sesión nueva de la app: nace fresca de prod.');
    } else {
      out.push(`⚠️  Este worktree está ${stale.behind} commits / ${stale.ageDays} días detrás de prod (origin/${MAIN_BRANCH})${offline} — si vas a editar, primero actualizalo (git merge origin/${MAIN_BRANCH}).`);
    }
    out.push('');
  }

  // 🎛️ Las SESIONES (no las carpetas): toda sesión que arrancó en el repo, con su nombre.
  const allS = readJSON(SESSIONS, {});
  const isLive = (s) => !!fresh(s.lastSeen, SESSION_TTL_MS);
  const room = Object.values(allS)
    .filter((s) => s.sessionId !== c.sid && s.inRepo !== false && fresh(s.lastSeen, SESSION_KEEP_MS))
    .sort((a, b) => (isLive(b) - isLive(a)) || (new Date(b.lastSeen) - new Date(a.lastSeen)));
  const ago = (iso) => { const m = Math.round((now() - new Date(iso).getTime()) / 60000); return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`; };
  out.push('🎛️  PZ Sessions — las otras sesiones de la sala:');
  if (!room.length) out.push('  (ninguna otra sesión abierta)');
  for (const s of room) {
    const w = rowOf(s.top);
    const bits = [];
    if (isMainFolder(s.top)) bits.push('⛔ en la CARPETA PRINCIPAL');
    if (w && w.dirtyCount) bits.push(`${w.dirtyCount} sin guardar`);
    if (w && w.colliding) bits.push('⚠️ colisión');
    if (!isLive(s)) bits.push(`en pausa (sin actividad hace ${ago(s.lastSeen)})`);
    out.push(`  • ${s.name || 'sesión sin nombre'} [${s.branch || 'detached'}] — ${s.label || (s.autoName ? 'todavía no dijo qué hace' : '')}` + (bits.length ? ' · ' + bits.join(' · ') : ''));
  }
  if (state) {
    // carpetas con trabajo en curso donde no hay ninguna sesión abierta (ni en pausa)
    const withSession = new Set(Object.values(allS).filter((s) => fresh(s.lastSeen, SESSION_KEEP_MS)).map((s) => s.top));
    const orphan = (state.sessions || []).filter((w) => w.isActive && !withSession.has(canon(w.path)) && canon(w.path) !== here);
    if (orphan.length) {
      out.push('📂 Carpetas con trabajo y sin sesión abierta:');
      for (const w of orphan) out.push(`  • ${isMainFolder(canon(w.path)) ? 'carpeta principal' : w.name} [${w.branch || 'detached'}] — ${w.lastSubject || ''}`
        + (w.dirtyCount ? ` · ${w.dirtyCount} sin guardar` : '') + (w.stagedCount ? ` · ${w.stagedCount} en cola p/commit` : '') + (w.colliding ? ' · ⚠️ colisión' : ''));
    }
    const sharedDirs = (state.sharedDirs || []);
    if (sharedDirs.length) {
      out.push('⛔ Directorios con 2+ sesiones de Claude a la vez (riesgo de commit enredado):');
      for (const d of sharedDirs.slice(0, 6)) out.push(`  • ${d.branch || d.path} → ${d.names.join(', ')}`);
    }
    if (state.collisions && state.collisions.length) {
      out.push('⚠️  Archivos que 2+ sesiones tocan a la vez:');
      for (const cc of state.collisions.slice(0, 8)) out.push(`  • ${cc.file} → ${cc.owners.join(', ')}`);
    }
  } else if (!forHook) out.push(`(el tablero no está corriendo en :${CFG.port} — no puedo mostrar carpetas ni choques)`);

  // 💬 La sala, cada mensaje UNA vez y con su destinatario. Al retomar una sesión, sólo
  // lo que no vio (lo anterior ya lo tiene en su conversación).
  const seenAt = resumed && me.chatSeen ? new Date(me.chatSeen).getTime() : null;
  const chatShow = seenAt !== null
    ? chatAll.filter((m) => new Date(m.ts).getTime() > seenAt && m.from !== meName).slice(-10)
    : chatAll.slice(-6);
  if (seenAt !== null) out.push(chatShow.length ? `💬 Mensajes nuevos de la sala desde que dejaste esta sesión (${chatShow.length}):` : '💬 Sala: nada nuevo desde que dejaste esta sesión.');
  else if (chatShow.length) out.push('💬 Últimos mensajes de la sala:');
  for (const m of chatShow) out.push('  ' + fmtMsg(m, meName));

  if (forHook) {
    out.push('');
    out.push('▶ PROTOCOLO (esta sesión, seguilo):');
    out.push('  CLI: node "' + PZ_SCRIPT + '" <cmd>');
    // aislarse SÓLO desde la carpeta principal: la app ya le da a cada sesión su worktree
    if (atMain) out.push('  0) Estás en la CARPETA PRINCIPAL (ver arriba) → antes de editar: pz isolate <tarea>. Acá no se commitea nada.');
    else if (othersHere.length) out.push('  0) Compartís carpeta con otra sesión (ver arriba) → coordiná por la sala antes de editar.');
    else out.push('  0) Ya estás en tu propio worktree: trabajá acá, no hace falta aislarte.');
    if (me.autoName) out.push(`  1) Ya te anoté en la sala como «${me.name}». Al saber tu tarea → pz join "<nombre con onda>" "<qué hacés>"`);
    else out.push(`  1) Estás en la sala como «${me.name}». Si cambió tu tarea → pz join "${me.name}" "<qué hacés ahora>"`);
    out.push('  2) Tomá lo que vas a tocar → pz claim <archivos o carpetas>   (el sistema frena a quien intente pisarlos)');
    out.push('  3) ¿Duda que sólo el usuario puede resolver? → pz ask --wait "<pregunta>" [--timeout 300] (espera la respuesta del chat; ajustá el timeout del Bash tool acorde)');
    out.push('     ¿Es para OTRO agente, no para el usuario? → agregá --to "<agente>" y no le suena el teléfono a nadie');
    out.push('  3b) ¿Decisión de fondo sin número que la resuelva (arquitectura, prioridades)? → pz debate abrir "<tema>" --criterio "<cómo decidimos>"');
    out.push('      Cada uno propone A CIEGAS (pz debate proponer <id>), se destapan juntas, se objeta CON evidencia y se cierra con decisión escrita.');
    out.push('  4) Al terminar → pz say done "<resultado / PR #>"');
    out.push('  Los mensajes nuevos de la sala te llegan solos mientras trabajás (hook inbox). Para releerla: pz chat [N] (no recortes el tablero a mano).');
    out.push('  Tablero + chat (para el usuario): http://localhost:' + CFG.port);
  }
  // lo que el board ya mostró cuenta como leído (que el inbox no lo repita)
  if (chatAll.length && me.sessionId) markChatSeen(c.sid, chatAll[chatAll.length - 1].ts);
  console.log(out.join('\n'));
  process.exit(0);
}

console.log(`pz — Sala de Sesiones${REPO_NAME ? ' · ' + REPO_NAME : ' (sin repo configurado — corré: pz install <ruta-al-repo>)'}
  pz join "<nombre>" "<qué hacés>"      presentarse (elegí un nombre con onda)
  pz say <claim|done|warn|ask|note> "<texto>" ["files"]   (--to "<agente>" para dirigirlo)
  pz ask [--to "<agente>"] [--wait] [--timeout N] "<pregunta>"
                                        sin --to la pregunta es para el humano y le suena el teléfono;
                                        con --to queda entre agentes y no lo molesta
  pz claim <archivos|carpetas...>       tomar (otras sesiones no podrán editarlos; carpeta = todo adentro)
  pz check <archivos...>                ¿están libres? (exit 2 si no) — para agentes sin hooks
  pz release [archivos...]              soltarlos
  pz debate abrir "<tema>" [--criterio "<cómo decidimos>"] [--con "A,B"] [--sin-tercero]
                                        convoca sola a una tercera voz: un modelo LOCAL de otra
                                        familia, que propone a ciegas y después arbitra
  pz debate proponer <id> "<propuesta>"   SELLADA: nadie la ve hasta que estén todas
  pz debate objetar <id> "<objeción>" [--evidencia "<comando + salida>"]
  pz debate ver [<id>]  ·  destapar <id>  ·  cerrar <id> --decision "…" [--abierto "<desacuerdo>"]
                                        el cierre escribe la decisión en el vault; si algo queda
                                        abierto, ESO sí se le escala al humano
  pz isolate [<slug>] [--carry <tus archivos>]
                                        SÓLO si arrancaste en la carpeta principal: worktree propio off main
                                        (lleva .env y node_modules; --carry COPIA los archivos que nombres)
  pz board                              ver las otras sesiones + carpetas + chat
  pz chat [N]                           sólo los últimos N mensajes de la sala (10 por defecto)
  pz bitacora [--date D] [--weekly] [--json]   generar bitácora diaria o semanal (2 capas) → Obsidian + tablero
  pz whoami
  pz install [<ruta-al-repo>] [--owner "Nombre"] [--dry-run]   configurar repo (+ pregunta tu nombre) y cablear los hooks
  pz uninstall [--dry-run]              quitar los hooks de PZ Sessions`);
