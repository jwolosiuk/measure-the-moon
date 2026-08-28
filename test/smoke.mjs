// The whole app driven through the DOM: click Demo, and check that a real
// measurement comes out the other end and lands in the page.
import assert from 'node:assert/strict';
import { boot } from './dom-shim.mjs';

const dom = boot(new URL('../index.html', import.meta.url).pathname);
const { document } = dom.window;
const $ = (id) => document.getElementById(id);

await import('../js/app.js');

assert.equal($('ver').textContent, 'v1.0', 'version should be stamped on load');
assert.ok($('readout').hidden, 'no readout before anything is measured');

// Rendered visibility, not the hidden property: the property was always
// toggling correctly while CSS display:flex kept the panel painted anyway.
const painted = (el) => dom.window.getComputedStyle(el).display !== 'none';
assert.ok(!painted($('demo-panel')), 'demo panel painted before Demo was ever pressed');

const pct = (s) => Number(String(s).replace('%', ''));

// --- run the demo at a known phase -------------------------------------------
$('demo-phase').value = '700';
$('btn-demo').dispatchEvent(new dom.window.Event('click'));

assert.ok(!$('readout').hidden, 'readout should appear');
assert.ok(painted($('demo-panel')), 'demo controls should appear');

const measured = pct($('k-value').textContent);
assert.ok(Math.abs(measured - 70) < 3, `demo at 70% measured ${measured}%`);
assert.equal($('k-shape').textContent, 'Gibbous');
assert.ok(pct($('k-sigma').textContent) > 0, 'a band should be quoted');
assert.match($('k-truth').textContent, /Demo truth 70/);
assert.match($('k-truth').textContent, /inside the quoted band/);

// Every model row filled in, and the bias pointing the way theory says.
for (const id of ['m-exact', 'm-circ', 'm-bias', 'm-area']) {
	assert.notEqual($(id).textContent, '—', `${id} was left empty`);
}
assert.match($('m-bias').textContent, /^−/, 'a gibbous Moon should read low under the circular model');

// Error budget rendered, totalled, and the pieces add up in quadrature.
const bars = $('budget').querySelectorAll('.bar-row');
assert.ok(bars.length >= 3, `expected the budget broken out, got ${bars.length} rows`);
const parts = [...$('budget').querySelectorAll('.bar-head .v')].map((e) => pct(e.textContent.replace('±', '')));
const quad = Math.sqrt(parts.reduce((a, v) => a + v * v, 0));
const shown = pct($('budget-total').textContent.replace('±', ''));
assert.ok(Math.abs(quad - shown) < 0.02, `total ${shown} is not the quadrature sum ${quad.toFixed(3)}`);

// Diagnostics populated.
const diag = $('diag-rows').textContent;
for (const frag of ['Fitted radius', 'Otsu threshold', 'Combination']) {
	assert.ok(diag.includes(frag), `diagnostics missing "${frag}"`);
}
assert.match(diag, /disc ∩ circle \(gibbous\)/);

// --- a crescent flips the combination ----------------------------------------
$('demo-phase').value = '200';
$('demo-phase').dispatchEvent(new dom.window.Event('input'));
assert.ok(Math.abs(pct($('k-value').textContent) - 20) < 4, `crescent measured ${$('k-value').textContent}`);
assert.equal($('k-shape').textContent, 'Crescent');
assert.match($('diag-rows').textContent, /disc − circle \(crescent\)/);
assert.match($('m-bias').textContent, /^\+/, 'a crescent should read high under the circular model');

// --- quarter phase degenerates to a straight line ----------------------------
$('demo-phase').value = '500';
$('demo-phase').dispatchEvent(new dom.window.Event('input'));
assert.equal($('k-shape').textContent, 'Quarter');
assert.match($('diag-rows').textContent, /infinite — drawn as a straight line/);

// --- a hopeless image is declined, not guessed at ----------------------------
$('demo-phase').value = '5';
$('demo-blur').value = '50';
$('demo-noise').value = '40';
$('demo-blur').dispatchEvent(new dom.window.Event('input'));
assert.equal($('k-value').textContent, '—', 'should refuse rather than invent a number');
assert.ok($('warnings').textContent.length > 20, 'and should say why');

// --- layer toggles redraw without exploding ----------------------------------
$('demo-phase').value = '650';
$('demo-blur').value = '8';
$('demo-noise').value = '6';
$('demo-noise').dispatchEvent(new dom.window.Event('input'));
const before = $('k-value').textContent;
for (const id of ['l-region', 'l-circles', 'l-exact']) {
	$(id).checked = false;
	$(id).dispatchEvent(new dom.window.Event('change'));
}
assert.equal($('k-value').textContent, before, 'toggling layers must not change the measurement');

// --- camera path degrades gracefully with no camera present ------------------
$('btn-cam').dispatchEvent(new dom.window.Event('click'));
await new Promise((r) => setTimeout(r, 50));
assert.ok(/camera|photo/i.test($('warnings').textContent), 'should explain the missing camera');
assert.ok(!painted($('demo-panel')), 'leaving the demo must actually unpaint the panel');



// --- a camera answered late must not hijack what the user moved on to --------
{
	let release;
	const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
	Object.defineProperty(dom.window.navigator, 'mediaDevices', {
		value: { getUserMedia: () => new Promise((r) => { release = r; }) },
		configurable: true,
	});

	$('btn-cam').dispatchEvent(new dom.window.Event('click'));   // permission prompt opens
	$('demo-phase').value = '900';
	$('btn-demo').dispatchEvent(new dom.window.Event('click'));  // user starts the demo meanwhile

	const during = $('k-value').textContent;
	assert.match($('k-truth').textContent, /Demo truth 90/);

	release({ getTracks: () => tracks });                        // permission granted, late
	await new Promise((r) => setTimeout(r, 60));

	assert.equal($('k-value').textContent, during, 'late camera clobbered the demo reading');
	assert.ok(tracks[0].stopped, 'the abandoned camera stream was left running');
	assert.ok($('livebadge').hidden, 'went live behind the user');
	assert.match($('k-truth').textContent, /Demo truth 90/, 'demo truth left captioning other pixels');
}

console.log('smoke: ok (incl. late-camera race)');
