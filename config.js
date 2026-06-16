#!/usr/bin/env node
/**
 * Shared config for the orchestrator (server.js + pz.js). Zero dependencies.
 *
 * Resolution order (highest first): env vars → pz.config.json → defaults.
 * pz.config.json is per-machine and git-ignored — copy pz.config.example.json,
 * or run:  node pz.js install <path-to-your-repo>
 *
 * With no repo configured the tool is INERT (the guard hook fails open everywhere),
 * so a fresh clone never interferes with unrelated projects until you set it up.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = __dirname;
const CONF_PATH = path.join(DIR, 'pz.config.json');

let file = {};
try { file = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8')) || {}; } catch {}

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const repo = expandHome(process.env.PZ_REPO || file.repo || '');
const repoName = repo ? path.basename(repo) : '';

module.exports = {
  configured: !!repo,
  repo,                                                   // absolute path of the git repo to orchestrate
  repoName,                                               // basename — used to detect named worktrees and as a cheap scope hint
  mainBranch: process.env.PZ_MAIN_BRANCH || file.mainBranch || 'main',
  port: Number(process.env.PZ_PORT) || Number(file.port) || 4646,
  // tu nombre: el chat reacciona a "@<owner>" para notificarte y firma así las respuestas
  // que entran por Telegram. Opcional — sin esto, solo notifican ask/warn (sin trigger por mención).
  owner: process.env.PZ_OWNER || file.owner || '',
  noTelegram: !!process.env.PZ_NO_TELEGRAM,
  // dirs (relative to repo) whose .env* files `pz isolate` copies into the new worktree
  envDirs: Array.isArray(file.envDirs) && file.envDirs.length ? file.envDirs : [''],
  dir: DIR,
  pzScript: path.join(DIR, 'pz.js'),
  serverScript: path.join(DIR, 'server.js'),
  configPath: CONF_PATH,
};
