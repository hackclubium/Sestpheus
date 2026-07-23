import assert from 'node:assert/strict';
import worker from '../worker.js';

const store = new Map();
const waits = [];
const ctx = { waitUntil: (promise) => waits.push(promise) };
const env = { SLACK_SIGNING_SECRET: 'slack-secret', SLACK_BOT_TOKEN: 'xoxb-test', SESTPHEUS_STATE_TOKEN: 'state-secret', SESTPHEUS_DB: fakeD1(store, 'sestpheus_state') };
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) });
  return Response.json({ ok: true });
};

await slashCommand({ command: '/sest-in', channel_id: 'C123', user_id: 'U123' });
await slashCommand({ command: '/sest-chan-in', channel_id: 'C123', user_id: 'U123' });
assert.equal(calls.at(-1).url, 'https://slack.com/api/conversations.join');
calls.length = 0;

const response = await worker.fetch(await signedRequest(JSON.stringify({ type: 'event_callback', event: { type: 'message', channel: 'C123', user: 'U123', ts: '123.456', text: sestina() } }), 'application/json'), env, ctx);
assert.equal(response.status, 200);
assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
assert.match(calls[0].body.text, /end words: stone, river, moon, garden, fire, bird/);
assert.deepEqual(calls[1].body, { channel: 'C123', timestamp: '123.456', name: 'six_pointed_star' });

const get = await worker.fetch(new Request('https://sestpheus.test/state', { headers: { authorization: 'Bearer state-secret' } }), env);
assert.deepEqual(await get.json(), { channels: ['C123'], users: ['U123'] });
globalThis.fetch = realFetch;
console.log('ok');

async function slashCommand(payload) {
  const response = await worker.fetch(await signedRequest(new URLSearchParams(payload).toString(), 'application/x-www-form-urlencoded'), env, ctx);
  assert.equal(response.status, 200);
  await Promise.all(waits.splice(0));
}

function sestina() {
  let order = ['stone', 'river', 'moon', 'garden', 'fire', 'bird'];
  const lines = [];
  for (let stanza = 0; stanza < 6; stanza++) {
    for (const word of order) lines.push(`line ends with ${word}`);
    order = [order[5], order[0], order[4], order[1], order[3], order[2]];
  }
  return [...lines, 'stone river', 'moon garden', 'fire bird'].join('\n');
}

async function signedRequest(body, contentType) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return new Request('https://sestpheus.test/slack', { method: 'POST', headers: { 'content-type': contentType, 'x-slack-request-timestamp': timestamp, 'x-slack-signature': await sign(env.SLACK_SIGNING_SECRET, `v0:${timestamp}:${body}`) }, body });
}

async function sign(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return `v0=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function fakeD1(values, table) {
  return { prepare(sql) { return { params: [], bind(...params) { this.params = params; return this; }, async run() { if (sql.startsWith(`INSERT INTO ${table}`)) values.set(this.params[0], { value: this.params[1], expires_at: this.params[2] ?? null }); else if (sql.startsWith(`DELETE FROM ${table} WHERE key = ?`)) values.delete(this.params[0]); return { success: true }; }, async first() { if (!sql.startsWith(`SELECT value, expires_at FROM ${table}`)) return null; const row = values.get(this.params[0]); return row && { value: row.value, expires_at: row.expires_at }; } }; } };
}
