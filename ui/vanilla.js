/* ---- vanilla and modded gear -------------------------------------------
   Mine & Slash does not ignore a Botania chestplate. `mmorpg_stat_compat`
   converts vanilla item ATTRIBUTES into sheet stats, which is why crafting on
   Terrasteel or a Twilight Forest base is not cosmetic.

   StatCompat.getResult reads LivingEntity.getAttributeValue - the ENTITY total
   across everything worn - and converts once:

       int v = (int)(total * conversion);
       v = clamp(v, minimum_cap, maximum_cap);
       if (v != 0) v = (int) scaling.scale(v, level);

   Converting per item and summing is NOT equivalent, and the difference is not
   academic: a Terrasteel chestplate is 8 armour, 8 * 0.1 = 0.8, which truncates
   to ZERO on its own. The full set is 20 armour, which converts to 2. So a
   per-item number would tell you Terrasteel does nothing, which is wrong.

   Hence the basket: tick the pieces you would wear, and the panel pools the
   attributes first and converts once, the way the game does.

   Attributes with no conversion rule - knockback resistance, attack speed - are
   marked: they still work in game, they just never reach the MnS sheet. */
const VAN = __VANILLA__;

const attrShort = a => String(a).replace(/^.*[.:]/, '').replace(/_/g, ' ');
const modOf = id => String(id).split(':')[0];
const itemName = id => String(id).split(':')[1].replace(/_/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase());

/* LevelScalingConfig.getMultiFor, as used by the compat scaling field. */
function vanMulti(scaling, level) {
  const c = CAT.scalings[scaling];
  if (!c) return 1;
  const lvl = c.cap ? Math.max(1, Math.min(level, CAT.maxLevel || 100)) : level;
  return c.base + c.per_level * (lvl - 1);
}

function convert(rule, total, level) {
  let v = Math.trunc(total * rule.conv);
  v = Math.max(rule.min_cap, Math.min(v, rule.max_cap));
  if (v) v = Math.trunc(vanMulti(rule.scaling, level) * v);
  return v;
}

const VAN_IDS = Object.keys(VAN.items).sort();
const basket = new Set();

function paintBasket() {
  const level = B.meta.level;
  const el = document.getElementById('van-basket');
  if (!basket.size) {
    el.innerHTML = '<p class="note" style="margin:0">Tick pieces to pool their attributes. ' +
      'Conversion happens once on the total, so a single piece can convert to nothing ' +
      'while a full set converts to something.</p>';
    return;
  }
  const totals = {};
  basket.forEach(key => {
    const [id, sl] = key.split('@');
    const mp = VAN.items[id][sl] || {};
    Object.keys(mp).forEach(a => { totals[a] = (totals[a] || 0) + mp[a]; });
  });
  const lines = Object.keys(totals).sort().map(a => {
    const ruleIds = VAN.byAttr[a] || [];
    if (!ruleIds.length) {
      return '<div class="vanrow dead"><span class="a">' + attrShort(a) + ' total ' +
        round1(totals[a]) + '</span><span class="b">vanilla only, never on the sheet</span></div>';
    }
    const out = ruleIds.map(r => {
      const rule = VAN.rules[r];
      const v = convert(rule, totals[a], level);
      const raw = totals[a] * rule.conv;
      return (v > 0 ? '+' : '') + v + (rule.mod === 'PERCENT' ? '%' : '') + ' ' +
        label(rule.stat) + (v === 0 && raw > 0
          ? ' <span class="afspan">(' + round1(raw) + ' before truncation)</span>' : '');
    }).join(', ');
    return '<div class="vanrow"><span class="a">' + attrShort(a) + ' total ' +
      round1(totals[a]) + '</span><span class="b">' + out + '</span></div>';
  }).join('');
  el.innerHTML = '<h4 style="margin:0 0 6px;font-size:10px;letter-spacing:.14em;' +
    'text-transform:uppercase;color:var(--gold2);border-bottom:1px solid var(--rule);' +
    'padding-bottom:4px">Pooled: ' + basket.size + ' pieces</h4>' + lines +
    '<button class="mini" id="van-clear" style="margin-top:8px">Clear</button>';
  document.getElementById('van-clear').onclick = () => { basket.clear(); paintVanilla(); };
}

function paintVanilla() {
  const q = document.getElementById('q-van').value.trim().toLowerCase();
  const slotWant = document.getElementById('van-slot').value;
  const level = B.meta.level;

  const hits = VAN_IDS.filter(id => {
    if (q && id.toLowerCase().indexOf(q) < 0) return false;
    if (slotWant && !VAN.items[id][slotWant]) return false;
    return true;
  });
  document.getElementById('van-count').textContent =
    hits.length + ' of ' + VAN_IDS.length + ' items · converted at character level ' + level;

  const shown = hits.slice(0, 120);
  document.getElementById('van-list').innerHTML = shown.map(id => {
    const slots = VAN.items[id];
    const body = Object.keys(slots).map(sl => {
      const rows = Object.keys(slots[sl]).map(a => {
        const amount = slots[sl][a];
        const ruleIds = VAN.byAttr[a] || [];
        if (!ruleIds.length) {
          return '<div class="vanrow dead"><span class="a">' + attrShort(a) + ' ' +
            (amount > 0 ? '+' : '') + amount + '</span>' +
            '<span class="b">vanilla only</span></div>';
        }
        /* Deliberately the pre-truncation figure: this piece's share of a
           total that is converted once, not a value it grants on its own. */
        const out = ruleIds.map(r => {
          const rule = VAN.rules[r];
          return '×' + rule.conv + ' → ' + round1(amount * rule.conv) + ' ' +
            label(rule.stat);
        }).join(', ');
        return '<div class="vanrow"><span class="a">' + attrShort(a) + ' ' +
          (amount > 0 ? '+' : '') + amount + '</span><span class="b">' + out + '</span></div>';
      }).join('');
      const key = id + '@' + sl;
      return '<div class="aff"><u>' + sl + '</u>' +
        '<label class="vanpick"><input type="checkbox" data-key="' + key + '"' +
        (basket.has(key) ? ' checked' : '') + '> pool</label></div>' + rows;
    }).join('');
    return '<div class="card"><h3>' + itemName(id) +
      '<em class="modtag">' + modOf(id) + '</em></h3>' +
      '<div class="sub">' + id + '</div>' + body + '</div>';
  }).join('') || '<p class="note">Nothing matches that filter.</p>';

  document.querySelectorAll('#van-list input[data-key]').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) basket.add(cb.dataset.key); else basket.delete(cb.dataset.key);
      paintBasket();
    };
  });
  paintBasket();

  if (hits.length > shown.length) {
    document.getElementById('van-list').insertAdjacentHTML('beforeend',
      '<p class="note">Showing the first ' + shown.length + '. Narrow the filter to see the rest.</p>');
  }
}
document.getElementById('q-van').oninput = paintVanilla;
document.getElementById('van-slot').onchange = paintVanilla;
paintVanilla();
