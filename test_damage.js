/* Controlled damage cases with the real damage registry and support path.
 * Run: node test_damage.js. Browser integration is covered in test_builds.js. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const registry = require('./out214/damage_map.json');
const skills = require('./out214/skills.json');
const source = fs.readFileSync('ui/damage.js', 'utf8').replace('__DMGMAP__', JSON.stringify(registry));
let checks = 0;
const layerTable = (JSON.parse(
  require('fs').readFileSync('out214/damage_map.json', 'utf8')).layers) || {};

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}
function setup(values = {}, mores = {}) {
  const context = vm.createContext({ console, values, mores, supports: skills.supports,
    layerTable });
  vm.runInContext(`
    /* The real layer table, not a stub: the clamps are pack data and the
       engine reads them, so a test that invented its own would prove nothing
       about the game. */
    const B = {calc:{}, layers: layerTable};
    const CAT = {bases:{},uniques:{}};
    const custom = {};
    const titleCase = s => s;
    let charLevel = 1;
    const loadout = [{spell:'test',supports:[]}];
    const rankOf = () => 20;
    const dpsFocus = 'test';
    const SK = {maxBonusLevels:8,plusByTag:{all:'plus_lvl_all_spells'},supports,
      spells:{test:{max_lvl:20,tags:['physical','weapon_skill'],style:'str',castTicks:19,castTime:0,
        dmgEffectiveness:{min:1,max:1}}},
      calc:{test:{base:{min:100,max:100},scalings:[]}},globalCooldownTicks:2};
    function sheet(v, m = {}) {return {total:k=>v[k]||0,moreOf:k=>m[k]===undefined?1:m[k]};}
    let live = sheet(values, mores);
    const currentContribs = () => [];
    const perkList = () => [];
    const auraContribs = () => [];
    function recompute(perks, mods) {
      const v = {...values}, m = {...mores};
      for (const [stat,kind,n] of mods) {
        if (kind === 'MORE') m[stat] = (m[stat]===undefined?1:m[stat])*(1+n/100);
        else v[stat] = (v[stat]||0)+n;
      }
      return sheet(v,m);
    }
  ` + source, context);
  vm.runInContext("cfg.enemy='naked'", context);
  return { e: code => vm.runInContext(code, context), result: (rank = 20, gems = []) =>
    vm.runInContext(`skillDps('test',${rank},${JSON.stringify(gems)})`, context) };
}
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }

test('flat damage is added once before conversion and destination multipliers', () => {
  const c = setup({flat_physical_added_damage:20, phys_to_fire:50,
    all_physical_damage:100, all_fire_damage:200});
  const d = c.result();
  near(d.effectiveBase,120); near(d.average,300); near(d.dps,300);
  near(d.parts[0].base,60); near(d.parts[1].base,60);
});
test('full conversion leaves zero physical damage and changes the headline', () => {
  const c = setup({flat_physical_added_damage:20,phys_to_fire:100,all_fire_damage:200});
  const d = c.result();
  near(d.parts[0].average,0); near(d.average,360);
  near(d.dpsMitigated,360);
});
test('conversion over 100 percent is normalized', () => {
  const d = setup({flat_physical_added_damage:20,phys_to_fire:80,phys_to_water:80}).result();
  near(d.parts[0].base,0); near(d.parts[1].base,60); near(d.parts[2].base,60);
  near(d.average,120);
});
test('extra physical damage reaches the headline without repeating flat damage', () => {
  const d = setup({flat_physical_added_damage:20,plus_phys_to_chaos:40}).result();
  near(d.parts[1].base,48); near(d.average,168);
});
test('extra uses remaining physical after conversion, as in layer priorities 1 and 2', () => {
  const c = setup({flat_physical_added_damage:20,phys_to_fire:50,plus_phys_to_chaos:40});
  near(c.result().parts.find(p=>p.extra).base,24);
  near(c.result().average,144);
  c.e('values.phys_to_fire=100');
  near(c.result().average,120);
  assert.equal(c.result().parts.some(p=>p.extra),false);
});
test('flat elemental additions are independent bonus hits without a second flat layer', () => {
  const d = setup({flat_physical_added_damage:20,flat_fire_added_damage:10}).result();
  near(d.parts[1].base,10); near(d.average,130);
});
test('base and flat damage use the same effective skill rank, including its cap', () => {
  const c = setup({flat_physical_added_damage:28,plus_lvl_all_spells:8});
  c.e('SK.spells.test.dmgEffectiveness={min:1,max:2}');
  near(c.result(20).flatLayer,56); near(c.result(40).flatLayer,56);
  near(c.result(1).flatLayer,37);
});
test('each elemental portion uses its own resistance', () => {
  const c = setup({phys_to_fire:50});
  c.e("enemyDef=()=>({phys:10,res:50,armourMit:0})");
  near(c.result().dpsMitigated,70);
});
test('elemental penetration supports affect their skill without changing global stats', () => {
  const c = setup();
  c.e("SK.spells.test.tags=['fire','weapon_skill'];enemyDef=()=>({phys:0,res:50,armourMit:0})");
  near(c.result().dpsMitigated,50);
  near(c.result(20,['fire_pene']).dpsMitigated,68);
  near(c.e("live.total('fire_penetration')"),0);
  near(c.result().dpsMitigated,50);
});
test('armor penetration supports affect the armor curve', () => {
  const c = setup();
  c.e('enemyDef=()=>({phys:0,res:0,armour:100})');
  near(c.result().dpsMitigated,50);
  near(c.result(20,['physical_pene']).dpsMitigated,100*100/191);
});
test('destination MORE modifiers can suppress converted damage entirely', () => {
  const d = setup({phys_to_fire:100}, {all_elemental_damage:0}).result();
  near(d.average,0); near(d.dpsMitigated,0);
  assert.ok(Number.isFinite(d.dps));
});
test('crit branches are averaged per portion and the breakdown sums to the headline', () => {
  const c = setup({phys_to_fire:50,critical_hit:50,critical_damage:100});
  const d = c.result();
  near(d.average,150); near(d.nonCrit,100); near(d.allCrit,200);
  /* Was damageSplit(), a one-line wrapper that existed only for this line.
     skillDps().parts is the same value from the real API. */
  near(c.e("skillDps('test',20,[]).parts.reduce((s,p)=>s+p.dps,0)"),d.dps);
  near(d.parts.reduce((s,p)=>s+p.dpsMitigated,0),d.dpsMitigated);
});
test('bonus bases and conversion percentages follow the game integer casts', () => {
  const d = setup({phys_to_fire:33.9,flat_physical_added_damage:1}).result();
  near(d.parts[1].percent,33); near(d.parts[1].base,33);
  near(d.parts[0].base,67.67);
});
test('hypothetical comparisons use the same routed DPS and restore the live sheet', () => {
  const c = setup({phys_to_fire:100,all_fire_damage:100});
  near(c.e("dpsUnder(live,[],'test',[])"),c.result().dpsMitigated);
  near(c.e("dpsUnder(sheet({phys_to_fire:100,all_fire_damage:200}),[],'other',[])"),300);
  near(c.result().dpsMitigated,200);
});

// Timing fixtures follow Spell/SpellCastingData in installed 6.4.13.
test('cast duration and recovery are sequential and rounded to ticks', () => {
  const c=setup();
  c.e("SK.spells.test.castTicks=20;SK.spells.test.castTime=10;SK.spells.test.cooldown=40");
  near(c.e("rateOf('test').ticks"),50);
  c.e("SK.spells.test.castTime=0;SK.spells.test.cooldown=0");
  near(c.e("rateOf('test').ticks"),21);
});
test('held channels repeat on cast time without recovery', () => {
  const c=setup();c.e("SK.spells.test.channel=true;SK.spells.test.castTime=10;SK.spells.test.cooldown=80");
  near(c.e("rateOf('test').ticks"),10);
});
test('projectile bonuses are whole projectiles; chaining assumption stays single target', () => {
  const c=setup({projectile_count:4.44});
  c.e("SK.spells.test.tags.push('projectile')");near(c.e("rateOf('test').projectiles"),5);
  c.e("SK.spells.test.tags.push('chaining')");near(c.e("rateOf('test').projectiles"),1);
});

console.log('\n' + checks + ' damage checks passed');

/* The damage layers carry clamps, and the clamps change results.
 * `StatLayerData.getMultiplier()` is clamp(1 + num/100, min_multi, max_multi),
 * and the table is read from the pack rather than hardcoded. */
test('layer multipliers are clamped to the layer table', () => {
  const c = setup({});
  /* double_damage declares min == max == 2, so ANY non-zero number gives
     exactly two - a 1% chance and a 500% one produce the same multiplier
     once the layer fires. */
  near(c.e("layerMulti('double_damage', 1)"), 2);
  near(c.e("layerMulti('double_damage', 500)"), 2);
  /* The mitigation layers floor at 0.1: nothing takes more than 90% off. */
  near(c.e("layerMulti('elemental_mitigation', -200)"), 0.1);
  near(c.e("layerMulti('armor_mitigation', -95)"), 0.1);
  /* Suppression spans 0.5 to 1. */
  near(c.e("layerMulti('damage_suppression', -90)"), 0.5);
  near(c.e("layerMulti('damage_suppression', 50)"), 1);
  /* An unclamped layer is left alone. */
  near(c.e("layerMulti('additive_damage', 264)"), 3.64);
  /* An unknown layer must not throw or invent a clamp. */
  near(c.e("layerMulti('not_a_layer', 100)"), 2);
});

test('double attack chance reaches the hit', () => {
  const none = setup({}).result().average;
  const half = setup({double_attack_chance: 50}).result().average;
  const full = setup({double_attack_chance: 100}).result().average;
  /* Expected value: 1 + p x (2 - 1). Half the hits doubled is 1.5x. */
  near(half / none, 1.5);
  near(full / none, 2);
});
