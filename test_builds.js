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
  await new Promise(resolve => setTimeout(resolve, 750));
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

  for (const p of opened) assert.equal(p.errors.length, 0, p.errors.map(String).join('\n'));
  console.log('\n' + checks + ' lifecycle checks passed');
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => opened.forEach(p => p.w.close()));
