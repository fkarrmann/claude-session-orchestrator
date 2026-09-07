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
  // Modelo LOCAL (llama.cpp / LM Studio / Ollama: cualquiera con API tipo OpenAI).
  // Se usa como TERCERA VOZ independiente en los debates. Sin servidor arriba, la
  // sala funciona igual y lo dice; no hay fallback silencioso.
  localLlm: {
    url: process.env.PZ_LOCAL_LLM_URL || (file.localLlm && file.localLlm.url) || 'http://127.0.0.1:8090/v1',
    model: process.env.PZ_LOCAL_LLM_MODEL || (file.localLlm && file.localLlm.model) || '',   // vacío = lo descubre de /v1/models
    nombre: process.env.PZ_LOCAL_LLM_NAME || (file.localLlm && file.localLlm.nombre) || 'Qwen local 🧩',
  },
  dir: DIR,
  pzScript: path.join(DIR, 'pz.js'),
  serverScript: path.join(DIR, 'server.js'),
  configPath: CONF_PATH,
};
