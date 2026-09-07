#!/usr/bin/env node
/**
 * state — la capa de estado compartida por pz.js (un proceso por hook) y server.js
 * (el tablero + Telegram). Todos escriben los MISMOS archivos JSON a la vez.
 *
 * Dos garantías, las dos aprendidas a los golpes:
 *
 *  1) writeJSON TIRA si no pudo guardar. Antes se tragaba el error y el que llamaba
 *     imprimía "✓ listo" sobre un archivo que nunca cambió.
 *
 *  2) mutate() serializa leer-modificar-escribir. El rename atómico evita archivos a
 *     medio escribir, pero NO evita perder updates: dos procesos leen la misma versión,
 *     los dos escriben, y el segundo pisa al primero. Medido: 25 sesiones posteando a la
 *     vez perdían 15 de 50 mensajes y 12 de 25 sesiones. El lock es un DIRECTORIO
 *     (mkdir es atómico en POSIX) — cero dependencias y se puede romper si quedó huérfano.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LOCK_WAIT_MS = 8000;    // tope de espera: los tramos críticos duran milisegundos, 8s es "algo anda mal"
const LOCK_STALE_MS = 5000;   // MENOR que la espera a propósito: un lock huérfano siempre se rompe dentro de la ventana

const now = () => Date.now();
const napMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { execSync(`sleep ${(ms / 1000).toFixed(2)}`); } };

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// escritura atómica (tmp + rename). Si falla, TIRA: que nadie diga "guardado" de gusto.
function writeJSON(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, file); }
  catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`no pude guardar ${path.basename(file)} (${(e && e.message) || e})`);
  }
}

// Si no consigo el lock, TIRO en vez de seguir sin él: escribir sin lock es
// exactamente el bug que vinimos a arreglar, y hacerlo en silencio es peor.
function withLock(file, fn) {
  const lock = file + '.lock';
  const until = now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.mkdirSync(lock); break; }                                            // lo tengo
    catch (e) { if (e && e.code !== 'EEXIST') throw new Error(`no pude crear el lock de ${path.basename(file)} (${e.message})`); }  // permisos/disco: decilo YA, no esperes 8s culpando al candado
    try { if (now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true }); } catch {}  // huérfano → romperlo
    if (now() >= until) throw new Error(`no pude tomar el lock de ${path.basename(file)} en ${LOCK_WAIT_MS / 1000}s — NO escribí nada`);
    napMs(40);
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

// fn(data) → devolvé el objeto a escribir, o null/undefined para no escribir nada.
// OJO: no anidar mutate() de dos archivos distintos (deadlock); leé lo otro ANTES.
function mutate(file, def, fn) {
  return withLock(file, () => {
    const data = readJSON(file, def);
    const next = fn(data);
    if (next) writeJSON(file, next);
    return next || data;
  });
}

module.exports = { readJSON, writeJSON, withLock, mutate, napMs };
