const prefix = require('fs').readFileSync('test_builds.js','utf8').split('(async () => {')[0];
eval(prefix + `
(async () => {
  const p=page();
  p.e("f=IMPORTER.read({ForgeCaps:{'mmorpg:player_data':{},'mmorpg:entity_data':{}}});f.omens=[{id:'spite',lvl:100,rar:'legendary',rarities:{NORMAL:2},aff:[{id:'gear_corruptaura_effect',p:55}]}];IMPORTER.apply(f);cur=JSON.parse(JSON.stringify(custom.codex));applyNow()");
  assert.equal(p.e('B.codex[0].met'),0);
  assert.ok(p.e('B.codex[0].tiers.every(t=>!t.active)'));
  p.e("paintCodex();document.querySelector('[data-cdxr]').value='56';document.querySelector('[data-cdxr]').dispatchEvent(new Event('input',{bubbles:true}));applyNow()");
  assert.ok(p.e('!cur.codexOmen'));
  assert.deepEqual(p.json('codexRequirements(cur)'),{NORMAL:2});
  assert.ok(p.e('B.codex[0].tiers.every(t=>!t.active)'));
  p.e("custom.head=Object.assign(blankDraft('head'),{blank:false,base:basesFor('head')[0]});applyNow()");
  assert.equal(p.e('B.codex[0].met'),1);
  assert.equal(p.e('B.codex[0].tiers[0].active'),true);
  assert.equal(p.e('B.codex[0].tiers[1].active'),false);
  p.e("custom.chest=Object.assign(blankDraft('chest'),{blank:false,base:basesFor('chest')[0]});applyNow()");
  assert.ok(p.e('B.codex[0].tiers.every(t=>t.active)'));
  p.e("keepEditorDraft();saved=serializeCharacter();applyCharacter(saved);cur=JSON.parse(JSON.stringify(custom.codex));delete custom.head;delete custom.chest;applyNow()");
  assert.ok(p.e('B.codex[0].tiers.every(t=>!t.active)'));
  p.e("IMPORTER.apply(f);cur=JSON.parse(JSON.stringify(custom.codex));document.getElementById('restore').onclick();applyNow()");
  assert.equal(p.e('B.codex.length'),0);
  p.e('keepEditorDraft();applyCharacter(serializeCharacter())');
  assert.equal(p.e('B.codex.length'),0);
  p.e("cur=blankDraft('codex');paintAll();document.getElementById('f-cdxr').dispatchEvent(new Event('change',{bubbles:true}));applyNow()");
  assert.equal(p.e('B.codex.length'),1);
  console.log('PASS codex edits, equipment gates, tier activation, deletion and reload');

  p.e("charLevel=100;applyNow();s=skillSheet([], 'magic_missile',20)");
  assert.equal(p.e("Math.trunc(s.total('plus_phys_to_fire'))"),4);
  assert.equal(p.e("Math.trunc(skillSheet([], 'magic_missile',28).total('plus_phys_to_fire'))"),6);
  assert.equal(p.e("live.total('plus_phys_to_fire')"),0);
  assert.equal(p.e("skillSheet([], 'fan_of_knives',20).total('plus_phys_to_fire')"),0);
  assert.ok(p.e("skillSheet([], 'fan_of_knives',20).total('projectile_count') > live.total('projectile_count')"));
  console.log('PASS innate spell stats scale by rank and never leak between skills or onto global sheet');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>opened.forEach(p=>p.w.close()));
`);
