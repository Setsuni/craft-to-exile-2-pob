/* ---- custom modifiers ----------------------------------------------------

   A freeform box for "what if I had 5000 more mana". Path of Building has one
   and it is the fastest way to answer a question the item editor would take
   ten clicks to ask.

   One modifier per line, in the game's own words:

       +5000 mana
       1000 health
       +40% spell damage
       25% more physical damage
       -10 mana cost

   The three kinds mirror the game's own: a bare number is FLAT, a percentage
   is an increase (PERCENT), and `more` is its own multiplier (MORE). Anything
   unparseable is reported rather than silently dropped - a typo that quietly
   does nothing is worse than no feature.
*/
const CUSTOM_MODS = { text: '', parsed: [], errors: [] };

/* Stat ids are snake_case; players type English. Match on the lang name first,
   then on the id itself, so both "Spell Damage" and "spell_damage" work. */
let CUSTOM_INDEX = null;
function customIndex() {
  if (CUSTOM_INDEX) return CUSTOM_INDEX;
  const idx = new Map();
  const put = (k, id) => {
    const key = String(k).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (key && !idx.has(key)) idx.set(key, id);
  };
  Object.keys(B.calc.defs || {}).forEach(id => {
    put(id, id);
    put(label(id), id);
  });
  CUSTOM_INDEX = idx;
  return idx;
}

function findStat(words) {
  const key = words.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const idx = customIndex();
  if (idx.has(key)) return idx.get(key);
  /* "cold" is the game's display name for the stat id "water", and a player
     will always type what the tooltip says. */
  const alt = key.replace(/\bcold\b/g, 'water');
  if (idx.has(alt)) return idx.get(alt);
  return null;
}

/* `+40% more physical damage` -> [stat, type, value] */
function parseCustomLine(raw) {
  const line = raw.replace(/\s+/g, ' ').trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;

  const m = line.match(/^([+-]?\d+(?:\.\d+)?)\s*(%?)\s+(.+)$/);
  if (!m) return { error: 'expected a number first, as in "+500 mana"' };

  let value = parseFloat(m[1]);
  const isPct = m[2] === '%';
  let rest = m[3].trim();

  let type = isPct ? 'PERCENT' : 'FLAT';
  /* "more" makes it a multiplier wherever it appears in the phrase, which is
     how the game words it: "25% more physical damage". */
  const more = /\bmore\b/i.test(rest);
  if (more) {
    type = 'MORE';
    rest = rest.replace(/\bmore\b/i, ' ');
  }
  rest = rest.replace(/\b(increased|inc|to|of|your)\b/gi, ' ')
             .replace(/\s+/g, ' ').trim();

  const stat = findStat(rest);
  if (!stat) return { error: 'no stat called "' + rest + '"' };
  if (more && !isPct) type = 'MORE';
  return { stat: stat, type: type, value: value, text: line };
}

function parseCustom(text) {
  const parsed = [], errors = [];
  String(text || '').split('\n').forEach((raw, i) => {
    const r = parseCustomLine(raw);
    if (!r) return;
    if (r.error) errors.push('line ' + (i + 1) + ': ' + r.error);
    else parsed.push(r);
  });
  return { parsed: parsed, errors: errors };
}

/* Fed into the sheet like any other source, so everything downstream - the
   character sheet, the DPS headline, the tree hover deltas - picks them up
   with no special handling. */
function customContribs() {
  return CUSTOM_MODS.parsed.map(m => [m.stat, m.type, m.value, 'custom']);
}

function setCustom(text) {
  CUSTOM_MODS.text = text;
  const r = parseCustom(text);
  CUSTOM_MODS.parsed = r.parsed;
  CUSTOM_MODS.errors = r.errors;
  try { localStorage.setItem('cte2pob.custom', text); } catch (e) { /* no store */ }
  if (typeof applyNow === 'function') applyNow();
  paintCustomNote();
}

function paintCustomNote() {
  const el = document.getElementById('custnote');
  if (!el) return;
  const n = CUSTOM_MODS.parsed.length;
  el.innerHTML =
    (n ? '<span class="up">' + n + ' modifier' + (n === 1 ? '' : 's') + ' applied</span>'
       : '<span class="k">nothing applied yet</span>') +
    (CUSTOM_MODS.errors.length
      ? '<br>' + CUSTOM_MODS.errors.map(e => '<span class="down">' + e + '</span>')
          .join('<br>')
      : '') +
    (n ? '<br>' + CUSTOM_MODS.parsed.map(m =>
          '<span class="k">' + valText(m.value, m.type) + ' ' + label(m.stat) +
          '</span>').join(', ')
       : '');
}

function initCustom() {
  const ta = document.getElementById('custbox');
  if (!ta) return;
  let saved = '';
  try { saved = localStorage.getItem('cte2pob.custom') || ''; } catch (e) { /* none */ }
  ta.value = saved;
  CUSTOM_MODS.text = saved;
  const r = parseCustom(saved);
  CUSTOM_MODS.parsed = r.parsed;
  CUSTOM_MODS.errors = r.errors;
  /* Applied on change rather than on every keystroke: a half-typed stat name
     would flash errors at you as you type it. */
  ta.onchange = () => setCustom(ta.value);
  ta.onblur = () => setCustom(ta.value);
  paintCustomNote();
}

/* Wired after the page exists; paintConfig runs before this file is inlined. */
initCustom();
