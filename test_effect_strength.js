const assert = require('node:assert/strict');
const { makeEngine, effectStrengthMultiplier } = require('./engine');
const defs = Object.fromEntries(['damage','mana','inc_effect_of_positive_buff_given',
  'inc_effect_of_positive_buff_on_you','inc_effect_of_song_buff_given',
  'inc_effect_of_negative_buff_on_you','aura_effect'].map(k => [k, {more:1}]));
const calc = {defs,scalings:{},baseProfile:[],nodeMods:{strength:[
  ['inc_effect_of_positive_buff_given','FLAT',20,false]]},
  auraMods:[],attrRules:[],core:{},elements:[],derived:[]};
const base = [['inc_effect_of_positive_buff_given','FLAT',16.6,'gear'],
  ['inc_effect_of_positive_buff_on_you','FLAT',10,'gear'],
  ['inc_effect_of_song_buff_given','FLAT',25,'gear'],
  ['inc_effect_of_negative_buff_on_you','FLAT',99,'gear'],
  ['aura_effect','FLAT',50,'gear']];
const buff = ['damage','FLAT',100,'buff:song',{effectTags:['positive','song']}];
for(const rows of [[buff,...base],[...base,buff]]) {
  const sheet = makeEngine(calc)(['strength'],rows,100,[['mana','FLAT',100,'aura:test']]);
  assert.ok(Math.abs(sheet.total('damage') - 171.6) < 1e-9);
  assert.equal(sheet.total('mana'),150, 'aura scaling remains separate');
  assert.equal(effectStrengthMultiplier(sheet,['negative'],false),1,
    'player on-you penalties must not scale enemy debuffs');
  const edited = makeEngine(calc)([],rows,100,[]);
  assert.ok(Math.abs(edited.total('damage') - 151.6) < 1e-9,
    'removing a perk updates buff strength immediately');
}
assert.equal(effectStrengthMultiplier({total:()=>0},[]),1);
console.log('PASS tagged buffs combine matching source/recipient bonuses, respect edits, and leave auras separate');
