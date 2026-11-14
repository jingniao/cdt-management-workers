import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
function run(t, mode, input = '') {
  const folder = fs.mkdtempSync(path.join(root, '.test-secrets-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const log = path.join(folder, 'calls');
  // Only the Cloudflare CLI is replaced; execute the production shell script and validation.
  fs.writeFileSync(path.join(folder, 'npx'), `#!/usr/bin/env bash
if [[ "$*" == "wrangler secret list --format json" ]]; then
  case "$TEST_SECRET_MODE" in
    existing) echo '[{"name":"SESSION_SECRET"},{"name":"ENCRYPTION_KEY"}]';;
    fresh) echo 'Worker not found [code: 10007]' >&2; exit 1;;
    denied) echo 'Authentication error [code: 10000]' >&2; exit 1;;
  esac
elif [[ "$1 $2 $3" == "wrangler secret put" ]]; then
  cat >/dev/null
  printf '%s\\n' "$4" >> "$TEST_SECRET_LOG"
else
  exit 93
fi
`, { mode: 0o755 });
  const shellPath = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
  const taskPath = shellPath(folder);
  const nodePath = shellPath(path.dirname(process.execPath));
  return { log, result: spawnSync(bash, ['-c', 'export PATH="$TEST_BIN:$TEST_NODE:$PATH"; [[ "$(command -v npx)" == "$TEST_BIN/npx" ]] || exit 94; bash scripts/setup-secrets.sh'], {
    cwd: root, encoding: 'utf8', input,
    env: { ...process.env, TEST_BIN: taskPath, TEST_NODE: nodePath, TEST_SECRET_LOG: shellPath(log), TEST_SECRET_MODE: mode },
  }) };
}
test('redeploy preserves both existing secrets without prompting or writing', t => {
  const { result, log } = run(t, 'existing');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(log), false);
});
test('first deployment writes only the two validated keys', t => {
  const { result, log } = run(t, 'fresh', 'a'.repeat(64) + '\n' + Buffer.alloc(32, 4).toString('base64') + '\n');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['SESSION_SECRET', 'ENCRYPTION_KEY']);
  assert.ok(!result.stdout.includes('a'.repeat(64)));
});
test('authentication failure aborts instead of assuming secrets are missing', t => {
  const { result, log } = run(t, 'denied');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Authentication error/);
  assert.equal(fs.existsSync(log), false);
});
test('empty first-deployment key is rejected without writing any secret', t => {
  const { result, log } = run(t, 'fresh', '\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /为空或格式不正确/);
  assert.equal(fs.existsSync(log), false);
});
