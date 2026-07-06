#!/usr/bin/env node
/**
 * staleness.js — ¿qué tan viejo está un worktree respecto del main REAL (origin/<main>)?
 *
 * ÚNICA fuente de verdad de umbrales y medición. La consumen:
 *   - pz.js board   → aviso al arrancar la sesión (banner del hook SessionStart)
 *   - server.js     → flag staleLevel por worktree para pintar el tablero
 *   - bitacora.js   → sección "salud de worktrees" del diario
 *
 * Por qué existe: los worktrees persistentes se crean una vez y nadie los pullea;
 * meses después una sesión arranca ahí y saca conclusiones sobre código fósil.
 * El `behind` contra la COPIA LOCAL de origin/main también puede mentir si nadie
 * fetcheó hace rato — por eso el fetch condicional (barato: solo si la copia
 * local tiene > FETCH_TTL_MIN; un fetch refresca a TODOS los worktrees porque
 * comparten el .git común).
 *
 * Fail-open en todo: sin remoto, sin red o repo raro → null (el tool queda inerte).
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CFG = require('./config');
const MAIN_BRANCH = CFG.mainBranch;

const FETCH_TTL_MIN = 30; // si la copia local de origin/<main> tiene más que esto, fetchear antes de comparar

// Dos ejes, gana el peor: commits detrás de prod Y edad del último commit local.
// (una feature branch activa puede estar behind sin estar podrida → por eso se combinan)
const THRESHOLDS = {
  yellow: { behind: 50, ageDays: 7 },
  red: { behind: 200, ageDays: 21 },
};

const sh = (c, cwd, timeout = 8000) => {
  try { return execSync(c, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout }).trim(); }
  catch { return ''; }
};

function levelOf(behind, ageDays) {
  if (behind > THRESHOLDS.red.behind || ageDays > THRESHOLDS.red.ageDays) return 'red';
  if (behind > THRESHOLDS.yellow.behind || ageDays > THRESHOLDS.yellow.ageDays) return 'yellow';
  return null;
}

// Fetch condicional: solo si FETCH_HEAD (compartido por todos los worktrees) está viejo.
// Devuelve { attempted, failed } — si falla (offline), el caller degrada con nota.
function ensureFreshBase(cwd) {
  const common = sh('git rev-parse --git-common-dir', cwd);
  if (!common) return { attempted: false, failed: false };
  const fetchHead = path.join(path.resolve(cwd, common), 'FETCH_HEAD');
  let ageMin = Infinity;
  try { ageMin = (Date.now() - fs.statSync(fetchHead).mtimeMs) / 60000; } catch {}
  if (ageMin <= FETCH_TTL_MIN) return { attempted: false, failed: false };
  const ok = sh(`git fetch origin ${MAIN_BRANCH} --no-tags --quiet && echo ok`, cwd, 15000) === 'ok';
  return { attempted: true, failed: !ok };
}

/**
 * Mide el staleness de un worktree. { fetch: true } hace el fetch condicional primero.
 * → { behind, ahead, ageDays, headIso, level, fetchFailed } o null (sin remoto / fail-open).
 */
function measure(top, opts = {}) {
  if (!top) return null;
  let fetchFailed = false;
  if (opts.fetch) fetchFailed = ensureFreshBase(top).failed;
  if (!sh(`git rev-parse --verify -q origin/${MAIN_BRANCH}`, top)) return null; // sin remoto → inerte
  const m = sh(`git rev-list --left-right --count origin/${MAIN_BRANCH}...HEAD`, top).match(/^(\d+)\s+(\d+)$/);
  if (!m) return null;
  const behind = +m[1], ahead = +m[2];
  const headIso = sh('git log -1 --format=%cI', top);
  const ageDays = headIso ? Math.floor((Date.now() - new Date(headIso).getTime()) / 86400000) : 0;
  return { behind, ahead, ageDays, headIso, level: levelOf(behind, ageDays), fetchFailed };
}

/**
 * Censo de TODOS los worktrees del repo: un solo fetch condicional y una medición
 * por worktree (sin fetch individual — comparten el .git común).
 * → [{ path, name, branch, behind, ahead, ageDays, level }] ordenado del más podrido al más sano.
 */
function surveyAll(repo = CFG.repo) {
  if (!repo) return [];
  ensureFreshBase(repo);
  const rows = [];
  const blocks = sh('git worktree list --porcelain', repo).split('\n\n').filter(Boolean);
  for (const b of blocks) {
    const p = (b.match(/^worktree (.+)$/m) || [])[1];
    if (!p || !fs.existsSync(p)) continue;
    const branch = ((b.match(/^branch (.+)$/m) || [])[1] || '').replace('refs/heads/', '') || null;
    const m = measure(p); // sin fetch: ya lo hizo ensureFreshBase de entrada
    if (m) rows.push({ path: p, name: path.basename(p), branch, ...m });
  }
  const rank = { red: 0, yellow: 1 };
  return rows.sort((a, b) => (rank[a.level] ?? 2) - (rank[b.level] ?? 2) || b.behind - a.behind);
}

module.exports = { measure, levelOf, ensureFreshBase, surveyAll, THRESHOLDS, FETCH_TTL_MIN };
