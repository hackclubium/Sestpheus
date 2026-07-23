import assert from 'node:assert/strict';
import { analyzeSestina, isSestina } from './sestina.mjs';

const ends = ['stone', 'river', 'moon', 'garden', 'fire', 'bird'];
let order = ends;
const lines = [];
for (let stanza = 0; stanza < 6; stanza++) {
  for (const word of order) lines.push(`line ends with ${word}`);
  order = [order[5], order[0], order[4], order[1], order[3], order[2]];
}
lines.push('stone river');
lines.push('moon garden');
lines.push('fire bird');

assert.equal(isSestina(lines.join('\n')), true);
assert.deepEqual(analyzeSestina(lines.join('\n')).endWords, ends);
assert.equal(isSestina(lines.slice(0, 38).join('\n')), false);
assert.equal(isSestina(lines.with(7, 'line ends with wrong').join('\n')), false);
assert.equal(isSestina('`' + lines.join('\n') + '`'), false);

console.log('ok');
