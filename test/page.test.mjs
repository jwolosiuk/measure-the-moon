import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// The demo panel once had display:flex and no [hidden] override, so it could
// never be visually hidden again after opening: author declarations beat the
// UA's [hidden]{display:none} in the cascade, and the panel stayed painted
// over photo measurements while the JS believed it was closed.
//
// This is a static test because jsdom cannot host a behavioural one: its
// getComputedStyle lets the UA [hidden] rule win over an author display rule,
// which is the opposite of what browsers do, so in jsdom the bug is invisible.
test('every element the app hides via the hidden attribute stays hideable', () => {
	const app = read('js/app.js');
	const html = read('index.html');
	const css = read('styles.css');

	// Elements toggled from JS, plus those that start out hidden in the HTML.
	const ids = new Set();
	for (const m of app.matchAll(/\$\('([^']+)'\)\.hidden/g)) ids.add(m[1]);
	for (const m of html.matchAll(/<[a-z]+[^>]*\bid="([^"]+)"[^>]*\bhidden\b/g)) ids.add(m[1]);
	assert.ok(ids.has('demo-panel') && ids.size >= 5, `unexpectedly few hidden-toggled elements: ${[...ids]}`);

	// Selector tokens that can reach each of those elements.
	const tokens = new Set();
	for (const id of ids) {
		tokens.add(`#${id}`);
		const tag = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
		assert.ok(tag, `element #${id} not found in index.html`);
		const cls = tag[0].match(/class="([^"]+)"/);
		if (cls) for (const c of cls[1].split(/\s+/)) tokens.add(`.${c}`);
	}

	// Any author rule that sets display on one of them re-creates the trap
	// unless the global override is present.
	const hasOverride = /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css);
	const offenders = [];
	for (const rule of css.split('}')) {
		const [selector, body] = rule.split('{');
		if (!selector || !body || !/(^|[^-])display\s*:/.test(body)) continue;
		for (const t of tokens) {
			if (selector.includes(t)) offenders.push(`${t} via "${selector.trim().replace(/\s+/g, ' ')}"`);
		}
	}
	if (offenders.length > 0) {
		assert.ok(hasOverride,
			`author CSS sets display on hidden-toggled elements (${offenders.join('; ')}) ` +
			'but styles.css has no "[hidden] { display: none !important }" override — ' +
			'in a browser those elements can never be hidden again once shown');
	}
});
