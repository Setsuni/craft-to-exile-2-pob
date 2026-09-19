/* ---- skills: loadout, supports and augments ------------------------------
   Laid out the way Path of Building does a socket group: the active skill on
   the left, everything linked to it beneath, and the numbers it produces on
   the right.

   This is the LOADOUT, not the DPS. Base damage per skill is exact already
   (Charged Bomb 220, Bolt 107 both match in game) but the multiplier stack is
   not solved - MORE multipliers live in DamageEvent.getMoreMultis(), a list
   parallel to mmorpg_stat_layer that the engine does not read yet. So each
   slot shows base damage and says plainly that the rest is pending.

   Augment capacity is derived, not guessed: `spirit_cost` is spirit/AuraCapacity
   in the bytecode (base 100, cap 250), each aura reserves `reservation * 100`,
   and a real build with three 0.4 augments reads 120 reserved against 123
   capacity. One sample, so it is labelled as inferred. */
const SK = __SKILLS__;

const spellName = id => nameOf('spell', id);
const gemName = id => nameOf('support_gem', id).replace(/ Support Gem$/, '');
const augName = id => nameOf('aura', id).replace(/\s*Augment$/, '');

/* Start from what the save has, then let the user rearrange it. */
const HOTBAR = SK.hotbarSlots || 8;
const ranks = {};
(B.skills || []).forEach(s => { ranks[s.id] = s.rank; });

/* How a skill is actually used, which decides its rate and whether it counts
   toward the headline at all:

     cast  - pressed on cooldown, the rate model's assumption
     proc  - triggered by something else hitting, at a chance per hit; Fan of
             Knives comes off a boots enchant at 10% on hit and is never cast
     off   - known and slotted, but not part of this rotation

   Everything used to be rated as though it were spammed, which made a proc
   worth nine times its real damage and handed the headline to a skill the
   player never presses. */
const USE = ['cast', 'proc', 'off'];
const loadout = [];
for (let i = 0; i < HOTBAR; i++) {
  loadout.push({ spell: '', supports: [], use: 'cast', procPct: 10 });
}
(B.skills || []).forEach(s => {
  if (s.slot >= 0 && s.slot < HOTBAR) {
    loadout[s.slot] = { spell: s.id, supports: (s.supports || []).slice(0, 5),
                        use: 'cast', procPct: 10 };
  }
});
const augments = (B.auras || []).map(a => ({ id: a.id, perc: a.perc || 100 }));

/* Which skills a character can actually pick. A spell school is a perk grid
   and its spell-granting perks carry `learn_<spell>`, so the list falls out of
   the grid itself. Bolt and the other universal starters are in no school, so
   whatever the save already knows is always allowed. */
/* Skills a character can put in a slot come from three places, and all three
   are real:

     1. the class grids - points in a skill perk both learn it and set its rank
     2. items, uniques and talents - the sample save's staff carries
        `learn_bolt`, which is why Bolt is castable in no school at all
     3. manually, as an escape hatch, so a skill can be evaluated without
        first building a class around it

   (1) and (2) both land on the sheet as a `learn_<spell>` stat - class perks
   through classContribs() - so reading the sheet catches every source at once
   rather than enumerating them. (3) is tracked separately and flagged in the
   UI, because it is a what-if rather than something the character has. */
const manualSpells = new Set();
function knownSpells() {
  const out = new Set();
  Object.keys(SK.spells).forEach(id => {
    if ((live.total('learn_' + id) || 0) > 0) out.add(id);
  });
  return out;
}
let allowCache = null;
function allowedSpells() {
  const out = knownSpells();
  manualSpells.forEach(id => out.add(id));
  return Object.keys(SK.spells).filter(id => out.has(id));
}

const DAMAGE_FIRST = Object.keys(SK.spells).sort((a, b) => {
  const A = SK.spells[a], Bb = SK.spells[b];
  if (A.damage !== Bb.damage) return A.damage ? -1 : 1;
  return spellName(a).localeCompare(spellName(b));
});
const SUPPORT_IDS = Object.keys(SK.supports).sort((a, b) => gemName(a).localeCompare(gemName(b)));
const AUG_IDS = Object.keys(SK.auras).sort((a, b) => augName(a).localeCompare(augName(b)));

/* How many supports a skill can take. SpellCastingData$InsertedSpell:

       gem.setLinks(min(rankBeforePlusSkills / RANKS_PER_SUPPORT_SLOT,
                        SUPPORT_GEMS_PER_SKILL))          // 4 and 5

   so it is the SKILL'S RANK that decides it - one slot per 4 ranks, five at
   most. Rank 1-3 gets none, rank 4 one, rank 20 all five. And note it uses
   rankBeforePlusSkills, so +levels from gear raise the damage but not the
   number of supports.

   GameBalanceConfig.getTotalLinks then clamps that by character level
   (<10 -> 1, <20 -> 2, <30 -> 3, <40 -> 4, else 5), which only bites below
   level 40. Both apply; rank is the one that usually decides. */
const RANKS_PER_SLOT = 4, MAX_SUPPORTS = 5;
function linkCapForLevel(lvl) {
  const L = SK.linkLevels || [1, 10, 20, 30, 40];
  for (let i = 0; i < L.length; i++) if (lvl < L[i]) return i;
  return L.length;
}
function linksFromRank(rank) {
  return Math.min(Math.floor(rank / RANKS_PER_SLOT), MAX_SUPPORTS);
}
function maxLinks(i) {
  const l = loadout[i];
  /* An explicit override exists so a build can be tested past what the rank
     allows; it is flagged in the UI rather than silently pretending. */
  if (l.linkOverride) return Math.min(l.linkOverride, MAX_SUPPORTS);
  return Math.min(linksFromRank(rankOf(i)), linkCapForLevel(charLevel));
}

/* Rank is an input, not something read out of the save: the point of a planner
   is asking what rank 20 would do. The save's rank seeds it. */
function rankOf(i) {
  const l = loadout[i];
  if (!l.spell) return 1;
  /* A class skill's rank IS its perk's point count, so the slider here and the
     grid on the Class tab are two views of one number. Anything else - a skill
     off an item, or one added manually - keeps a local rank. */
  const cr = typeof classRank === 'function' ? classRank(l.spell) : 0;
  if (cr) return cr;
  return (l.rank === undefined || l.rank === null) ? (ranks[l.spell] || 1) : l.rank;
}
/* Where a slotted skill comes from, for the label on its card. */
function spellSource(id) {
  if (typeof classRank === 'function' && classRank(id)) return 'class';
  if ((live.total('learn_' + id) || 0) > 0) return 'gear';
  return manualSpells.has(id) ? 'manual' : '';
}

function gemLines(def, perc) {
  return def.stats.map(m => {
    const lo = IE.exact(m, 0, charLevel).value, hi = IE.exact(m, 100, charLevel).value;
    const v = IE.exact(m, perc === undefined ? 100 : perc, charLevel).value;
    return '<div class="aff"><span class="' + goodBad(m.stat, v) + '">' +
      valText(v, m.type) + '</span> ' + label(m.stat) +
      ' <span class="afspan">' + valText(lo) + '–' + round1(hi, m.type) +
      '</span></div>';
  }).join('');
}

/* The augments the player has slotted, as engine contributions. An aura's
   stats are min/max like an affix and roll with the gem; aura_effect scales
   them, which the engine applies after the tree so talents count. */
function auraContribs() {
  const out = [];
  augments.forEach(a => {
    const d = SK.auras[a.id];
    if (!d) return;
    d.stats.forEach(m => {
      const pct = a.perc === undefined ? 100 : a.perc;
      /* A FLAT aura stat scales with level exactly as an affix does - the
         magic shield aura rolls 25 and grants 520 at level 100. Interpolating
         min/max and stopping there reported the roll instead of the stat, so
         the aura looked like it did almost nothing. */
      const e = IE.exact(m, pct, B.meta.level);
      out.push([e.stat, e.type, e.value, 'aura:' + a.id]);
    });
  });
  return out;
}

/* --- augments ------------------------------------------------------------ */
/* Capacity is the BASE PLUS what you have earned, capped. This used to read
   `total || base`, which used the base only as a fallback when the total was
   zero - so every point of spirit_cost from the tree or a jewel REPLACED the
   base 100 instead of adding to it, and investing in capacity appeared to
   shrink it. */
function capacity() {
  /* The base is part of the spirit_cost stat now, as the game reports it -
     adding it again here would double it. */
  return Math.min(SK.capacity.cap, live.total('spirit_cost') || 0);
}
function reserved() {
  return augments.reduce((n, a) => {
    const d = SK.auras[a.id];
    return n + (d ? d.reservation * SK.capacity.perReservation : 0);
  }, 0);
}

function paintAugments() {
  const cap = capacity(), used = reserved();
  const pct = Math.min(100, cap ? (used / cap) * 100 : 0);
  const over = used > cap;
  document.getElementById('augbar').innerHTML =
    '<div class="capbar"><i style="width:' + pct + '%" class="' + (over ? 'over' : '') +
    '"></i></div>' +
    '<div class="caprow"><span>' + round1(used) + ' reserved of ' + round1(cap) +
    ' capacity</span><span class="' + (over ? 'down' : 'up') + '">' +
    (over ? round1(used - cap) + ' over' : round1(cap - used) + ' free') + '</span></div>';

  document.getElementById('auglist').innerHTML = augments.length
    ? augments.map((a, i) => {
        const d = SK.auras[a.id];
        if (!d) return '';
        return '<div class="card"><h3>' + augName(a.id) +
          '<em>' + round1(d.reservation * SK.capacity.perReservation) + ' spirit</em></h3>' +
          '<div class="sub">' + d.style + ' · from level ' + d.min_lvl +
          ' · rolled ' + a.perc + '%</div>' + gemLines(d, a.perc) +
          '<button class="mini" data-augrm="' + i + '" style="margin-top:7px">Remove</button>' +
          '</div>';
      }).join('')
    : '<p class="note">No augments slotted.</p>';

  document.querySelectorAll('[data-augrm]').forEach(b => b.onclick = () => {
    augments.splice(+b.dataset.augrm, 1); apply();
  });
  const add = document.getElementById('augadd');
  const sig = augments.map(a => a.id).join('|');
  if (add.dataset.sig !== sig) {
    add.dataset.sig = sig;
    add.innerHTML = '<option value="">add an augment…</option>' +
    AUG_IDS.filter(id => !augments.some(a => a.id === id)).map(id =>
      '<option value="' + id + '">' + augName(id) + '  (' +
      round1(SK.auras[id].reservation * SK.capacity.perReservation) + ' spirit)</option>').join('');
  }
  add.onchange = () => {
    if (add.value) { augments.push({ id: add.value, perc: 100 }); apply(); }
  };
}

/* What linking each gem would do to this skill's DPS. Rewrites the option
   labels in place and orders them by how much they actually help - which is
   the question being asked when the list is opened. */
function annotateSupports(sel, i) {
  const l = loadout[i];
  if (!l.spell) return;
  const rank = rankOf(i);
  const now = skillDps(l.spell, rank, l.supports);
  if (!now) return;
  const base = now.dpsMitigated;

  const scored = [];
  for (const opt of sel.options) {
    if (!opt.value) continue;
    const trial = skillDps(l.spell, rank, l.supports.concat([opt.value]));
    const dps = trial ? trial.dpsMitigated : base;
    scored.push({ id: opt.value, name: gemName(opt.value), delta: dps - base });
  }
  scored.sort((a, b) => b.delta - a.delta);

  const pct = d => (base ? (d / base) * 100 : 0);
  const fmtDelta = d => {
    const p = pct(d);
    const sign = d > 0.5 ? '+' : '';
    return Math.abs(d) < 0.5
      ? 'no change'
      : sign + (Math.round(p * 10) / 10) + '%  (' + sign + Math.round(d) + ' dps)';
  };
  /* The select is monospace, so padding lines the numbers up into a column. */
  const width = Math.max.apply(null, scored.map(x => x.name.length).concat([10]));
  sel.innerHTML = '<option value="">link a support\u2026</option>' +
    scored.map(x => '<option value="' + x.id + '">' +
      (x.name + '                                   ').slice(0, width + 2) +
      fmtDelta(x.delta) + '</option>').join('');
}

/* --- the eight slots ----------------------------------------------------- */
function slotCard(i) {
  const l = loadout[i];
  const def = l.spell ? SK.spells[l.spell] : null;
  const allow = allowCache || (allowCache = new Set(allowedSpells()));
  const spellOpts = '<option value="">— empty —</option>' +
    DAMAGE_FIRST.filter(id => allow.has(id) || id === l.spell)
      .map(id => '<option value="' + id + '"' +
      (id === l.spell ? ' selected' : '') + '>' + spellName(id) +
      (SK.spells[id].damage ? '' : ' · utility') + '</option>').join('');

  let body = '<p class="note" style="margin:6px 0 0">Empty slot.</p>';
  if (def) {
    const rank = rankOf(i);
    const sheet = skillSheet(l.supports, l.spell, rank);
    const bonus = bonusLevels(l.spell, sheet);
    const dmg = skillDps(l.spell, rank, l.supports);
    const bd = dmg ? dmg.base : null;
    body =
      '<div class="sub">' +
        (spellSource(l.spell)
          ? '<span class="srcp ' + spellSource(l.spell) + '">' +
            spellSource(l.spell) + '</span> ' : '') + (def.style || '') +
        (def.weapon && def.weapon !== 'NONE' ? ' · ' + def.weapon.toLowerCase() : '') +
        /* The cooldown after reduction is the one that decides your rate;
           the printed base is only useful next to it. */
        (def.cooldown ? ' · ' + (Math.round(
            rateOf(l.spell, sheet).cooldownTicks / 20 * 100) / 100) + 's cd' +
          (cdrPct(def, sheet) > 0.005
            ? ' (' + (def.cooldown / 20) + 's −' +
              (Math.round(cdrPct(def, sheet) * 10) / 10) + '%)' : '') : '') +
        '</div>' +
      '<div class="rankrow"><label>Rank</label>' +
        '<input type="range" data-rank="' + i + '" min="1" max="' +
        (def.max_lvl || 20) + '" value="' + rank + '" aria-label="Rank">' +
        '<b>' + rank + '/' + (def.max_lvl || '?') +
        (bonus ? '<span class="plus">+' + bonus + '</span>' : '') + '</b></div>' +
      (def.tags.length
        ? '<div class="tagrow">' + def.tags.map(t => '<span class="ttag">' + t.replace(/_/g, ' ') +
          '</span>').join('') + '</div>' : '') +
      (bd !== null
        ? '<div class="big">' + bd + ' <span class="bdlab">base damage</span></div>' +
          (dmg ? '<div class="dmgline"><span class="k">average hit</span><span class="n">' +
            Math.round(dmg.average) + '</span></div>' +
            '<div class="dmgline"><span class="k">DPS vs ' + enemyDef().name + '</span><span class="n">' +
            Math.round(dmg.dpsMitigated) + '</span></div>' : '')
        : def.damage
          ? '<p class="note" style="margin:5px 0 0">Has a damage formula; not in this save so no rank to evaluate at.</p>'
          : '<p class="note" style="margin:5px 0 0">Utility skill, no damage formula.</p>') +
      '<p class="note">DPS assumes resources remain available; sustained casting and proc affordability are not yet simulated.</p>' +
      '<div class="userow"><label for="use' + i + '">Used</label>' +
        '<select id="use' + i + '" data-use="' + i + '">' +
        USE.map(u => '<option value="' + u + '"' +
          (u === (l.use || 'cast') ? ' selected' : '') + '>' +
          (u === 'cast' ? 'cast on cooldown'
           : u === 'proc' ? 'proc on hit' : 'not used') +
          '</option>').join('') + '</select>' +
        ((l.use === 'proc')
          ? '<input type="number" data-procpct="' + i + '" min="0.1" max="100" ' +
            'step="0.1" value="' + (l.procPct === undefined ? 10 : l.procPct) +
            '" aria-label="Proc chance per hit"><span>% per hit' +
            (def.procCooldown
              ? ', then locked out for ' + (def.procCooldown / 20) + 's'
              : '') + '</span>'
          : '<span>' + (l.use === 'off'
              ? 'excluded from the damage headline'
              : 'rate comes from cast speed and cooldown') + '</span>') +
      '</div>' +
      '<div class="linkhd">Supports <em>' + l.supports.length + '/' + maxLinks(i) +
        '</em></div>' +
      '<div class="linkcap"><label>Override</label>' +
        '<input type="number" data-links="' + i + '" min="0" max="5" value="' +
        (l.linkOverride || 0) + '">' +
        '<span>' + (l.linkOverride
          ? 'forced, rank ' + rankOf(i) + ' would give ' + linksFromRank(rankOf(i))
          : 'rank ' + rankOf(i) + ' \u2192 ' + linksFromRank(rankOf(i)) +
            ' (1 per ' + RANKS_PER_SLOT + ' ranks)') + '</span></div>' +
      l.supports.map((g, gi) => {
        const gd = SK.supports[g];
        /* name | mana | remove, laid out as one row. The button used to be
           floated with a negative margin and sat on top of the mana text. */
        return '<div class="linkrow"><div class="ln">' +
          '<span class="gn">' + gemName(g) + '</span>' +
          (gd ? '<em>mana ×' + gd.manaMulti + '</em>' : '<em></em>') +
          '<button class="rm" data-rm="' + i + ':' + gi +
          '" aria-label="Unlink ' + gemName(g) + '">×</button></div>' +
          (gd ? gemLines(gd) : '') + '</div>';
      }).join('') +
      (l.supports.length < maxLinks(i)
        ? '<select class="addsup" data-add="' + i + '" aria-label="Link a support gem">' +
          '<option value="">link a support…</option>' +
          SUPPORT_IDS.filter(g => l.supports.indexOf(g) < 0).map(g =>
            '<option value="' + g + '">' + gemName(g) + '</option>').join('') +
          '</select>'
        : '');
  }

  return '<div class="card slotcard"><h3>Slot ' + (i + 1) + '</h3>' +
    '<select class="spellsel" data-slot="' + i + '" aria-label="Skill in slot ' + (i + 1) +
    '">' + spellOpts + '</select>' + body + '</div>';
}

/* The line above the slots: where the available skills came from, and the
   manual override for evaluating a skill the character has not actually
   earned. Kept deliberately - the point of a planner is asking what a skill
   would do before committing points to it. */
function paintSkillSource() {
  const el = document.getElementById('skillsrc');
  if (!el) return;
  const cls = typeof classSpells === 'function' ? classSpells() : new Set();
  let gear = 0;
  knownSpells().forEach(id => { if (!cls.has(id)) gear++; });
  const bits = ['<b>' + cls.size + '</b> from your class' +
    (typeof classes !== 'undefined' && classes.length
      ? ' (' + classes.map(schoolName).join(' + ') + ')' : '')];
  if (gear) bits.push('<b>' + gear + '</b> from gear and talents');
  if (manualSpells.size) bits.push('<b>' + manualSpells.size + '</b> added manually');
  el.innerHTML = bits.join(' \u00b7 ') + (cls.size ? ''
    : ' \u2014 spend points on the <b>Class</b> tab to learn skills.');

  /* 430-odd options is 20ms of string building, and the list is only ever
     looked at when the box is opened - so fill it then, the same way the
     support gems are priced on demand. */
  const add = document.getElementById('manualadd');
  if (!add) return;
  add.dataset.filled = '';
  add.innerHTML = '<option value="">add a skill manually\u2026</option>';
  const fill = () => {
    if (add.dataset.filled === '1') return;
    add.dataset.filled = '1';
    const have = new Set(allowedSpells());
    add.innerHTML = '<option value="">add a skill manually\u2026</option>' +
      DAMAGE_FIRST.filter(id => !have.has(id)).map(id =>
        '<option value="' + id + '">' + spellName(id) +
        (SK.spells[id].damage ? '' : ' \u00b7 utility') + '</option>').join('');
  };
  add.onmousedown = fill;
  add.onfocus = fill;
  add.onchange = () => { if (add.value) { manualSpells.add(add.value); apply(); } };
}

/* A skill triggered by an enchant announces itself: the boots carry
   `proc_fan_of_knives_on_hit`, whose value IS the chance per hit (rolled
   10-30). So the rotation seeds itself from the character rather than making
   the player tell the planner what their own gear already says.

   Run once, and only once the sheet exists - and never overriding a choice
   the player has since made. */
let usageSeeded = false;
function seedUsage() {
  if (usageSeeded || typeof live === 'undefined' || !live) return;
  usageSeeded = true;
  loadout.forEach(l => {
    if (!l.spell) return;
    const pct = live.total('proc_' + l.spell + '_on_hit') || 0;
    if (pct > 0.005) { l.use = 'proc'; l.procPct = Math.round(pct * 10) / 10; }
  });
}

function paintSkills() {
  seedUsage();
  allowCache = null;               // recompute once per repaint, not per card
  paintSkillSource();
  document.getElementById('skills').innerHTML =
    loadout.map((_, i) => slotCard(i)).join('');
  paintAugments();

  const root = document.getElementById('skills');
  root.querySelectorAll('.spellsel').forEach(sel => sel.onchange = () => {
    loadout[+sel.dataset.slot].spell = sel.value;
    if (!sel.value) loadout[+sel.dataset.slot].supports = [];
    paintSkills();
  });
  root.querySelectorAll('.addsup').forEach(sel => {
    sel.onchange = () => {
      if (sel.value) { loadout[+sel.dataset.add].supports.push(sel.value); apply(); }
    };
    /* Price every gem the moment the list is opened, not before: 90 gems x 8
       slots on every repaint would be 43ms, this is ~5ms once. */
    const price = () => {
      if (sel.dataset.priced === '1') return;
      sel.dataset.priced = '1';
      annotateSupports(sel, +sel.dataset.add);
    };
    sel.onmousedown = price;
    sel.onfocus = price;
  });
  root.querySelectorAll('[data-use]').forEach(sel => sel.onchange = () => {
    loadout[+sel.dataset.use].use = sel.value;
    apply();
  });
  root.querySelectorAll('[data-procpct]').forEach(n => n.onchange = () => {
    loadout[+n.dataset.procpct].procPct =
      Math.max(0.1, Math.min(100, +n.value || 10));
    apply();
  });
  root.querySelectorAll('[data-links]').forEach(n => n.onchange = () => {
    const i = +n.dataset.links;
    loadout[i].linkOverride = Math.max(0, Math.min(5, +n.value || 0));
    loadout[i].supports = loadout[i].supports.slice(0, maxLinks(i));
    apply();
  });
  root.querySelectorAll('[data-rank]').forEach(r => {
    const i = +r.dataset.rank;
    const max = (SK.spells[loadout[i].spell] || {}).max_lvl || '?';
    bindSlider(r, v => {
      /* Writing back into the grid keeps one number, not two that drift. */
      if (!(typeof setClassRank === 'function' && setClassRank(loadout[i].spell, v))) {
        loadout[i].rank = v;
      }
      apply();
    }, v => v + '/' + max);
  });
  root.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    const [i, gi] = b.dataset.rm.split(':').map(Number);
    loadout[i].supports.splice(gi, 1);
    apply();
  });
}
/* No eager paint here: the class grid decides which skills exist and it is
   defined after this file, so the first paint is the init apply() at the
   bottom of the page. */
