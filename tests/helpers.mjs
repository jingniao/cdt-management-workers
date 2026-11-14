// Node >=22.13. Uses real routes/SQL/crypto; only D1 transport and external HTTP are local doubles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.test-runtime', String(process.pid));
fs.mkdirSync(runtime, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'src')).filter(n => n.endsWith('.ts'))) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src', name), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3');
  fs.writeFileSync(path.join(runtime, name.replace(/\.ts$/, '.mjs')), code);
}
const load = name => import(pathToFileURL(path.join(runtime, name + '.mjs')));
const { app } = await load('api');
const repo = await load('repo');
const notify = await load('notify');
const ddns = await load('ddns');

class LocalD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.tail = Promise.resolve();
    for (const name of fs.readdirSync(path.join(root, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
      this.db.exec(fs.readFileSync(path.join(root, 'migrations', name), 'utf8'));
    }
  }
  prepare(sql) {
    const db = this.db;
    return { bind(...args) { return {
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
    }; } };
  }
  batch(statements) {
    const operation = this.tail.then(async () => {
      this.db.exec('BEGIN');
      try { const results = []; for (const s of statements) results.push(await s.run()); this.db.exec('COMMIT'); return results; }
      catch (e) { this.db.exec('ROLLBACK'); throw e; }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
function environment(t) {
  const DB = new LocalD1(); t.after(() => DB.db.close());
  return { DB, SESSION_SECRET: 'local-test-session-secret-32-characters', ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
}
function request(env, route, body, auth) {
  return app.request('https://local.invalid' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ?? {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}
async function setup(env, username = 'owner') {
  return request(env, '/api/v1/setup', { username, password: 'owner-password-123', setup_key: env.SESSION_SECRET });
}
function credentials(response) {
  const cookies = response.headers.getSetCookie().map(v => v.split(';')[0]);
  const csrf = cookies.find(v => v.startsWith('cdt_mgmt_csrf=')).split('=')[1];
  return { Cookie: cookies.join('; '), 'x-cdt-csrf': csrf };
}
globalThis.fetch = async () => { throw new Error('Unexpected external request'); };


export { app, repo, notify, ddns, LocalD1, environment, request, setup, credentials, load, root, runtime, ts, fs, path };
