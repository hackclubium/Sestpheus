import { pathToFileURL } from 'node:url';
import { analyzeSestina, cleanDisplayText } from './sestina.mjs';

const reaction = 'six_pointed_star';

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export async function main() {
  const token = mustEnv('SLACK_BOT_TOKEN');
  const state = await getState();
  for (const channel of state.channels) {
    const messages = await slack(token, 'conversations.history', { channel, limit: 50 }).catch((error) => {
      if (error.message.includes('not_in_channel') || error.message.includes('channel_not_found')) return { messages: [] };
      throw error;
    });
    for (const message of messages.messages ?? []) {
      if (!message.user || !state.users.includes(message.user) || message.subtype) continue;
      if ((message.text ?? '').length > 8000) continue;
      const analysis = analyzeSestina(message.text ?? '');
      if (!analysis.ok || (message.reactions ?? []).some((item) => item.name === reaction)) continue;
      if (await hasThreadReply(token, channel, message.ts, message.user, 'sestina')) continue;
      const text = cleanDisplayText(message.text ?? '');
      await postForm(token, channel, message.ts, message.user, text, `end words: ${analysis.endWords.join(', ')}`, 'sestina');
      await slack(token, 'reactions.add', { channel, timestamp: message.ts, name: reaction }).catch((error) => console.warn(`reaction skipped: ${error.message}`));
    }
  }
}

async function hasThreadReply(token, channel, ts, user, form) {
  const replies = await slack(token, 'conversations.replies', { channel, ts, limit: 20 }).catch(() => ({ messages: [] }));
  return (replies.messages ?? []).some((message) => (message.text ?? '').includes(`- a ${form} by <@${user}>`));
}

async function getState() {
  const url = new URL(mustEnv('SESTPHEUS_STATE_URL'));
  if (url.pathname === '/') url.pathname = '/state';
  const response = await fetch(url, { headers: { authorization: `Bearer ${mustEnv('SESTPHEUS_STATE_TOKEN')}` } });
  if (!response.ok) throw new Error(`state fetch failed: ${response.status} ${url}`);
  return response.json();
}

async function postForm(token, channel, ts, user, text, line, form) {
  await slack(token, 'chat.postMessage', {
    channel,
    thread_ts: ts,
    text: `${text}\n---\n${line}\n- a ${form} by <@${user}>, ${new Date().getUTCFullYear()}`,
    blocks: [
      { type: 'section', text: { type: 'plain_text', text } },
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${line}\n- a ${form} by <@${user}>, ${new Date().getUTCFullYear()}` }] }
    ],
    unfurl_links: false,
    unfurl_media: false
  });
}

async function slack(token, method, body) {
  const response = await fetch(`https://slack.com/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  return json;
}

function mustEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
