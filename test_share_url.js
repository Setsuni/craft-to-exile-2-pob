/* Sharing a build as a link.
 *
 *   node test_share_url.js [docs/index.html]
 *
 * The code already travelled as one line; a link is just that code in a URL
 * fragment. What this guards is the round trip and the two things that are
 * easy to get wrong: the code must survive the URL untouched, and the fragment
 * must be cleared afterwards so a refresh does not silently re-import someone
 * else's build over work done since.
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const noop = () => {};
const html = fs.readFileSync(process.argv[2] || 'docs/index.html', 'utf8');
const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>', {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://example.org/planner/',
  beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
      get: (t, k) => k === 'canvas' ? { width: 800, height: 600 }
        : k === 'measureText' ? () => ({ width: 10 })
        : k === 'createPattern' ? () => ({}) : (t[k] === undefined ? noop : t[k]),
      set: (t, k, v) => { t[k] = v; return true; } });
    w.Image = class { set src(_) {} };
    w.confirm = () => true;
    /* jsdom implements <dialog> as an inert element. The unsaved-work prompt
       is real and correct - opening a share link over unsaved edits SHOULD
       ask - so stand in for it and answer the way a person clicking
       "Discard changes" would. */
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
      setTimeout(() => {
        const b = this.querySelector('[value="discard"], [data-act="discard"], button');
        if (b) b.click(); else this.close('discard');
      }, 0);
    };
    w.HTMLDialogElement.prototype.close = function (v) {
      this.open = false;
      this.returnValue = v === undefined ? this.returnValue : v;
      this.dispatchEvent(new w.Event('close'));
    };
  },
});
const w = dom.window;
let fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!cond) fail++;
};
function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return 'at ' + i + ': ' + JSON.stringify(a.slice(i - 40, i + 40)) +
      ' vs ' + JSON.stringify(b.slice(i - 40, i + 40));
  }
  return '';
}

setTimeout(async () => {
  const before = w.eval('JSON.stringify(serializeCharacter())');
  const code = await w.eval('encodeBuild("character", serializeCharacter())');
  const url = w.eval('shareUrl(' + JSON.stringify(code) + ')');
  ok('the link is absolute and carries the code in the fragment',
     url.startsWith('https://example.org/planner/#b=CTE2C~'), url.slice(0, 46) + '...');
  ok('the code is one line, safe to paste anywhere', !/[\s#&?]/.test(code));
  w.eval('charLevel = 42;');
  w.location.hash = '#b=' + code;
  const loaded = await w.eval('loadFromUrl()');
  ok('the link loaded', loaded === true);
  const after = w.eval('JSON.stringify(serializeCharacter())');
  ok('the build came back byte for byte', after === before,
     after === before ? '' : firstDiff(before, after));
  ok('the fragment is cleared, so a refresh does not re-import',
     w.location.hash === '' && w.location.pathname === '/planner/', JSON.stringify(w.location.hash));
  ok('a page opened with no fragment is left alone',
     (await w.eval('loadFromUrl()')) === false);
  w.location.hash = '#b=%';
  const saved = w.eval('JSON.stringify(serializeCharacter())');
  await w.eval('loadFromUrl()');
  ok('malformed URI clears without changing the build', w.location.hash === '' &&
    w.eval('JSON.stringify(serializeCharacter())') === saved);
  await w.eval('openShare("character")');
  Object.defineProperty(w.navigator, 'clipboard', {configurable:true,
    value:{writeText:async()=>{throw new Error('denied')}}});
  w.document.execCommand = () => false;
  await w.document.querySelector('#buildshare [data-copy]').onclick();
  ok('rejected clipboard does not report success', w.document.body.textContent.includes('Select the text and copy it manually.'));
  await w.document.querySelector('#buildshare [data-copycode]').onclick();
  ok('rejected code copy offers manual copying', w.document.body.textContent.includes('Select the text and copy it.'));
  console.log(fail ? '\nurl sharing: ' + fail + ' FAILED' : '\nurl sharing: 9 checks passed');
  process.exit(fail ? 1 : 0);
}, 1200);
