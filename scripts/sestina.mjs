const ORDER = [5, 0, 4, 1, 3, 2];

export function analyzeSestina(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not_text', endWords: [] };
  if (/```|`/.test(text)) return { ok: false, reason: 'code', endWords: [] };

  const lines = stripSlackNoise(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 39) return { ok: false, reason: 'line_count', lines: lines.length, endWords: [] };

  const endWords = lines.slice(0, 36).map(lastWord);
  if (endWords.some((word) => !word)) return { ok: false, reason: 'missing_end_word', lines: lines.length, endWords };
  const first = endWords.slice(0, 6);
  if (new Set(first).size !== 6) return { ok: false, reason: 'repeated_first_stanza_end_word', lines: lines.length, endWords: first };

  let expected = first;
  for (let stanza = 0; stanza < 6; stanza++) {
    const actual = endWords.slice(stanza * 6, stanza * 6 + 6);
    if (!sameWords(actual, expected)) return { ok: false, reason: 'rotation', stanza: stanza + 1, expected, actual, endWords: first };
    expected = ORDER.map((index) => expected[index]);
  }

  const envoi = lines.slice(36).join(' ').toLowerCase();
  const missingEnvoi = first.filter((word) => !new RegExp(`\\b${escapeRegex(word)}\\b`, 'i').test(envoi));
  return { ok: missingEnvoi.length === 0, reason: missingEnvoi.length ? 'envoi_missing_end_words' : undefined, lines: lines.length, endWords: first, missingEnvoi };
}

export function isSestina(text) {
  return analyzeSestina(text).ok;
}

export function cleanDisplayText(text) {
  return stripSlackNoise(text).replace(/[ \t]{2,}/g, ' ').trim();
}

function lastWord(line) {
  return (line.toLowerCase().match(/[a-z]+(?:'[a-z]+)?(?=[^a-z']*$)/) ?? [''])[0];
}

function sameWords(a, b) {
  return a.length === b.length && a.every((word, index) => word === b[index]);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripSlackNoise(text) {
  return text
    .replace(/<[a-z][a-z0-9+.-]*:\/\/[^>]*>/gi, ' ')
    .replace(/<[^>\s|]+\|[^>]*>/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/<[@#!][A-Z0-9][^>]*>/g, ' ')
    .replace(/<![^>]+>/g, ' ')
    .replace(/(^|\n)>\s?/g, '$1')
    .replace(/[*_~]/g, '');
}
