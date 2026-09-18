/* ---- reporting a problem -------------------------------------------------

   What makes a report useful is rarely what the reporter thinks to include.
   "My DPS is wrong" costs a round trip; the same message with the build code,
   which skill, and the stats where the page already disagrees with the game is
   actionable immediately.

   So the page assembles it. The button copies a block the reporter can paste
   into a GitHub issue or Discord without knowing what any of it means.
*/
const REPORT = (() => {

  /* The stats where OUR number and the game's already differ. The page ships
     with the game's own values for the character it was built from, so this is
     a standing list of known inaccuracy - and a reporter's complaint very
     often turns out to be one of these rather than something new. */
  function worstMismatches(n) {
    return Object.entries(characterContext.computed || {})
      .map(([id, s]) => ({ id, game: s.v, ours: live.total(id) }))
      .filter(s => Math.abs(s.game - s.ours) > 0.01)
      .sort((a, b) => Math.abs(b.game - b.ours) - Math.abs(a.game - a.ours))
      .slice(0, n)
      .map(s => '  ' + s.id + ': page ' + fmt(s.ours) + ', game ' + fmt(s.game));
  }

  function activeSkill() {
    const sel = document.getElementById('dpsfocus');
    if (sel && sel.selectedOptions[0]) return sel.selectedOptions[0].text;
    return '(none)';
  }

  function effectsOn() {
    const on = Object.keys(typeof effectStacks === 'undefined' ? {} : effectStacks)
      .filter(k => effectStacks[k])
      .map(k => k + (effectStacks[k] > 1 ? ' x' + effectStacks[k] : ''));
    return on.length ? on.join(', ') : 'none';
  }

  async function assemble(userText) {
    const lines = [];
    lines.push('### What is wrong');
    lines.push(userText || '(describe what you expected and what you saw)');
    lines.push('');
    lines.push('### Where');
    const tab = document.querySelector('.tabs button[aria-selected="true"]');
    lines.push('- tab: ' + (tab ? tab.textContent.trim() : '?'));
    lines.push('- headline skill: ' + activeSkill());
    lines.push('- target: ' + (typeof enemyDef === 'function' ? enemyDef().name : '?'));
    lines.push('- buffs on: ' + effectsOn());
    lines.push('');
    lines.push('### Build');
    lines.push('- page ' + BUILD_REV + ', built ' + BUILT_ON);
    const accuracy = referenceAccuracy();
    lines.push('- level ' + charLevel + (accuracy.total
      ? ', ' + accuracy.exact + '/' + accuracy.total + ' stats matching the imported reference'
      : ', no imported game reference'));
    if (typeof CUSTOM_MODS !== 'undefined' && CUSTOM_MODS.parsed.length) {
      lines.push('- custom modifiers in use: '
        + CUSTOM_MODS.parsed.map(m => valText(m.value, m.type) + ' ' + label(m.stat))
            .join(', '));
    }
    lines.push('');
    let code = '(could not generate)';
    try { code = await encodeBuild('character'); } catch (e) { /* keep the fallback */ }
    lines.push('<details><summary>Build code - paste this back to load it</summary>');
    lines.push('');
    lines.push('```');
    lines.push(code);
    lines.push('```');
    lines.push('</details>');
    lines.push('');
    const bad = worstMismatches(8);
    if (bad.length) {
      lines.push('<details><summary>Stats the page already knows it gets wrong</summary>');
      lines.push('');
      lines.push('```');
      lines.push.apply(lines, bad);
      lines.push('```');
      lines.push('</details>');
    }
    lines.push('');
    lines.push('---');
    lines.push('browser: ' + navigator.userAgent);
    return lines.join('\n');
  }

  function open() {
    const host = document.getElementById('reportbox');
    if (!host) return;
    if (!host.hidden) { host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML =
      '<label>What went wrong?</label>' +
      '<textarea id="rep-what" rows="3" spellcheck="false" placeholder="' +
        'The tooltip says Fire Resistance but the item gives Cold.&#10;' +
        'Or: Magic Missile DPS reads 300k, the dummy says 166k."></textarea>' +
      '<p class="note" style="margin:2px 0 0">For anything about damage, the ' +
      'single most useful thing you can add is a screenshot of the in-game ' +
      '<b>Damage Breakdown &rarr; Last Hit</b> panel. It itemises every ' +
      'multiplier, which is enough to find the exact term that is wrong.</p>' +
      '<div class="brow">' +
        '<button class="mini primary" id="rep-copy">Copy report</button>' +
        '<button class="mini" id="rep-issue">Open GitHub issue</button>' +
        '<button class="mini" id="rep-close">Close</button>' +
      '</div>' +
      '<textarea id="rep-out" rows="6" readonly spellcheck="false" hidden></textarea>';

    document.getElementById('rep-copy').onclick = async () => {
      const text = await assemble(document.getElementById('rep-what').value.trim());
      const out = document.getElementById('rep-out');
      out.hidden = false;
      out.value = text;
      out.select();
      try {
        await navigator.clipboard.writeText(text);
        note('character', 'Report copied — paste it into an issue or Discord.');
      } catch (e) {
        note('character', 'Select the text below and copy it.');
      }
    };
    document.getElementById('rep-issue').onclick = async () => {
      const text = await assemble(document.getElementById('rep-what').value.trim());
      try { await navigator.clipboard.writeText(text); } catch (e) { /* fine */ }
      const url = ISSUE_URL + '?labels=bug&title='
        + encodeURIComponent('[report] ' +
            (document.getElementById('rep-what').value.trim().slice(0, 60) || 'problem'))
        /* The body goes through the clipboard rather than the URL: a build code
           is well past what a querystring will carry. */
        + '&body=' + encodeURIComponent(
            'Paste the copied report here (it is already on your clipboard).');
      window.open(url, '_blank', 'noopener');
    };
    document.getElementById('rep-close').onclick = () => { host.hidden = true; };
  }

  return { open, assemble };
})();

/* Wired once the page exists. */
{
  const b = document.getElementById('reportbtn');
  if (b) b.onclick = () => REPORT.open();
  const v = document.getElementById('verstamp');
  if (v) v.textContent = BUILD_REV + ' · ' + BUILT_ON;
}
