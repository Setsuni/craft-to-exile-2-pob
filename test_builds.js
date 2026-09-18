/* Browser lifecycle regression tests. Run: node test_builds.js docs/index.html */
const fs = require('fs');
const zlib = require('zlib');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(process.argv[2] || 'docs/index.html', 'utf8');
const opened = [];
let checks = 0;
function page(storage = {}) {
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'https://planner.test/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole().on('jsdomError', e => errors.push(e)),
    beforeParse(w) {
      Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
      w.confirm = () => true;
      w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: (t, k) => k === 'canvas' ? { width: 900, height: 600 }
          : k === 'measureText' ? () => ({ width: 10 })
          : k === 'createPattern' ? () => ({}) : t[k] || (() => {}),
        set: (t, k, v) => (t[k] = v, true),
      });
      w.Image = class { set src(_) {} };
      w.addEventListener('error', e => errors.push(e.error || e.message));
    },
  });
  const w = dom.window;
  const p = { w, e: code => w.eval(code), errors,
    storage: () => Object.fromEntries(Object.keys(w.localStorage).map(k => [k, w.localStorage.getItem(k)])),
    json: code => JSON.parse(w.JSON.stringify(w.eval(code))),
    async fixture(path) {
      const bytes = zlib.gunzipSync(fs.readFileSync(path));
      w.fixtureBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      w.fixture = await w.eval('NBT.parse(fixtureBuffer).then(IMPORTER.read)');
      w.eval('IMPORTER.apply(fixture)');
    },
  };
  opened.push(p);
  assert.equal(errors.length, 0);
  return p;
}
const gearCount = "currentContribs().filter(c => /^(gear|jewel):/.test(c[3])).length";
const stats = "Object.fromEntries(Object.keys(live.why).sort().map(k => [k, live.total(k)]))";
function pass(name) { checks++; console.log('PASS ' + name); }
async function choose(p, promise, choice) {
  await Promise.resolve();
  const button = p.w.document.querySelector('dialog [data-' + choice + ']');
  assert.ok(button, 'unsaved-change dialog appeared');
  button.click();
  return await promise;
}
(async () => {
  const a = page();
  assert.deepEqual(a.json('({level:charLevel, classes, skills:loadout.filter(l=>l.spell), talents:treeAlloc("talents"), items:captureItems()})'),
    { level: 1, classes: [], skills: [], talents: [], items: {} });
  assert.equal(a.e(gearCount), 0);
  assert.equal(a.e('autosaveEnabled'), false);
  pass('fresh visitors start blank, with prompt mode enabled');
  a.w.document.getElementById('class-reset').click();
  assert.deepEqual(a.json('classes'), []);
  pass('reset controls cannot resurrect the shipped example');

  await a.fixture('testsaves/pob_export.dat');
  const infusions = page();
  await infusions.fixture('testsaves/pob_export.dat');
  for (const [rarity, roll] of [['common',17],['legendary',85],['mythic',100]]) {
    infusions.w.infusionRarity = rarity;
    infusions.e("fixture.gear.forEach(g=>{g.ench={en:'ench_necklace_all_flat',rar:infusionRarity}}); IMPORTER.apply(fixture)");
    const imported = infusions.json('Object.values(captureItems()).filter(it=>it.inf && it.inf.id).map(it=>it.inf.pct)');
    assert.ok(imported.length > 0);
    assert.ok(imported.every(pct=>pct === roll));
  }
  pass('imported infusion rolls follow infusion rarity independently of item rarity');
  infusions.w.close();
  a.e("document.getElementById('profile').value='Full'; saveCurrent('character')");
  const full = a.json(stats);
  const exported = a.json('serializeCharacter()');
  const b = page(a.storage());
  assert.deepEqual(b.json(stats), full);
  b.w.shared = exported;
  await b.e('applyImported("character", shared)');
  assert.deepEqual(b.json(stats), full);
  pass('real imported character survives save, reload, and JSON sharing');

  const naked = page();
  await naked.fixture('naked214/naked_bare_lvl100.dat');
  assert.equal(naked.e(gearCount), 0);
  naked.e("document.getElementById('profile').value='Naked'; saveCurrent('character')");
  const nakedReload = page(naked.storage());
  assert.equal(nakedReload.e(gearCount), 0);
  assert.deepEqual(nakedReload.json(stats), naked.json(stats));
  pass('empty equipment stays empty across reload');

  const c = page();
  c.e("document.getElementById('profile').value='A';saveCurrent('character');charLevel=50;applyNow();flushAutosave()");
  assert.equal(c.e("readStore('character').A.level"), 1);
  assert.equal(c.e("readStore('characterDraft').build.level"), 50);
  const draftReload = page(c.storage());
  assert.equal(draftReload.e('charLevel'), 50);
  assert.equal(draftReload.e("readStore('character').A.level"), 1);
  draftReload.w.document.getElementById('buildrevert').click();
  assert.equal(draftReload.e('charLevel'), 1);
  pass('recovery drafts preserve work without overwriting the saved checkpoint; Revert works');

  assert.equal(await choose(c, c.e('confirmPending("character")'), 'cancel'), false);
  assert.equal(c.e('charLevel'), 50);
  assert.equal(await choose(c, c.e('confirmPending("character")'), 'save'), true);
  assert.equal(c.e("readStore('character').A.level"), 50);
  c.e('charLevel=60;applyNow()');
  assert.equal(await choose(c, c.e('loadBuild("character", "A")'), 'discard'), true);
  assert.equal(c.e('charLevel'), 50);
  pass('Save, Discard, and Cancel each preserve the intended checkpoint');

  c.w.incoming = { kind: 'character', format: 2, name: 'B', level: 20 };
  await c.e('applyImported("character", incoming)');
  c.e('saveCurrent("character")');
  assert.equal(c.e("readStore('character').A.level"), 50);
  assert.equal(c.e("readStore('character').B.level"), 20);
  pass('importing a build cannot overwrite the previously selected build');

  c.e("autosaveEnabled=true;charLevel=25;applyNow();flushAutosave()");
  assert.equal(c.e("readStore('character').B.level"), 25);
  assert.ok(c.e("readStore('characterRecovery').length") > 0);
  pass('optional autosave updates the selected build and retains recovery versions');

  c.w.document.getElementById('buildnew').click();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(c.e('charLevel'), 1);
  assert.equal(c.e(gearCount), 0);
  assert.equal(c.e("Object.keys(readStore('character')).length"), 2);
  pass('New is blank and preserves other saved builds');

  const custom = page();
  custom.e("cur.blank=false;cur.base=basesFor('head')[0];cur.ilvl=77;setCustom('5000 mana');saveCurrent('character')");
  const customReload = page(custom.storage());
  assert.equal(customReload.e('cur.ilvl'), 77);
  assert.equal(customReload.e('CUSTOM_MODS.text'), '5000 mana');
  assert.equal(customReload.e('live.total("mana")'), custom.e('live.total("mana")'));
  pass('the active item draft and custom modifiers persist together');

  custom.e("paintAll(); document.querySelector('.slotbtn[data-sl=\"chest\"]').click()");
  assert.equal(custom.e('custom.head.ilvl'), 77);
  pass('switching item slots keeps the item being edited');

  const typing = page();
  typing.w.document.getElementById('custbox').value = '1234 mana';
  typing.w.document.getElementById('custbox').dispatchEvent(new typing.w.Event('input'));
  // The input debounce schedules the recovery debounce; allow both to finish.
  for (let attempts=0; attempts<30 && !typing.e("readStore('characterDraft').build"); attempts++)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(typing.e("readStore('characterDraft').build.customModifiers"), '1234 mana');
  assert.equal(typing.e("Object.keys(readStore('character')).length"), 0);
  const typedReload = page(typing.storage());
  assert.equal(typedReload.e('CUSTOM_MODS.text'), '1234 mana');
  pass('unfinished text edits reach recovery without requiring blur or Save');

  const invalid = page(custom.storage());
  const beforeInvalid = invalid.json(stats);
  await invalid.e("applyImported('character', {kind:'character',items:{head:{base:'bad'}}})");
  assert.deepEqual(invalid.json(stats), beforeInvalid);
  pass('malformed build imports leave the active character intact');

  const deleted = page(custom.storage());
  const deleteHandler = deleted.w.document.getElementById('builddel').onclick;
  await deleteHandler();
  assert.equal(deleted.e('Object.keys(readStore("character")).length'), 0);
  assert.ok(deleted.e('readStore("characterRecovery").some(x=>x.reason==="deleted")'));
  deleted.e('openRecovery("character")');
  deleted.w.document.querySelector('[data-restore]').click();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(deleted.e('CUSTOM_MODS.text'), '5000 mana');
  pass('deleted builds can be recovered as a separate working copy');

  const failure = page();
  failure.e("Storage.prototype.setItem=function(){throw new Error('quota')};charLevel=42;applyNow();saveCurrent('character')");
  assert.equal(failure.e('Object.keys(readStore("character")).length'), 0);
  assert.match(failure.w.document.getElementById('buildnote').textContent, /Could not save/);
  pass('storage failures do not claim success');

  const isolated = page();
  assert.equal(isolated.e('Object.keys(readStore("character")).length'), 0);
  assert.equal(isolated.e('charLevel'), 1);
  pass('another browser storage starts independently');

  const report = await isolated.e('REPORT.assemble("test")');
  assert.match(report, /no imported game reference/);
  assert.doesNotMatch(report, /106\/165/);
  assert.ok(a.e('referenceAccuracy().total') > 0);
  pass('reports use the current character reference, not the shipped example');

  const damage = a.json(`loadout.map((l,i)=>l.spell ? skillDps(l.spell,rankOf(i),l.supports) : null)
    .filter(Boolean).map(d=>({id:d.id,dps:d.dps,mitigated:d.dpsMitigated,average:d.average,
      sum:d.parts.reduce((s,p)=>s+p.dps,0),sumMit:d.parts.reduce((s,p)=>s+p.dpsMitigated,0)}))`);
  assert.ok(damage.length >= 3);
  for (const d of damage) {
    assert.ok(Number.isFinite(d.dps) && Number.isFinite(d.mitigated));
    assert.equal(d.dps,d.sum); assert.equal(d.mitigated,d.sumMit);
  }
  a.e('paintSkills();paintDps();paintBreakdown()');
  assert.doesNotMatch(a.w.document.getElementById('brk').textContent,/NaN|Infinity/);
  pass('imported supported skills share finite damage totals across browser views');

  const damagePage = page(a.storage());
  damagePage.e("loadout[0]={spell:'fireball',supports:[]};dpsFocus='fireball';paintSkills();paintDps();brkSkill=0;paintBreakdown()");
  const fire = damagePage.json("(()=>{const d=skillDps('fireball',rankOf(0),[]);return {average:d.average,dps:d.dpsMitigated}})()");
  const card = damagePage.w.document.createElement('div');
  card.innerHTML = damagePage.e('slotCard(0)');
  assert.equal(card.querySelector('.dmgline .n').textContent,String(Math.round(fire.average)));
  const supportSelect = damagePage.w.document.createElement('select');
  supportSelect.innerHTML='<option value="fire_pene">Fire penetration</option>';
  damagePage.w.reviewSupportSelect=supportSelect;
  damagePage.e('annotateSupports(reviewSupportSelect,0)');
  assert.match(supportSelect.options[1].textContent,/\+/);
  assert.ok(damagePage.e("skillDps('fireball',rankOf(0),['fire_pene']).dpsMitigated")>fire.dps);
  pass('real penetration supports improve damage and their comparison labels; skill cards show the shared average');

  const craft = page();
  craft.w.document.querySelector('.tabs button[data-v="items"]').click();
  craft.e("cur=blankDraft('weapon');paintAll()");
  for (const kind of ['pre','suf']) for (let i=0;i<3;i++) {
    const select = craft.w.document.querySelector('#affixpools select[data-kind="'+kind+'"][data-i="'+i+'"]');
    assert.ok(select && !select.disabled,'every normal affix slot remains editable');
    select.value = Array.from(select.options).find(o=>o.value && !o.disabled).value;
    select.dispatchEvent(new craft.w.Event('change',{bubbles:true}));
    craft.e('paintAll()');
  }
  assert.equal(craft.e('cur.pre.filter(a=>a.id).length+cur.suf.filter(a=>a.id).length'),6);
  assert.equal(craft.e('cur.rarity'),'mythic');
  craft.e("saveCurrent('character')");
  const craftedReload = page(craft.storage());
  assert.equal(craftedReload.e('custom.weapon.pre.filter(a=>a.id).length+custom.weapon.suf.filter(a=>a.id).length'),6);
  pass('normal items accept all six affixes, derive rarity and retain them after reload');

  const kindSelect = craft.w.document.getElementById('f-kind');
  kindSelect.value='unique';
  kindSelect.dispatchEvent(new craft.w.Event('change',{bubbles:true}));
  craft.e('paintAll()');
  const pools = craft.w.document.getElementById('affixpools');
  assert.equal(pools.hidden,true);
  assert.equal(craft.w.getComputedStyle(pools).display,'none');
  assert.ok(craft.w.document.querySelector('#uniquebox input[data-u]'));
  assert.equal(craft.e('cur.pre.filter(a=>a.id).length+cur.suf.filter(a=>a.id).length'),0);
  kindSelect.value='normal';
  kindSelect.dispatchEvent(new craft.w.Event('change',{bubbles:true}));
  craft.e('paintAll()');
  assert.equal(pools.hidden,false);
  assert.notEqual(craft.w.getComputedStyle(pools).display,'none');
  pass('unique affix controls are visually hidden and return for normal items');

  const resources = page();
  await resources.fixture('testsaves/pob_export.dat');
  resources.w.runtimeRoot = await resources.e('NBT.parse(fixtureBuffer)');
  resources.w.runtimeRoot.PobRuntimeAttributes={'minecraft:generic.max_health':220};
  resources.w.runtimeRoot.PobHeartContainers=100;
  resources.w.runtimeRoot.ForgeCaps['blue_skies:player_capability']={NatureHealth:2,ArcInventory:[
    {id:'blue_skies:nature_arc',tag:{ArcLevel:0}}, {id:'blue_skies:ethereal_arc',tag:{ArcLevel:2}}]};
  resources.e('IMPORTER.apply(IMPORTER.read(runtimeRoot))');
  resources.e('paintConfig();applyNow()');
  assert.equal(resources.w.document.getElementById('cfg-hearts').value,'100');
  assert.equal(resources.w.document.getElementById('cfg-hearts').disabled,false);
  assert.match(resources.w.document.getElementById('cfg-arcs').textContent,/Nature’s Arc — Common/);
  assert.match(resources.w.document.getElementById('cfg-arcs').textContent,/Ethereal Arc — Rare/);
  assert.equal(resources.e("B.calc.attrTotals['minecraft:generic.max_health']"),220);
  assert.equal(resources.e("live.why.health.find(x=>x[0]==='vanilla_hp')[2]"),220);
  resources.e("saveCurrent('character')");
  const resourceReload = page(resources.storage());
  assert.deepEqual(resourceReload.json(stats),resources.json(stats));
  resources.e('cfg.heartContainers=90;applyNow()');
  assert.equal(resources.e("B.calc.attrTotals['minecraft:generic.max_health']"),200);
  resources.e('cfg.heartContainers=100;applyNow()');
  resources.e("VAN.items['test:health_helmet']={head:{'minecraft:generic.max_health':10}};cur.vanilla='test:health_helmet';applyNow()");
  assert.equal(resources.e("B.calc.attrTotals['minecraft:generic.max_health']"),230);
  // Capture an imported item with +10 already included in its runtime total.
  resources.e("fixture.gear.find(g=>g._slot==='head')._item='test:health_helmet';fixture.runtimeAttrs={'minecraft:generic.max_health':230};IMPORTER.apply(fixture)");
  assert.equal(resources.e("B.calc.attrTotals['minecraft:generic.max_health']"),230);
  resources.e("cur.vanilla='';applyNow()");
  assert.equal(resources.e("B.calc.attrTotals['minecraft:generic.max_health']"),220);
  assert.equal(resources.e("live.why.health.find(x=>x[0]==='vanilla_hp')[2]"),220);
  pass('live health survives save/reload and gear edits without double-counting imported gear');

  const manualHearts=page();
  manualHearts.e('cfg.heartContainers=100;applyNow()');
  assert.equal(manualHearts.e("live.why.health.find(x=>x[0]==='vanilla_hp')[2]"),220);
  assert.equal(manualHearts.e("B.calc.attrTotals['minecraft:generic.max_health']"),220);
  pass('manual builds apply the entered Heart Container count before conversions');

  const effects = page();
  effects.e("effectStacks.focus=1; applyNow()");
  const focus = effects.e("live.why.spell_damage.find(x=>x[0]==='buff:focus')[2]");
  assert.equal(focus,22);
  effects.e("effectTestContribs=buffContribs().concat([['inc_effect_of_positive_buff_given','FLAT',16.6,'test']]); effectTestSheet=makeEngine(B.calc)([],effectTestContribs,100,[])");
  assert.ok(Math.abs(effects.e("effectTestSheet.why.spell_damage.find(x=>x[0]==='buff:focus')[2]")-25.652)<1e-9);
  pass('browser effect definitions retain tags and route positive strength into actual buff contributions');

  {
  const pools = page();
  pools.e(`
    charLevel=100; classes=['rogue','hunter']; classAlloc={};
    for (const sc of Object.values(SCHOOLS)) for (const p of Object.values(sc.perks)) {
      if (!!p.learn !== (p.x < 8)) throw new Error('Class pool differs from left/right layout');
    }
    for (const [skills, cap] of [[true,110],[false,54]]) {
      let remaining=cap;
      for (const pid of Object.keys(PERK_SCHOOL)) {
        const p=perkDef(pid);
        if (!inChosenClass(pid) || !!p.learn !== skills) continue;
        const n=Math.min(remaining,p.max);
        if(n) classAlloc[pid]=n;
        remaining-=n;
      }
      if (remaining) throw new Error('Could not fill test pool');
    }
    poolSkill=Object.keys(classAlloc).find(pid=>perkDef(pid).learn);
    poolPassive=Object.keys(classAlloc).find(pid=>!perkDef(pid).learn);
    poolFreeSkill=Object.keys(PERK_SCHOOL).find(pid=>inChosenClass(pid)&&perkDef(pid).learn&&!classAlloc[pid]);
    poolFreePassive=Object.keys(PERK_SCHOOL).find(pid=>inChosenClass(pid)&&!perkDef(pid).learn&&!classAlloc[pid]);
    applyNow(); paintClasses();
  `);
  assert.deepEqual(pools.json('[spellSpent(),classPassiveSpent()]'),[110,54]);
  assert.equal(pools.w.document.querySelector('[data-point-pool="skills"] strong').textContent,'110 / 110');
  assert.equal(pools.w.document.querySelector('[data-point-pool="passives"] strong').textContent,'54 / 54');
  assert.match(pools.w.document.getElementById('classpts').textContent,/shared across both classes/);
  pools.e("document.querySelector('[data-perk=\"'+poolFreeSkill+'\"]').click();document.querySelector('[data-perk=\"'+poolFreePassive+'\"]').click()");
  assert.deepEqual(pools.json('[spellSpent(),classPassiveSpent()]'),[110,54]);
  pools.e('setClassPerkRank(poolPassive,classAlloc[poolPassive]-1);setClassRank(perkDef(poolFreeSkill).learn,1)');
  assert.deepEqual(pools.json('[spellSpent(),classPassiveSpent()]'),[110,53]);
  pools.e('setClassRank(perkDef(poolSkill).learn,classAlloc[poolSkill]-1);setClassPerkRank(poolFreePassive,1);setClassPerkRank(poolFreePassive,2)');
  assert.deepEqual(pools.json('[spellSpent(),classPassiveSpent()]'),[109,54]);
  pools.e('setClassRank(perkDef(poolFreeSkill).learn,20);applyNow();saveCurrent("character")');
  assert.deepEqual(pools.json('[spellSpent(),classPassiveSpent()]'),[110,54]);
  const poolsReload=page(pools.storage());
  assert.deepEqual(poolsReload.json('[spellSpent(),classPassiveSpent()]'),[110,54]);
  pools.e('classAlloc[poolFreeSkill]+=2;setClassRank(perkDef(poolFreeSkill).learn,classAlloc[poolFreeSkill]-1)');
  assert.equal(pools.e('spellSpent()'),111,'an over-cap imported build can refund points');
  pass('left skills and right passives have separate caps across clicks, rank edits, refunds and save/reload');
  }

  {
    const boots = page();
    boots.w.document.querySelector('.tabs button[data-v="items"]').click();
    boots.e(`cur=blankDraft('feet');cur.blank=false;
      cur.base=basesFor('feet').find(b=>runewordsFor(b).length===5);
      cur.socketCount=2;cur.sockets=Object.keys(GEMS()).slice(0,2);cur.socketPcts=[12,34];paintAll()`);
    const kind = boots.w.document.getElementById('f-kind');
    kind.value='runeword'; kind.dispatchEvent(new boots.w.Event('change'));
    assert.deepEqual(boots.json('cur.sockets'),['','']);
    assert.equal(boots.w.document.querySelectorAll('#f-rw option').length,6);
    assert.equal(boots.w.document.querySelectorAll('#rw-sockets optgroup[label="Gems"] option').length,0);
    boots.e("longBootWord=runewordsFor(cur.base).find(k=>RUNEWORDS()[k].runes.length>2)");
    const rw = boots.w.document.getElementById('f-rw');
    rw.value=boots.e('longBootWord'); rw.dispatchEvent(new boots.w.Event('change'));
    assert.equal(boots.e('matchRuneword(cur)'),boots.e('longBootWord'));
    assert.ok(boots.e('socketsOn(cur)')>2);
    assert.deepEqual(boots.json('cur.socketPcts.slice(0,RUNEWORDS()[longBootWord].runes.length)'),
      Array(boots.e('RUNEWORDS()[longBootWord].runes.length')).fill(100));
    boots.e('saveCurrent("character")');
    const bootsReload=page(boots.storage());
    assert.equal(bootsReload.e('matchRuneword(custom.feet)'),boots.e('longBootWord'));
    assert.deepEqual(boots.json("runeStats({...cur,sockets:[Object.keys(GEMS())[0]]})"),[],
      'legacy invalid gems cannot contribute stats to runeword items');
    boots.e('cur.socketCount=0;cur.sockets=[];paintAll()');
    assert.equal(boots.w.document.getElementById('rwrow').hidden,false);
    assert.equal(boots.w.document.querySelectorAll('#f-rw option').length,6);
    pass('runeword boots offer all five recipes, expand sockets, clear gems and retain valid runes after reload');
  }

  for (const p of opened) assert.equal(p.errors.length, 0, p.errors.map(String).join('\n'));
  console.log('\n' + checks + ' lifecycle checks passed');
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => opened.forEach(p => p.w.close()));
