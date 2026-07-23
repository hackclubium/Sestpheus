import { analyzeSestina, cleanDisplayText } from './scripts/sestina.mjs';

const VERSION = 'sestpheus-events-v1';
const CFG = {
  bot: 'Sestpheus',
  prefix: 'sest',
  db: 'SESTPHEUS_DB',
  token: 'SESTPHEUS_STATE_TOKEN',
  table: 'sestpheus_state',
  form: 'sestina',
  plural: 'sestinas',
  reaction: 'six_pointed_star',
  analyze: analyzeSestina,
  line: (a) => `end words: ${a.endWords.join(', ')}`
};

let dbReady;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/state') return stateSnapshot(request, env);
    if (request.method !== 'POST') return new Response('not found', { status: 404 });

    const rawBody = await request.text();
    const verification = urlVerification(rawBody);
    if (verification) return new Response(verification, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (!(await validSlackRequest(request, rawBody, env.SLACK_SIGNING_SECRET))) return slackResponse(`${CFG.bot} received this command, but Slack signature verification failed. Check Worker SLACK_SIGNING_SECRET.`);
    if ((request.headers.get('content-type') ?? '').includes('application/json')) return slackEvent(rawBody, env, ctx);
    return slashCommand(rawBody, env, ctx);
  }
};

async function slashCommand(rawBody, env, ctx) {
  const form = new URLSearchParams(rawBody);
  const command = form.get('command');
  const commands = [`/${CFG.prefix}-in`, `/${CFG.prefix}-out`, `/${CFG.prefix}-chan-in`, `/${CFG.prefix}-chan-out`];
  if (!commands.includes(command)) return slackResponse('Unknown command.');

  const payload = { command, channel: form.get('channel_id'), user: form.get('user_id') };
  await updateState(env, payload);
  if (command === `/${CFG.prefix}-chan-in`) waitUntil(ctx, joinChannel(env, payload.channel));
  const joinNote = command === `/${CFG.prefix}-chan-in` ? ` Public channels auto-join in background; private channels still need \`/invite @${CFG.bot}\`.` : '';
  return slackResponse(`${messageFor(command)}${joinNote} (${VERSION}; saving in background; you=${payload.user}; channel=${payload.channel})`);
}

async function slackEvent(rawBody, env) {
  const payload = JSON.parse(rawBody);
  if (payload.type === 'url_verification') return Response.json({ challenge: payload.challenge });
  const event = payload.event;
  if (payload.type !== 'event_callback' || event?.type !== 'message') return new Response('ok');
  if (!event.user || event.subtype || event.bot_id || !event.channel || !event.ts) return new Response('ok');

  const state = await getState(env);
  if (!state.channels.includes(event.channel) || !state.users.includes(event.user)) return new Response('ok');
  if ((event.text ?? '').length > 8000) return new Response('ok');

  const key = `processed:${event.channel}:${event.ts}`;
  if (await dbGet(env, key)) return new Response('ok');
  const analysis = CFG.analyze(event.text ?? '');
  if (!analysis.ok) return new Response('ok');

  const text = cleanDisplayText(event.text ?? '');
  await Promise.all([
    slack(env, 'chat.postMessage', {
      channel: event.channel,
      thread_ts: event.ts,
      text: `${text}\n---\n${CFG.line(analysis)}\n- a ${CFG.form} by <@${event.user}>, ${new Date().getUTCFullYear()}`,
      blocks: [
        { type: 'section', text: { type: 'plain_text', text } },
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${CFG.line(analysis)}\n- a ${CFG.form} by <@${event.user}>, ${new Date().getUTCFullYear()}` }] }
      ],
      unfurl_links: false,
      unfurl_media: false
    }),
    slack(env, 'reactions.add', { channel: event.channel, timestamp: event.ts, name: CFG.reaction })
  ]);
  await dbPut(env, key, '1', 12 * 60 * 60).catch(() => {});
  return new Response('ok');
}

function messageFor(command) {
  return {
    [`/${CFG.prefix}-in`]: `User opt-in to ${CFG.bot}. Disable with \`/${CFG.prefix}-out\``,
    [`/${CFG.prefix}-out`]: `User opt-out to ${CFG.bot}. Re-enable with \`/${CFG.prefix}-in\``,
    [`/${CFG.prefix}-chan-in`]: `Channel opt-in to ${CFG.bot}.`,
    [`/${CFG.prefix}-chan-out`]: `Channel opt-out to ${CFG.bot}.`
  }[command];
}

async function updateState(env, payload) {
  const state = await getState(env);
  if (payload.command === `/${CFG.prefix}-in`) add(state.users, payload.user);
  if (payload.command === `/${CFG.prefix}-out`) remove(state.users, payload.user);
  if (payload.command === `/${CFG.prefix}-chan-in`) add(state.channels, payload.channel);
  if (payload.command === `/${CFG.prefix}-chan-out`) remove(state.channels, payload.channel);
  state.channels.sort();
  state.users.sort();
  await dbPut(env, 'state', JSON.stringify(state));
}

async function stateSnapshot(request, env) {
  if (request.headers.get('authorization') !== `Bearer ${env[CFG.token]}`) return new Response('unauthorized', { status: 401 });
  return Response.json(await getState(env));
}

async function getState(env) {
  return (await dbGet(env, 'state', 'json')) ?? { channels: [], users: [] };
}

async function slack(env, method, body) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  return json;
}

async function joinChannel(env, channel) {
  try {
    await slack(env, 'conversations.join', { channel });
  } catch (error) {
    if (!error.message.includes('method_not_supported_for_channel_type')) throw error;
  }
}

async function dbGet(env, key, type = 'text') {
  await ensureDb(env);
  const row = await env[CFG.db].prepare(`SELECT value, expires_at FROM ${CFG.table} WHERE key = ?`).bind(key).first();
  if (!row) return null;
  if (row.expires_at && row.expires_at <= Math.floor(Date.now() / 1000)) {
    await dbDelete(env, key);
    return null;
  }
  return type === 'json' ? JSON.parse(row.value) : row.value;
}

async function dbPut(env, key, value, expirationTtl = null) {
  await ensureDb(env);
  const expiresAt = expirationTtl ? Math.floor(Date.now() / 1000) + expirationTtl : null;
  await env[CFG.db].prepare(`INSERT INTO ${CFG.table} (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`).bind(key, value, expiresAt).run();
}

async function dbDelete(env, key) {
  await ensureDb(env);
  await env[CFG.db].prepare(`DELETE FROM ${CFG.table} WHERE key = ?`).bind(key).run();
}

async function ensureDb(env) {
  if (!env[CFG.db]) throw new Error(`${CFG.db} D1 binding is required`);
  dbReady ||= env[CFG.db].prepare(`CREATE TABLE IF NOT EXISTS ${CFG.table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)`).run();
  await dbReady;
}

function urlVerification(rawBody) {
  try {
    const payload = JSON.parse(rawBody);
    return payload?.type === 'url_verification' ? payload.challenge : '';
  } catch {
    return '';
  }
}

function slackResponse(text) {
  return Response.json({ response_type: 'ephemeral', text });
}

function waitUntil(ctx, promise) {
  if (ctx?.waitUntil) ctx.waitUntil(promise.catch(() => {}));
}

function add(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function remove(list, value) {
  const index = list.indexOf(value);
  if (index !== -1) list.splice(index, 1);
}

async function validSlackRequest(request, rawBody, secret) {
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');
  if (!secret || !timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
  return timingSafeEqual(signature, `v0=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
