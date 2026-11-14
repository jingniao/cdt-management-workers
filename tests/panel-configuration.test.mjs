import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, repo, notify, ddns, LocalD1, environment, request, setup, credentials, load, root, runtime, ts, fs, path } from './helpers.mjs';

test('setup rejects missing or incorrect deployment key without initializing', async t => {
  const env = environment(t);
  for (const setup_key of [undefined, 'wrong-deployment-key']) {
    const response = await request(env, '/api/v1/setup', { username: 'outsider', password: 'different-password', setup_key });
    assert.equal(response.status, 403);
    assert.equal(await repo.getSetting(env, 'initialized'), '0');
    assert.equal(response.headers.get('set-cookie'), null);
  }
});
test('two deployment keys suffice for setup and password login', async t => {
  const env = environment(t); const response = await setup(env);
  assert.equal(response.status, 200);
  assert.ok(response.headers.getSetCookie().every(v => /; Secure/i.test(v)));
  const login = await request(env, '/api/v1/auth/login', { username: 'owner', password: 'owner-password-123' });
  assert.equal(login.status, 200);
  assert.equal((await request(env, '/api/v1/auth/me', undefined, credentials(login))).status, 200);
  assert.equal((await setup(env, 'second')).status, 409);
});
test('setup fails closed when the session secret is missing', async t => {
  const env = environment(t); delete env.SESSION_SECRET;
  assert.equal((await setup(env)).status, 503);
  assert.equal(await repo.getSetting(env, 'initialized'), '0');
});
test('concurrent initialization creates exactly one administrator session', async t => {
  const env = environment(t);
  const responses = await Promise.all([setup(env, 'first'), setup(env, 'second')]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(responses.filter(r => r.headers.has('set-cookie')).length, 1);
  const winner = responses[0].status === 200 ? 'first' : 'second';
  assert.equal(await repo.getSetting(env, 'admin_username'), winner);
});
test('email settings save encrypted API key, preserve blank edits, and send using saved configuration', async t => {
  const env = environment(t); const auth = credentials(await setup(env));
  const email = { enabled: true, webhook_url: 'https://mail.example.invalid/send', api_key: 'saved-mail-secret', to: 'owner@example.invalid' };
  assert.equal((await request(env, '/api/v1/settings', { email }, auth)).status, 200);
  const stored = env.DB.db.prepare('SELECT value FROM settings WHERE key=?').get('notify_mail_api_key');
  assert.ok(stored?.value.startsWith('aesgcm:v1:'));
  assert.ok(!stored.value.includes('saved-mail-secret'));
  const view = await (await request(env, '/api/v1/settings', undefined, auth)).json();
  assert.equal(view.email.webhook_url, email.webhook_url);
  assert.equal(view.email.api_key_configured, true);
  assert.ok(view.channels.includes('email'));
  assert.ok(!JSON.stringify(view).includes('saved-mail-secret'));
  await request(env, '/api/v1/settings', { email: { api_key: '' } }, auth);
  assert.equal(await repo.getSetting(env, 'notify_mail_api_key'), 'saved-mail-secret');
  let outgoing; const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => { outgoing = { url, options }; return new Response('ok'); };
  const response = await request(env, '/api/v1/settings/test/email', {}, auth);
  assert.equal((await response.json()).ok, true);
  assert.equal(outgoing.url, email.webhook_url);
  assert.equal(outgoing.options.headers.Authorization, 'Bearer saved-mail-secret');
  assert.equal(JSON.parse(outgoing.options.body).to, email.to);
});
test('email draft test uses unsaved inputs without persisting them', async t => {
  const env = environment(t); const auth = credentials(await setup(env));
  let outgoing; const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => { outgoing = { url, options }; return new Response('ok'); };
  const response = await request(env, '/api/v1/settings/test/email', { email: { webhook_url: 'https://draft.example.invalid/send', api_key: 'draft-secret', to: 'draft@example.invalid' } }, auth);
  assert.equal((await response.json()).ok, true);
  assert.equal(outgoing.url, 'https://draft.example.invalid/send');
  assert.equal(outgoing.options.headers.Authorization, 'Bearer draft-secret');
  assert.equal(await repo.getSetting(env, 'notify_mail_api_key'), '');
});
test('email rejects insecure URL at save and draft test boundaries', async t => {
  const env = environment(t); const auth = credentials(await setup(env));
  for (const route of ['/api/v1/settings', '/api/v1/settings/test/email']) {
    assert.equal((await request(env, route, { email: { webhook_url: 'http://mail.example.invalid' } }, auth)).status, 400);
  }
});
test('saved notification configuration takes precedence over legacy deployment variables', async t => {
  const env = environment(t); env.TELEGRAM_BOT_TOKEN = 'legacy-token'; env.TELEGRAM_CHAT_ID = 'legacy-chat';
  assert.equal(notify.telegramToken(env, { notify_tg_token: 'panel-token' }), 'panel-token');
  assert.equal(notify.telegramChatId(env, { notify_tg_chat_id: 'panel-chat' }), 'panel-chat');
  assert.equal(notify.telegramToken(env, {}), 'legacy-token');
  env.EMAIL_WEBHOOK_URL = 'https://legacy.example.invalid'; env.EMAIL_API_KEY = 'legacy-mail-secret';
  let outgoing; const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => { outgoing = { url, options }; return new Response('ok'); };
  await notify.sendEmail(env, { notify_mail_webhook_url: 'https://panel.example.invalid', notify_mail_api_key: 'panel-secret', notify_mail_to: 'a@example.invalid' }, { kind: 'test', title: 'test', titleHtml: 'test', body: 'test' });
  assert.equal(outgoing.url, 'https://panel.example.invalid');
  assert.equal(outgoing.options.headers.Authorization, 'Bearer panel-secret');
});
test('panel Cloudflare token overrides legacy token in real DDNS request', async t => {
  const env = environment(t); env.CLOUDFLARE_API_TOKEN = 'legacy-cf';
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; }); let authorization;
  globalThis.fetch = async (url, options) => {
    authorization = options.headers.Authorization;
    return Response.json({ success: true, result: [{ id: 'record', content: '8.8.8.8' }] });
  };
  await ddns.syncFull(env, { ddns_enabled: '1', ddns_cf_token: 'panel-cf', ddns_zone_id: 'zone' }, { record: 'node.example.com', ip: '8.8.8.8', verify: true });
  assert.equal(authorization, 'Bearer panel-cf');
});

test('frontend displays setup validation errors returned by the API', async t => {
  const source = fs.readFileSync(path.join(root, 'web/src/api.ts'), 'utf8');
  fs.writeFileSync(path.join(runtime, 'web-api.mjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; delete globalThis.window; });
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async () => Response.json({ ok: false, code: 'invalid_setup_key', message: '初始化验证密钥不正确' }, { status: 403 });
  const { api } = await load('web-api');
  await assert.rejects(api('/api/v1/setup'), error => error.code === 'invalid_setup_key' && error.message === '初始化验证密钥不正确');
});
