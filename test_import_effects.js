/* Synthetic import/effect cases; no player data is embedded in this test. */
const prefix = require('fs').readFileSync('test_builds.js','utf8').split('(async () => {')[0];
eval(prefix + `
(async () => {
  const p=page();
  p.e("rawEffectRoot={ForgeCaps:{'mmorpg:player_data':{},'mmorpg:entity_data':{statuses:JSON.stringify({exileMap:{ritual_of_plague:{spell_id:'blasphemous_ritual',stacks:1}}})}}};effectFixture=IMPORTER.read(rawEffectRoot)");
  assert.deepEqual(p.json('effectFixture.statusEffects'),{ritual_of_plague:{spell:'blasphemous_ritual',stacks:1}});
  p.e("IMPORTER.apply(effectFixture);charLevel=100;classes=['sanguimancer'];classAlloc={blasphemous_ritual:12};applyNow()");
  assert.equal(p.e('effectStacks.ritual_of_plague'),1);
  assert.equal(p.e('effectStacks.focus'),0);
  assert.ok(p.e("availableEffects().some(e=>e.id==='ritual_of_plague')"));
  p.e("effectMods=buffContribs().concat([['plus_lvl_buff_spells','FLAT',4.349,'test'],['plus_lvl_all_spells','FLAT',3,'test'],['inc_effect_of_positive_buff_given','FLAT',47.55,'test']]);effectSheet=makeEngine(B.calc)([],effectMods,100,[])");
  assert.equal(p.e("bonusLevels('blasphemous_ritual',effectSheet)"),7);
  assert.ok(Math.abs(p.e("effectSheet.why.dexterity.find(x=>x[0]==='buff:ritual_of_plague')[2]") - 9.75*5.95*1.4755)<1e-9);
  assert.equal(p.e("runeFamily('elytra')"),'jewelry');
  assert.deepEqual(p.json("runeStats({base:'elytra',sockets:['azurite5'],ilvl:50})"),[{stat:'dexterity',type:'PERCENT',value:5.5}]);
  assert.equal(p.e("IE.statsOf({base:'crossbow',ilvl:100,basePct:100,affixes:[]},[{stat:'gear_weapon_damage',type:'PERCENT',value:20}]).find(s=>s.stat==='weapon_damage').value / IE.statsOf({base:'crossbow',ilvl:100,basePct:100,affixes:[]}).find(s=>s.stat==='weapon_damage').value"),1.2);
  p.e("effectFixture.omens=[{id:'mirrors',lvl:100,rar:'uncommon',rarities:{NORMAL:1,UNIQUE:1,RUNED:1},aff:[{id:'gear_corruptnecklace_all',p:19}]}];IMPORTER.apply(effectFixture);cur=JSON.parse(JSON.stringify(custom.codex));paintAll()");
  assert.equal(p.w.document.getElementById('f-cdx').value,'mirrors');
  assert.equal(p.e('custom.codex.codexRarity'),'uncommon');
  assert.equal(p.e('B.codex.length'),1);
  p.e('saveCurrent("character")');
  const restored=page(p.storage());
  assert.equal(restored.e('custom.codex.codexOmen.id'),'mirrors');
  assert.equal(restored.e('effectStacks.ritual_of_plague'),1);
  console.log('PASS imported secondary effects, bonus buff ranks, elytra gems, weapon modifiers and codex persistence');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>opened.forEach(p=>p.w.close()));
`);
