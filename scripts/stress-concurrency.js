#!/usr/bin/env node
/**
 * Black-box concurrency stress test for the pz CLI state store.
 *
 * It copies the CLI into a disposable fixture, registers sessions sequentially,
 * then makes them post and claim in parallel. Every CLI process may report
 * success; the assertions below verify that the shared JSON state actually kept
 * every update.
 *
 * Usage:
 *   node scripts/stress-concurrency.js [workers] [rounds]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sourceRoot = path.resolve(__dirname, '..');
const workers = positiveInt(process.argv[2], 24);
const rounds = positiveInt(process.argv[3], 3);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-concurrency-'));
const cli = path.join(fixture, 'pz.js');

function positiveInt(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error(`Expected an integer from 1 to 500, got: ${value}`);
  }
  return parsed;
}

function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(fixture, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function run(sessionId, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: fixture,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(
        `${sessionId}: pz ${args.join(' ')} exited ${code ?? signal}\n${stdout}${stderr}`,
      ));
    });
  });
}

async function main() {
  fs.copyFileSync(path.join(sourceRoot, 'pz.js'), cli);
  fs.copyFileSync(path.join(sourceRoot, 'config.js'), path.join(fixture, 'config.js'));
  fs.copyFileSync(path.join(sourceRoot, 'state.js'), path.join(fixture, 'state.js'));
  fs.writeFileSync(path.join(fixture, 'pz.config.json'), JSON.stringify({
    repo: fixture,
    mainBranch: 'main',
    port: 1,
    owner: 'Stress Test',
  }));
  fs.writeFileSync(path.join(fixture, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(fixture, 'claims.json'), '{}');
  fs.writeFileSync(path.join(fixture, 'chat.json'), '[]');
  fs.writeFileSync(path.join(fixture, 'registry.json'), '{}');

  const ids = Array.from({ length: workers }, (_, i) => `stress-${i}`);
  for (const [i, id] of ids.entries()) {
    await run(id, ['join', `Worker ${i}`, 'concurrency test']);
  }

  for (let round = 0; round < rounds; round += 1) {
    await Promise.all(ids.map((id, i) => run(id, [
      'say', 'note', `stress-message-${round}-${i}`,
    ])));
    await Promise.all(ids.map((id, i) => run(id, [
      'claim', `files/round-${round}/worker-${i}.txt`,
    ])));
  }

  const chat = readJSON('chat.json', []);
  const claims = readJSON('claims.json', {});
  const missingMessages = [];
  const missingClaims = [];

  for (let round = 0; round < rounds; round += 1) {
    for (let i = 0; i < workers; i += 1) {
      const marker = `stress-message-${round}-${i}`;
      if (!chat.some((message) => message.text === marker)) missingMessages.push(marker);
      const suffix = path.join('files', `round-${round}`, `worker-${i}.txt`);
      if (!Object.keys(claims).some((claimPath) => claimPath.endsWith(suffix))) {
        missingClaims.push(suffix);
      }
    }
  }

  const expected = workers * rounds;
  if (missingMessages.length || missingClaims.length) {
    const sample = (items) => items.slice(0, 8).join(', ') || 'none';
    throw new Error([
      `Lost ${missingMessages.length}/${expected} chat updates (sample: ${sample(missingMessages)})`,
      `Lost ${missingClaims.length}/${expected} claim updates (sample: ${sample(missingClaims)})`,
    ].join('\n'));
  }
  console.log(`PASS: preserved ${expected} parallel chat messages and ${expected} claims.`);
}

main()
  .catch((error) => {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
  });
