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
 *   pz isolate [<slug>] [--carry]         crear tu propio worktree off main y mudarte ahí
 *   pz board [--for-hook]                 ver sesiones + colisiones + chat
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
const REGISTRY = path.join(DIR, 'registry.json'); // legacy: labels por branch/cwd (el server lo lee de fallback)
const MAIN_REPO = CFG.repo;                       // repo cuyos worktrees se orquestan
const MAIN_BRANCH = CFG.mainBranch;               // rama principal (isolate parte de origin/<MAIN_BRANCH>)
const REPO_NAME = CFG.repoName;                   // basename — para el descarte rápido del guard
const PZ_SCRIPT = CFG.pzScript;                   // ruta a este pz.js — para los mensajes del board (sin hardcodear)
const ENV_DIRS = CFG.envDirs;                     // dirs cuyos .env* copia `pz isolate` al worktree nuevo

const SESSION_TTL_MS = 30 * 60 * 1000;     // una sesión se considera viva 30' tras su último latido
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

function loadSessions() {
  return mutate(SESSIONS, {}, (all) => {
    let changed = false;
    for (const k of Object.keys(all)) if (!fresh(all[k].lastSeen, SESSION_TTL_MS)) { delete all[k]; changed = true; }
    return changed ? all : null;
  });
}
// upsert + latido. patch puede traer name/label.
function heartbeat(c, patch = {}) {
  return mutate(SESSIONS, {}, (all) => {
  const prev = all[c.sid] || {};
  all[c.sid] = {
    ...prev, // preserva campos extra (chatSeen, etc.)
    sessionId: c.sid,
    name: patch.name || prev.name || null,
    label: patch.label !== undefined ? patch.label : (prev.label || null),
    cwd: c.cwd, top: c.top, branch: c.branch,
    startedAt: prev.startedAt || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  // prune stale de paso
  for (const k of Object.keys(all)) if (k !== c.sid && !fresh(all[k].lastSeen, SESSION_TTL_MS)) delete all[k];
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
function markChatSeen(sid, ts) {
  mutate(SESSIONS, {}, (all) => {
    if (!all[sid]) return null;
    all[sid].chatSeen = ts;
    return all;
  });
}
const sleep = napMs;
// legacy: el server lee labels de registry.json por branch/cwd como fallback
function saveLegacyLabel(c, patch) {
  mutate(REGISTRY, {}, (reg) => {
    const entry = { ...(reg[c.branch] || {}), ...patch, branch: c.branch, cwd: c.cwd, updatedAt: new Date().toISOString() };
    if (c.branch && c.branch !== 'HEAD') reg[c.branch] = entry;
    reg[c.cwd] = entry;
    return reg;
  });
}

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
    heartbeat(c);                            // latido (así otras sesiones me "ven" acá)

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
    const me = heartbeat(c);
    const chat = readJSON(CHAT, []);
    if (!chat.length) process.exit(0);
    const seen = new Date(me.chatSeen || me.startedAt).getTime();
    const news = chat.filter((m) => new Date(m.ts).getTime() > seen && m.from !== me.name);
    if (!news.length) process.exit(0);
    markChatSeen(c.sid, chat[chat.length - 1].ts);
    const fmt = (m) => `[${new Date(m.ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}] ${m.from}${m.to ? ` → ${m.to === me.name ? 'VOS' : m.to}` : ''} (${m.type}): ${m.text}`;
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
  heartbeat(c, { name, ...(what ? { label: what } : {}) });
  saveLegacyLabel(c, { sessionName: name, ...(what ? { label: what } : {}) });
  post({ from: name, type: 'join', text: what ? `me sumo — ${what}` : 'me sumo a la sala', branch: c.branch });
  const others = liveOthersInTop(c.top, c.sid);
  console.log(`✓ Sos "${name}"${c.branch ? ` en [${c.branch}]` : ''}${what ? ` — ${what}` : ''}`);
  if (others.length) {
    console.log(`⚠️  OJO: ${others.map((o) => o.name || 'otra sesión').join(', ')} ya está(n) en ESTE mismo directorio.`);
    console.log(`   Para no enredar commits, aislate:  pz isolate <tarea>`);
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

if (cmd === 'isolate') {
  const c = ctx({});
  if (!inPzRepo(c.cwd)) { console.error(`No estás dentro del repo configurado (${MAIN_REPO || 'sin configurar'}); no hay de qué aislarse.`); process.exit(1); }
  const carry = rest.includes('--carry');
  const slugArg = rest.filter((r) => r !== '--carry')[0];
  const slug = (slugArg || (c.branch && c.branch !== 'HEAD' ? c.branch.replace(/[^a-zA-Z0-9]+/g, '-') : 'tarea') + '-' + String(now()).slice(-5))
    .replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const target = `/tmp/pz-${slug}`;
  const newBranch = `pz/${slug}`;
  if (fs.existsSync(target)) { console.error(`Ya existe ${target}. Elegí otro slug: pz isolate <slug>`); process.exit(1); }

  console.log(`→ Aislando en worktree propio (off origin/${MAIN_BRANCH})…`);
  sh(`git fetch origin ${MAIN_BRANCH}`, c.cwd);
  let stashed = false;
  if (carry && sh('git status --porcelain', c.cwd)) {
    const r = sh('git stash push -u -m pz-isolate', c.cwd);
    stashed = !/No local changes/.test(r) && !!sh('git stash list', c.cwd);
    if (stashed) console.log('  · guardé tus cambios sin commitear (stash) para mudarlos');
  }
  const add = sh(`git worktree add -b ${newBranch} "${target}" origin/${MAIN_BRANCH}`, c.cwd);
  if (!fs.existsSync(target)) { console.error(`No se pudo crear el worktree. ${add}`); if (stashed) sh('git stash pop', c.cwd); process.exit(1); }
  if (stashed) { const pop = sh('git stash pop', target); console.log('  · ' + (/conflict/i.test(pop) ? 'CONFLICTO al mudar cambios — resolvé a mano en el worktree' : 'cambios mudados al worktree')); }
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
  // mover mi identidad de sesión a la nueva carpeta
  heartbeat({ sid: c.sid, cwd: target, top: canon(target), branch: newBranch }, { name: myName(c) });

  console.log(`\n✓ Worktree listo:  ${target}   [${newBranch}]`);
  console.log(`  Trabajá ahí (Edit/Write con rutas dentro de ${target}). Subí con PR a main y borralo al terminar:`);
  console.log(`    cd "${target}"`);
  console.log(`    # … editás, verificás …`);
  console.log(`    git push -u origin ${newBranch} && gh pr create --base ${MAIN_BRANCH} --fill && gh pr merge --squash --delete-branch`);
  console.log(`    git worktree remove "${target}"`);
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
  if (r.error) { console.error('✗ ' + r.error); process.exit(1); }
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
  const live = Object.values(loadSessions()).map((s) => s.name).filter(Boolean);
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

if (cmd === 'whoami') {
  const c = ctx({});
  const s = readJSON(SESSIONS, {})[c.sid];
  if (s && s.name) console.log(`${s.name}${c.branch ? ` [${c.branch}]` : ''}${s.label ? ` — ${s.label}` : ''}  ·  sid:${c.sid.slice(0, 8)}  ·  ${c.cwd}`);
  else console.log(`Sin identidad. Presentate: pz join "<nombre>" "<qué hacés>"  ·  sid:${String(c.sid).slice(0, 8)}`);
  process.exit(0);
}

if (cmd === 'board') {
  const forHook = rest.includes('--for-hook');
  const c = ctx(forHook ? hookInput() : {});
  if (forHook && !inPzRepo(c.cwd)) process.exit(0); // hook silencioso fuera del repo configurado
  heartbeat(c); // presencia desde el arranque (aunque la sesión todavía no se haya "join"eado)

  let state;
  try { state = JSON.parse(sh(`curl -s http://localhost:${CFG.port}/api/state`)); } catch { state = null; }

  const out = [];
  // ⛔ Lo más importante: ¿hay OTRA sesión viva en MI mismo directorio? → aislate.
  const othersHere = liveOthersInTop(c.top, c.sid);
  const namedHere = othersHere.filter((o) => o.name);
  if (namedHere.length) {
    out.push('⛔ OTRA SESIÓN ESTÁ EN ESTE MISMO DIRECTORIO: ' + namedHere.map((o) => o.name).join(', '));
    out.push('   Trabajar los dos acá enreda los commits (un `git add -A` barre el trabajo del otro).');
    out.push('   → Aislate en tu propia copia, en UN comando:');
    out.push('       node "' + PZ_SCRIPT + '" isolate <tarea>');
    out.push('     (crea un worktree off main en /tmp, te lo deja listo, y subís con PR → main)');
    out.push('   Si te quedás acá igual: el sistema te frena `git add -A`/`commit -a` y editar archivos que otra sesión tomó.');
    out.push('');
  } else if (othersHere.length) {
    out.push(`ℹ️  Hay ${othersHere.length} sesión(es) recién abierta(s) (sin presentarse) en este directorio — si empiezan a trabajar acá, aislate con pz isolate.`);
    out.push('');
  }

  // ⏳ ¿Me hablaron a MÍ y todavía no contesté? (lo que se dirige a un agente no
  // interrumpe al humano, así que el recordatorio tiene que estar acá.)
  const meName = myName(c);
  if (meName) {
    const chatAll = readJSON(CHAT, []);
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
  const stale = require('./staleness').measure(c.top, { fetch: true });
  if (stale && stale.level) {
    const offline = stale.fetchFailed ? ' (no pude contactar GitHub — comparo contra la última copia local de prod)' : '';
    if (stale.level === 'red') {
      out.push(`⛔ WORKTREE-MUSEO: estás ${stale.behind} commits detrás de prod (origin/${MAIN_BRANCH}); el último commit de acá es de hace ${stale.ageDays} días${offline}.`);
      out.push('   Lo que ves en este directorio NO es el código de producción — no saques conclusiones ni edites sin actualizar.');
      out.push('   → Trabajo nuevo: node "' + PZ_SCRIPT + '" isolate <tarea>   (nace fresco de prod)');
      out.push('   → ¿Necesitás ESTE worktree sí o sí?: git fetch origin && git merge origin/' + MAIN_BRANCH);
    } else {
      out.push(`⚠️  Este worktree está ${stale.behind} commits / ${stale.ageDays} días detrás de prod (origin/${MAIN_BRANCH})${offline} — si vas a editar, primero actualizalo (git merge origin/${MAIN_BRANCH}) o aislate fresco (pz isolate).`);
    }
    out.push('');
  }

  if (!state) { if (!forHook) console.log(out.concat('(PZ Sessions no está corriendo en :' + CFG.port + ')').join('\n')); else if (out.length) console.log(out.join('\n')); process.exit(0); }

  const active = state.sessions.filter((s) => s.isActive && s.path !== c.top);
  out.push('🎛️  PZ Sessions — otras sesiones activas ahora:');
  if (!active.length) out.push('  (ninguna otra sesión activa)');
  for (const s of active) {
    const who = s.sessionName || s.name;
    const live = (s.liveSessions && s.liveSessions.length) ? ` · 👤${s.liveSessions.length} sesión(es)` : '';
    out.push(`  • ${who} [${s.branch || 'detached'}] — ${s.label || s.lastSubject || ''}` +
      (s.dirtyCount ? ` · ${s.dirtyCount} sin guardar` : '') + (s.stagedCount ? ` · ${s.stagedCount} en cola p/commit` : '') + live + (s.colliding ? ' · ⚠️ colisión' : ''));
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
  const chat = (state.chat || []).slice(-6);
  if (chat.length) {
    out.push('💬 Últimos mensajes de la sala:');
    for (const m of chat) {
      const t = new Date(m.ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      out.push(`  [${t}] ${m.from} (${m.type}): ${m.text}`);
    }
  }
  if (forHook) {
    out.push('');
    out.push('▶ PROTOCOLO (esta sesión, seguilo):');
    out.push('  CLI: node "' + PZ_SCRIPT + '" <cmd>');
    out.push('  1) Si arriba dice que OTRA sesión está en tu mismo dir → `pz isolate <tarea>` (aislate antes de editar)');
    out.push('  2) Al saber tu tarea → pz join "<nombre con onda>" "<qué hacés>"');
    out.push('  3) Tomá lo que vas a tocar → pz claim <archivos o carpetas>   (el sistema frena a quien intente pisarlos)');
    out.push('  4) ¿Duda que sólo el usuario puede resolver? → pz ask --wait "<pregunta>" [--timeout 300] (espera la respuesta del chat; ajustá el timeout del Bash tool acorde)');
    out.push('     ¿Es para OTRO agente, no para el usuario? → agregá --to "<agente>" y no le suena el teléfono a nadie');
    out.push('  4b) ¿Decisión de fondo sin número que la resuelva (arquitectura, prioridades)? → pz debate abrir "<tema>" --criterio "<cómo decidimos>"');
    out.push('      Cada uno propone A CIEGAS (pz debate proponer <id>), se destapan juntas, se objeta CON evidencia y se cierra con decisión escrita.');
    out.push('  5) Al terminar → pz say done "<resultado / PR #>"');
    out.push('  Los mensajes nuevos de la sala te van a llegar solos mientras trabajás (hook inbox) — no hace falta pollear.');
    out.push('  Tablero + chat (para el usuario): http://localhost:' + CFG.port);
  }
  // lo que el board ya mostró cuenta como leído (que el inbox no lo repita)
  if (state.chat && state.chat.length) markChatSeen(c.sid, state.chat[state.chat.length - 1].ts);
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
  pz isolate [<slug>] [--carry]         crear tu worktree propio off main y mudarte (lleva .env y node_modules)
  pz board                              ver otras sesiones + chat
  pz bitacora [--date D] [--weekly] [--json]   generar bitácora diaria o semanal (2 capas) → Obsidian + tablero
  pz whoami
  pz install [<ruta-al-repo>] [--owner "Nombre"] [--dry-run]   configurar repo (+ pregunta tu nombre) y cablear los hooks
  pz uninstall [--dry-run]              quitar los hooks de PZ Sessions`);
