/* Resource conversions against hand-calculated totals from MnS's final-stat
 * semantics. The same cases run through Python in test_resources.py. */
const assert = require('node:assert/strict');
const { makeEngine } = require('./engine');
const cases = [
  { name:'same-priority conversions read a snapshot and bypass target multipliers',
    mods:[['health','FLAT',100],['health','PERCENT',100],['magic_shield','FLAT',100],
      ['magic_shield','PERCENT',100],['magic_shield','MORE',50],['mana','FLAT',50],['mana','PERCENT',100],
      ['hp_ms','FLAT',50],['ms_mana','FLAT',50],['mana_ms','FLAT',5],['mana_phys','FLAT',6]],
    derived:[['hp_ms','health','magic_shield',25],['ms_mana','magic_shield','mana',25],
      ['mana_ms','mana','magic_shield',25],['mana_phys','mana','flat_physical_added_damage',50]],
    expected:{health:200,magic_shield:405,mana:250,flat_physical_added_damage:15} },
  { name:'whole-unit feeders run last and add final values even with perc metadata',
    mods:[['mana','FLAT',109],['armor','FLAT',10],['armor','PERCENT',100],['mana_armor','FLAT',2],
      ['mana_more','FLAT',10],['energy','FLAT',100]],
    derived:[['mana_armor','mana','armor',0,'more_x_per_y',10],['mana_more','energy','mana',25]],
    expected:{mana:119,armor:42} },
  { name:'final additions respect hard caps', mods:[['mana','FLAT',100],['shield','FLAT',100],['convert','FLAT',100]],
    derived:[['convert','mana','shield',25]],limits:{shield:{max:150}},expected:{shield:150} },
];
function calcFor(test) {
  const defs = Object.fromEntries(test.mods.map(([id])=>[id,{more:1}]));
  Object.entries(test.limits||{}).forEach(([id,limits])=>Object.assign(defs[id],limits));
  return { defs, scalings:{}, baseProfile:[],nodeMods:{},auraMods:[],attrRules:[],core:{},elements:[],
    derived:test.derived.map(([id,from,to,priority,ser='one_to_other',per=1])=>({id,from,to,priority,ser,per,perc:true})) };
}
if (process.argv.includes('--cases')) console.log(JSON.stringify(cases));
else {
  for (const test of cases) {
    for (const reverse of [false,true]) {
      const calc = calcFor(test);
      if(reverse) calc.derived.reverse();
      const sheet = makeEngine(calc)([],test.mods.map(m=>[...m,'test']),1,[]);
      for(const [id,value] of Object.entries(test.expected)) assert.equal(sheet.total(id),value,test.name+': '+id);
    }
    console.log('PASS '+test.name);
  }
}
