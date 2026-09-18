/* ---- class: schools, points, and where skills come from ------------------

   A spell school IS the class. The save carries `asc.school_order` - one or
   two of them, and while one school gives a bonus, two is what people play -
   and `asc.allocated_lvls`, a perk id -> points map covering both schools.

   The key thing that map tells you: POINTS INVESTED IN A SKILL PERK ARE THAT
   SKILL'S RANK. The sample save reads {double_strike: 3, fighter_stance: 1,
   p_health_war: 1} and its spell ranks are exactly {double_strike: 3,
   fighter_stance: 1}. So the Skills tab no longer picks a rank out of the air;
   it reads one off this grid.

   Each grid also holds eight passive perks whose stats scale by the same
   count, `v1 * levels`, so points spent here feed the sheet too.

   The panel is drawn the way the game draws it, on the game's own art, using
   SpellSchoolScreen's own constants (SART.layout). The one that matters is
   `y = originY - perk.y * spacing` - a MINUS, so row 0 sits at the BOTTOM and
   the grid grows upward. Laying it out as a table top-down inverts the tree. */

const SART = __SPELLART__;
const SCHOOLS = SK.schools || {};
const SCHOOL_IDS = Object.keys(SCHOOLS).sort(
  (a, b) => schoolName(a).localeCompare(schoolName(b)));
function schoolName(id) { return nameOf('asc_class', id); }

/* Seeded from the save, then freely editable. */
let classes = ((B.ascendancy || {}).school_order || []).slice(0, 2);
let classAlloc = Object.assign({}, (B.ascendancy || {}).allocated_lvls || {});

/* Perk ids are unique across all twelve schools (checked: zero collisions),
   so one flat id -> school index answers every lookup without walking grids. */
const PERK_SCHOOL = {};
Object.keys(SCHOOLS).forEach(cid => {
  Object.keys(SCHOOLS[cid].perks).forEach(pid => { PERK_SCHOOL[pid] = cid; });
});
const PERK_FOR_SPELL = {};
Object.keys(SCHOOLS).forEach(cid => {
  const ps = SCHOOLS[cid].perks;
  Object.keys(ps).forEach(pid => { if (ps[pid].learn) PERK_FOR_SPELL[ps[pid].learn] = pid; });
});
const perkDef = pid => {
  const cid = PERK_SCHOOL[pid];
  return cid ? SCHOOLS[cid].perks[pid] : null;
};
const inChosenClass = pid => classes.indexOf(PERK_SCHOOL[pid]) >= 0;

/* A perk's row is its level gate. Each school carries `lvl_reqs`, seven
   entries for the seven rows, so row 0 is free at level 1 and row 6 wants 30. */
function perkLevelReq(pid) {
  const cid = PERK_SCHOOL[pid];
  if (!cid) return 1;
  const reqs = SCHOOLS[cid].lvl_reqs || [];
  return reqs[SCHOOLS[cid].perks[pid].y] || 1;
}
const perkLocked = pid => charLevel < perkLevelReq(pid);

/* 164 is the real ceiling a finished character reaches, confirmed in game; the
   registry pool only describes the per-level grant. */
const SPELL_CAP = 164;
const spellBudget = () => SPELL_CAP;
const spellSpent = () => Object.keys(classAlloc).reduce(
  (n, pid) => n + (inChosenClass(pid) ? (classAlloc[pid] || 0) : 0), 0);

/* --- what the class feeds the rest of the planner ------------------------- */

function classContribs() {
  const out = [];
  Object.keys(classAlloc).forEach(pid => {
    const n = classAlloc[pid];
    if (!n || !inChosenClass(pid)) return;
    const p = perkDef(pid);
    if (!p) return;
    if (p.learn) { out.push(['learn_' + p.learn, 'FLAT', n, 'class:' + pid]); return; }
    p.stats.forEach(m => out.push([m.stat, m.type, m.v1 * n, 'class:' + pid]));
  });
  return out;
}
function classRank(spellId) {
  const pid = PERK_FOR_SPELL[spellId];
  if (!pid || !inChosenClass(pid)) return 0;
  return classAlloc[pid] || 0;
}
function setClassRank(spellId, v) {
  const pid = PERK_FOR_SPELL[spellId];
  if (!pid || !inChosenClass(pid)) return false;
  const p = perkDef(pid);
  v = Math.max(0, Math.min(p.max, Math.round(v)));
  if (v) classAlloc[pid] = v; else delete classAlloc[pid];
  return true;
}
function classSpells() {
  const out = new Set();
  Object.keys(classAlloc).forEach(pid => {
    if (!classAlloc[pid] || !inChosenClass(pid)) return;
    const p = perkDef(pid);
    if (p && p.learn) out.add(p.learn);
  });
  return out;
}

/* --- the panel ------------------------------------------------------------ */

/* Passive perks carry no lang entry - `p_armor_pen` is not a name, and it
   grants attack speed anyway - so they are named for what they do, which is
   what the in-game tooltip shows. */
function perkTitle(pid, p) {
  if (p.learn) return spellName(p.learn);
  if (p.stats.length) return label(p.stats[0].stat);
  return titleCase(pid);
}
/* The game ships no description text for a spell - `effect_tip` is empty and
   `manual_tip` is only a flag - so its tooltip is assembled from the spell's
   own mechanics. This builds the same: cost, cast time, cooldown, weapon and
   tags, plus what the perk is worth at the points currently in it. */
/* What one more point in a passive is worth, in DPS.

   A passive is static - it is on the moment you spend the point - so the
   number is honest in a way a buff's is not: Sharpen has to be learned,
   slotted and then maintained before it does anything, and a tooltip claiming
   a flat gain would be lying about all three.

   Cached per perk, and cleared whenever the sheet changes, because hover fires
   on every mouse move. */
const perkDpsCache = new Map();
function clearPerkDps() { perkDpsCache.clear(); }

function perkDpsDelta(pid, p, n) {
  if (typeof dpsUnder !== 'function' || typeof recompute !== 'function') return null;
  if (p.learn || n >= p.max) return null;
  if (perkDpsCache.has(pid)) return perkDpsCache.get(pid);

  let out = null;
  /* Whether the KEY existed matters, not just its value: restoring a missing
     perk to 0 leaves a phantom entry behind, and anything that iterates
     classAlloc would then see a perk the player never touched. */
  const had = Object.prototype.hasOwnProperty.call(classAlloc, pid);
  const was = classAlloc[pid] || 0;
  try {
    const now = dpsUnder(live, null, '');
    if (now) {
      classAlloc[pid] = was + 1;
      const contribs = currentContribs();
      const sheet = recompute(perkList(), contribs, charLevel,
                              typeof auraContribs === 'function' ? auraContribs() : null);
      const then = dpsUnder(sheet, null, 'perk:' + pid, contribs);
      const d = then - now;
      if (Math.abs(d) >= 0.5) out = { d: d, pct: (d / now) * 100 };
    }
  } catch (e) {
    out = null;
  } finally {
    /* Restore before anything else can observe the hypothetical. */
    if (had) classAlloc[pid] = was; else delete classAlloc[pid];
  }
  perkDpsCache.set(pid, out);
  return out;
}

function perkTip(pid, p, n) {
  const rows = [];
  if (p.learn) {
    const sp = (SK.spells || {})[p.learn] || {};
    rows.push(['Rank', n + ' / ' + p.max + (n ? '' : '  (not learned)')]);
    if (n) {
      const links = linksFromRank(n);
      rows.push(['Supports', links + ' of 5' + (links ? '' : '  (1 per 4 ranks)')]);
      const bd = baseDamage(p.learn, n, live);
      if (bd) rows.push(['Base damage', String(bd)]);
    }
    if (sp.mana && sp.mana.max) {
      rows.push(['Mana', round1(sp.mana.min) + '-' + round1(sp.mana.max)]);
    }
    if (sp.energy && sp.energy.max) {
      rows.push(['Energy', round1(sp.energy.min) + '-' + round1(sp.energy.max)]);
    }
    rows.push(['Cast time', ((sp.castTicks || 20) / 20) + 's']);
    if (sp.cooldown) rows.push(['Cooldown', (sp.cooldown / 20) + 's']);
    if (sp.times > 1) rows.push(['Casts', String(sp.times)]);
    if (sp.channel) rows.push(['Channelled', 'yes']);
    if (sp.weapon && sp.weapon !== 'NONE') {
      rows.push(['Weapon', titleCase(String(sp.weapon).toLowerCase())]);
    }
    return {
      head: perkTitle(pid, p), rows: rows,
      tags: (sp.tags || []).filter(t => t !== 'damage'),
      note: 'Points in this perk are the skill\u2019s rank.',
    };
  }
  p.stats.forEach(m => rows.push([label(m.stat),
    valText(m.v1 * (n || 1), m.type) + (n ? '' : ' per point')]));
  rows.push(['Points', n + ' / ' + p.max]);
  const dps = perkDpsDelta(pid, p, n);
  return {
    head: perkTitle(pid, p), rows: rows, tags: [],
    dps: dps,
    note: n >= p.max ? 'Maxed.' : '',
  };
}

function perkLines(pid, p, n) {
  if (p.learn) {
    const links = linksFromRank(n);
    return n ? 'rank ' + n + (links ? ' · ' + links + ' link' +
      (links > 1 ? 's' : '') : '') : 'not learned';
  }
  return p.stats.map(m => valText(m.v1 * (n || 1), m.type) + ' ' + label(m.stat) +
    (n ? '' : ' per point')).join(', ');
}

const SCALE = 1.5;                    /* the panel is 250px wide; 1.5x keeps two
                                         side by side without dominating the tab */
const LAY = SART.layout;
/* The icon atlas is a sibling file rather than a data URI - 296 icons is far
   too much to inline. Source cells are 32px and a socket's icon is 16px drawn
   at SCALE, so the sheet is scaled by SCALE/2. */
const ATLAS_ZOOM = SCALE / 2;
(function atlasVars() {
  const r = document.documentElement.style;
  r.setProperty('--spellatlas', 'url(' + SART.atlas + ')');
  r.setProperty('--atlasw', String(SART.cols * SART.cell * ATLAS_ZOOM));
  r.setProperty('--atlash', String(SART.rows * SART.cell * ATLAS_ZOOM));
})();

/* One school panel.

   The game's own background is deliberately NOT used. Its frame has internal
   padding and decorative sockets that do not line up with the perk coordinates,
   so compositing our sockets over it left the icons visibly off the rows. A
   plain grid drawn to the same coordinates is both cleaner and actually
   aligned - the geometry is still the game's (21px spacing, columns 1-6 for
   skills and 8-9 for passives, y counted upward), only the decoration is ours.

   Rows are laid out by the level that unlocks them, which is what a player is
   really reading when they scan the panel. */
function schoolPanel(cid) {
  const sc = SCHOOLS[cid];
  const ids = Object.keys(sc.perks);
  const spent = ids.reduce((n, p) => n + (classAlloc[p] || 0), 0);
  const reqs = sc.lvl_reqs || [];
  const rows = reqs.length || 7;

  const cell = pid => {
    const p = sc.perks[pid];
    const n = classAlloc[pid] || 0;
    const lock = perkLocked(pid);
    const art = SART.index[pid];
    return '<button class="sock' + (n ? ' on' : '') + (lock ? ' lock' : '') +
      '" data-perk="' + pid + '" style="grid-column:' + p.x +
      ';grid-row:' + (rows - p.y) + '">' +
      (art ? '<i style="background-position:' + (-art[0] * SART.cell * ATLAS_ZOOM) +
        'px ' + (-art[1] * SART.cell * ATLAS_ZOOM) + 'px"></i>' : '') +
      (n ? '<b>' + n + '</b>' : '') + '</button>';
  };

  /* One label per row, in the grid itself, so it cannot drift out of step with
     the icons the way an absolutely positioned rail did. */
  const labels = reqs.map((lv, row) =>
    '<span class="lvl" style="grid-column:1;grid-row:' + (rows - row) + '">' +
    lv + '</span>').join('');

  const portrait = SART.portraits[cid];
  return '<div class="school">' +
    '<div class="shead">' + (portrait ? '<img src="' + portrait + '" alt="">' : '') +
      '<span class="sname">' + schoolName(cid) + '</span>' +
      '<span class="sspent">' + spent + ' pts</span></div>' +
    '<div class="cpanel">' + labels + ids.map(cell).join('') + '</div></div>';
}

function paintClasses() {
  const box = document.getElementById('classpick');
  if (!box) return;

  box.innerHTML = SCHOOL_IDS.map(cid => {
    const sc = SCHOOLS[cid];
    const on = classes.indexOf(cid) >= 0;
    const spent = Object.keys(sc.perks).reduce((n, p) => n + (classAlloc[p] || 0), 0);
    const art = SART.portraits[cid];
    return '<button class="classbtn' + (on ? ' on' : '') + '" data-class="' + cid +
      '" aria-pressed="' + on + '">' +
      (art ? '<img src="' + art + '" alt="">' : '') +
      '<span class="cbt"><b>' + schoolName(cid) + '</b>' +
      '<small>' + sc.spells.length + ' skills' +
      (spent ? ' · ' + spent + ' pts' : '') + '</small></span></button>';
  }).join('');
  box.querySelectorAll('[data-class]').forEach(b => b.onclick = () => {
    const cid = b.dataset.class, at = classes.indexOf(cid);
    if (at >= 0) classes.splice(at, 1);
    else if (classes.length < 2) classes.push(cid);
    else classes = [classes[1], cid];            /* the older pick drops out */
    apply();
  });

  const spent = spellSpent(), budget = spellBudget();
  const pts = document.getElementById('classpts');
  pts.textContent = spent + ' / ' + budget + ' skill points';
  pts.classList.toggle('over', spent > budget);
  pts.title = SPELL_CAP + ' is what a finished character actually has; the ' +
    'registry config only describes the per-level grant.';

  const grids = document.getElementById('classgrids');
  if (!classes.length) {
    grids.innerHTML = '<p class="note">Pick a class above. You may take two, and ' +
      'nearly everyone does — the skills of both become available.</p>';
    return;
  }
  grids.innerHTML = classes.map(schoolPanel).join('');

  /* Left click spends a point, right click refunds one - the game's own
     gesture, and it keeps +/- buttons from covering the artwork. */
  const tipEl = document.getElementById('classtip');
  grids.querySelectorAll('.sock').forEach(b => {
    const pid = b.dataset.perk;
    b.onmouseenter = () => {
      const p = perkDef(pid), n = classAlloc[pid] || 0;
      const t = perkTip(pid, p, n), lock = perkLocked(pid);
      tipEl.innerHTML = '<h5>' + t.head + '</h5>' +
        (t.tags.length ? '<div class="ttags">' + t.tags.map(x =>
          '<span>' + x.replace(/_/g, ' ') + '</span>').join('') + '</div>' : '') +
        /* The DPS change leads, because it is the number that decides where a
           point goes - the stat lines below say why. */
        (t.dps ? '<div class="tipdps ' + (t.dps.d > 0 ? 'up' : 'down') + '">' +
          (t.dps.d > 0 ? '+' : '') + fmt(t.dps.d) + ' DPS <span class="k">' +
          (t.dps.d > 0 ? '+' : '') + (Math.round(t.dps.pct * 100) / 100) +
          '% per point</span></div>' : '') +
        t.rows.map(r => '<div class="trow"><span>' + r[0] + '</span><b>' +
          r[1] + '</b></div>').join('') +
        (lock ? '<div class="tlock">Needs character level ' +
          perkLevelReq(pid) + '</div>' : '') +
        (t.note ? '<div class="tnote">' + t.note + '</div>' : '') +
        '<div class="tnote">Left click adds a point, right click removes one.</div>';
      tipEl.hidden = false;
      /* offsetParent is null for a hidden or unlaid-out element, so the panel
         simply stays where it is rather than throwing. */
      const anchor = tipEl.offsetParent;
      if (anchor) {
        const r = b.getBoundingClientRect(), host = anchor.getBoundingClientRect();
        tipEl.style.left = (r.right - host.left + 8) + 'px';
        tipEl.style.top = Math.max(0, r.top - host.top - 4) + 'px';
      }
    };
    b.onmouseleave = () => { tipEl.hidden = true; };
    b.onclick = () => {
      if (perkLocked(pid)) return;
      const p = perkDef(pid);
      classAlloc[pid] = Math.min(p.max, (classAlloc[pid] || 0) + 1);
      apply();
    };
    b.oncontextmenu = e => {
      e.preventDefault();
      classAlloc[pid] = (classAlloc[pid] || 0) - 1;
      if (classAlloc[pid] <= 0) delete classAlloc[pid];
      apply();
    };
  });
}

document.getElementById('class-reset').onclick = () => {
  classes = ((B.ascendancy || {}).school_order || []).slice(0, 2);
  classAlloc = Object.assign({}, (B.ascendancy || {}).allocated_lvls || {});
  apply();
};
document.getElementById('class-clear').onclick = () => { classAlloc = {}; apply(); };
