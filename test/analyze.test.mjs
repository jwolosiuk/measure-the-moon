import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMoon } from './synth.mjs';
import { analyze, shapeName } from '../js/analyze.js';
import { terminatorPath, limbPath } from '../js/overlay.js';
import { compare, errorBudget } from '../js/fit.js';
import { isLitExact, isLitCircular } from '../js/geometry.js';

const W = 340, H = 300;
const base = { cx: 168.4, cy: 151.7, R: 90, theta: 0.62 };

const shoot = (cosI, extra = {}) => analyze(renderMoon(W, H, { ...base, cosI, ...extra }), W, H);

test('recovers the phase of a clean synthetic Moon across the whole range', () => {
	// Down to a 3.5 px lit sliver. Below that it is resolution-limited, which
	// the next test pins down separately.
	let worst = 0;
	for (let cosI = -0.96; cosI <= 0.981; cosI += 0.07) {
		const r = shoot(cosI);
		assert.ok(r.ok, `failed at cosI=${cosI}: ${r.reason}`);
		const err = Math.abs(r.k - (1 + cosI) / 2);
		worst = Math.max(worst, err);
		assert.ok(err < 0.012, `cosI=${cosI}: measured ${r.k}, truth ${(1 + cosI) / 2}`);
	}
	assert.ok(worst < 0.012, `worst error ${worst}`);
});

test('a sub-pixel crescent is resolution-limited, and the band says so', () => {
	// At R=90 a cosI of -0.98 is a 1.8 px sliver: the measurement is genuinely
	// wrong, and the only acceptable behaviour is to widen the band to match.
	const small = shoot(-0.98);
	assert.ok(small.ok);
	const errSmall = Math.abs(small.k - 0.01);
	assert.ok(errSmall > 0.005, 'expected this to be hard, not accurate');
	assert.ok(errSmall <= small.sigma, `band ${small.sigma} did not cover error ${errSmall}`);
	assert.ok(small.budget.sigmaRes > 0, 'the resolution term should be carrying it');

	// The same phase on a bigger disc is a real measurement again, which is
	// what makes it a resolution limit rather than a modelling failure.
	const S = 1440;
	const big = analyze(renderMoon(S, S, { cx: S / 2, cy: S / 2, R: 360, theta: 0.62, cosI: -0.98 }), S, S);
	assert.ok(big.ok);
	assert.ok(Math.abs(big.k - 0.01) < 0.002, `large disc measured ${big.k}`);
	assert.ok(big.sigma < small.sigma, 'and the band should tighten with resolution');
});

test('recovers the geometry too, not just the area', () => {
	for (const cosI of [-0.7, -0.2, 0.3, 0.8]) {
		const r = shoot(cosI);
		assert.ok(Math.abs(r.params.R - base.R) < 3, `radius ${r.params.R}`);
		assert.ok(Math.hypot(r.params.cx - base.cx, r.params.cy - base.cy) < 4, 'centre');
		const dth = Math.atan2(Math.sin(r.params.theta - base.theta), Math.cos(r.params.theta - base.theta));
		assert.ok(Math.abs(dth) < 0.08, `sun direction off by ${dth}`);
		assert.ok(r.iou > 0.95, `IoU ${r.iou}`);
	}
});

test('a thin crescent still converges — the case where zero overlap used to strand the fit', () => {
	// The analytic centroid placement exists for exactly this: a thresholded
	// crescent loses its tips, which drags a naive centre guess sideways until
	// the model and the blob do not overlap at all. IoU is then flat at zero in
	// every direction and the simplex never moves.
	for (const cosI of [-0.95, -0.92, -0.88]) {
		const r = shoot(cosI);
		assert.ok(r.ok, `cosI=${cosI} failed`);
		assert.ok(r.iou > 0.8, `cosI=${cosI}: IoU collapsed to ${r.iou}`);
		assert.ok(Math.abs(r.k - (1 + cosI) / 2) < 0.02, `cosI=${cosI}: k=${r.k}`);
		assert.ok(Math.abs(r.params.R - base.R) < 5, `cosI=${cosI}: radius ${r.params.R}`);
	}
});

test('the quoted band covers the truth across blur, noise, size and exposure', () => {
	const conditions = [
		{}, { blur: 2 }, { blur: 4, noise: 12 }, { blur: 5 }, { noise: 20 }, { noise: 25 },
		{ R: 40 }, { R: 22 }, { sky: 30, noise: 8 }, { peak: 255, blur: 2 }, { blur: 3, noise: 15 },
	];
	// The contract: the band is a calibrated one sigma, not a worst-case
	// bound. Original calibration priced the threshold as landing anywhere in
	// the smeared edge, which covered the truth in every single case with a
	// median error of 0.03 sigma -- a bound masquerading as a standard
	// deviation. Recalibrated (threshold near the middle of the band), the
	// coverage should sit clearly above the Gaussian 68% but no longer at
	// 100%, with no miss beyond twice the band.
	let inside = 0, total = 0, refused = 0, worstRatio = 0;
	const ratios = [];
	for (const cond of conditions) {
		for (const cosI of [-0.99, -0.98, -0.95, -0.9, -0.7, -0.4, -0.1, 0.2, 0.5, 0.8, 0.95, 1]) {
			const r = shoot(cosI, cond);
			if (!r.ok) { refused++; continue; }
			total++;
			const err = Math.abs(r.k - (1 + cosI) / 2);
			if (err <= r.sigma) inside++;
			const z = err / Math.max(r.sigma, 1e-9);
			ratios.push(z);
			worstRatio = Math.max(worstRatio, z);
		}
	}
	ratios.sort((a, b) => a - b);
	assert.ok(total > 100, `only ${total} cases ran`);
	assert.ok(inside / total >= 0.85, `only ${inside}/${total} inside a one-sigma band`);
	assert.ok(worstRatio <= 2.5, `worst miss was ${worstRatio.toFixed(2)} sigma`);
	// If the median error is a tiny fraction of the band, the band is a bound
	// again and the recalibration has regressed.
	assert.ok(ratios[ratios.length >> 1] >= 0.05 && ratios[ratios.length >> 1] <= 0.6,
		`median err/sigma ${ratios[ratios.length >> 1].toFixed(2)} -- band no longer reads as one sigma`);
	// And the images with no Moon left in them must be refused, not measured.
	assert.ok(refused > 0, 'expected the hopeless cases to be declined');
});

test('the budget covers the one real photo we have ground truth for', () => {
	// 2026-08-28, 00:38 CEST, five and a half hours before full moon: true
	// illumination 99.94% (Meeus), the app read 98.45%. At that resolution the
	// dark sliver is 0.05 px -- physically unresolvable -- so the 1.5 pp error
	// is a resolution effect, and the budget must price it. Synthetic images
	// cannot reproduce this (their symmetric edges fit back to the truth), so
	// the budget is exercised directly with the photo's measured numbers.
	const R = 37.8, cosI = 0.9691;
	const disc = Math.PI * R * R;
	const b = errorBudget({
		params: { cx: 0, cy: 0, R, theta: 0, cosI },
		iou: 0.995,
		symDiff: 2 * 0.0022 * disc,        // sigmaFit was quoted at ±0.22%
		litArea: ((1 + cosI) / 2) * disc,
		edgeWidth: 3.09, edgeUncertain: false,
		limbRms: 0.95, limbCount: 212,
	});
	const res = b.terms.find((t) => t.key === 'res');
	assert.ok(res, 'no resolution term for the unresolvable dark sliver');
	assert.match(res.detail, /dark sliver/);
	// The raw term is huge (the sliver is 6x thinner than the edge smear); the
	// cap must pull it back to exactly the distance to full.
	const kMeasured = (1 + cosI) / 2;
	assert.ok(Math.abs(b.sigmaRes - (1 - kMeasured)) < 1e-9,
		`sigmaRes ${b.sigmaRes} should be capped at ${1 - kMeasured}`);
	// And the total band must cover the real error, without ballooning back
	// into the old +-8% bound.
	const realError = 0.9994 - kMeasured;
	assert.ok(b.total >= realError, `band ${b.total} misses the real error ${realError}`);
	assert.ok(b.total < 0.04, `band ${b.total} is a bound again, not a one-sigma`);
});

test('a soft near-full synthetic still quotes a band that covers full', () => {
	const r = shoot(0.9988, { blur: 4, R: 38 });
	assert.ok(r.ok);
	assert.ok(Math.abs(r.k - 0.9994) <= r.sigma, `k ${r.k} +- ${r.sigma} misses 0.9994`);
});

test('declines images where the bright blob is only noise', () => {
	// A 0.5% crescent smeared by 4 px and buried in noise leaves a blob for
	// Otsu to find, and fitting it used to yield a confident 99%.
	const r = shoot(-0.99, { blur: 4, noise: 12 });
	assert.equal(r.ok, false);
	assert.match(r.reason, /grey levels above the background/);

	// Pure noise, no Moon at all.
	const noise = analyze(renderMoon(W, H, { ...base, R: 1, cosI: 0, noise: 30 }), W, H);
	assert.equal(noise.ok, false);
});

test('the fit cannot escape to a giant mostly-off-frame Moon', () => {
	// A thin crescent and the limb of a huge gibbous look alike over a small
	// patch. If the blob does not reach the frame edge then the whole Moon is
	// in the picture, so its disc has to be too.
	for (const cond of [{ blur: 5 }, { noise: 25 }, { blur: 3, noise: 15 }]) {
		for (const cosI of [-0.95, -0.9, -0.6]) {
			const r = shoot(cosI, cond);
			if (!r.ok) continue;
			assert.ok(r.params.R < base.R * 1.7,
				`radius ran away to ${r.params.R} for ${JSON.stringify(cond)} at cosI=${cosI}`);
			const { cx, cy, R } = r.params;
			assert.ok(cx + R < W * 1.35 && cy + R < H * 1.35 && cx - R > -W * 0.35 && cy - R > -H * 0.35,
				'fitted disc left the frame while the blob did not');
		}
	}
});

test('uncertainty grows with blur instead of staying quietly confident', () => {
	let prev = 0;
	for (const blur of [0, 1, 2, 3, 4, 5]) {
		const r = shoot(-0.9, { blur });
		assert.ok(r.sigma > prev, `sigma did not grow at blur=${blur} (${r.sigma} vs ${prev})`);
		assert.ok(r.edgeWidth >= 1, 'edge width should be at least a pixel');
		prev = r.sigma;
	}
});

test('the circular model is reported alongside, and is biased the way theory says', () => {
	for (const cosI of [-0.6, -0.4, 0.4, 0.6]) {
		const r = shoot(cosI);
		const bias = r.kCircular - r.k;
		if (cosI < 0) assert.ok(bias > 0.004, `crescent bias ${bias} should be positive`);
		else assert.ok(bias < -0.004, `gibbous bias ${bias} should be negative`);
		assert.ok(Math.abs(bias) < 0.032, `bias ${bias} beyond the theoretical peak`);
	}
});

test('the model-free pixel count agrees with the fitted model', () => {
	for (const cosI of [-0.6, 0, 0.6]) {
		const r = shoot(cosI);
		assert.ok(Math.abs(r.kArea - r.k) < 0.02, `kArea ${r.kArea} vs k ${r.k}`);
	}
});

test('warns instead of silently guessing when the image is bad', () => {
	const has = (r, frag) => r.warnings.some((w) => w.text.toLowerCase().includes(frag));

	const blown = shoot(-0.3, { peak: 255, blur: 6 });
	assert.ok(has(blown, 'clipped'), 'should flag a blown-out exposure');

	const tiny = analyze(renderMoon(120, 120, { cx: 60, cy: 60, R: 14, theta: 1, cosI: 0.2 }), 120, 120);
	assert.ok(tiny.ok && has(tiny, 'px across'), 'should flag a tiny target');

	const thin = shoot(-0.97);
	assert.ok(has(thin, 'thin lune'), 'should flag a razor-thin crescent');

	const cut = analyze(renderMoon(160, 160, { cx: 80, cy: 80, R: 88, theta: 1, cosI: 0.5 }), 160, 160);
	assert.ok(cut.ok && has(cut, 'frame edge'), 'should flag a Moon running off the frame');
});

test('gives a reason rather than a number when there is nothing to measure', () => {
	const dark = new Uint8ClampedArray(W * H * 4);
	for (let i = 0; i < W * H; i++) { dark[i * 4 + 3] = 255; }
	const r = analyze(dark, W, H);
	assert.equal(r.ok, false);
	assert.match(r.reason, /Nothing bright/);
});

test('shape names line up with the fractions', () => {
	assert.equal(shapeName(0.0), 'New');
	assert.equal(shapeName(0.2), 'Crescent');
	assert.equal(shapeName(0.5), 'Quarter');
	assert.equal(shapeName(0.8), 'Gibbous');
	assert.equal(shapeName(1.0), 'Full');
});

test('the drawn outline is the geometry it claims to be', () => {
	const r = shoot(-0.45);
	const p = r.circularParams;
	const ux = Math.cos(p.theta), uy = Math.sin(p.theta);
	const cusps = [
		[p.cx - p.R * uy, p.cy + p.R * ux],
		[p.cx + p.R * uy, p.cy - p.R * ux],
	];
	for (const variant of ['circular', 'exact']) {
		const path = terminatorPath(p, variant);
		// Both terminators must start and end on the cusps.
		assert.ok(Math.hypot(path[0][0] - cusps[0][0], path[0][1] - cusps[0][1]) < 0.5, `${variant} start`);
		const end = path[path.length - 1];
		assert.ok(Math.hypot(end[0] - cusps[1][0], end[1] - cusps[1][1]) < 0.5, `${variant} end`);
		// Every point of the terminator lies inside the Moon's own disc.
		for (const [x, y] of path) {
			assert.ok(Math.hypot(x - p.cx, y - p.cy) <= p.R + 0.5, `${variant} strays outside the limb`);
		}
		// The apex sits at -R·cosI along the Sun axis.
		const apex = path[path.length >> 1];
		const xi = (apex[0] - p.cx) * ux + (apex[1] - p.cy) * uy;
		assert.ok(Math.abs(xi - (-p.R * p.cosI)) < 0.6, `${variant} apex at ${xi}`);
	}
	// The lit limb is a half circle, cusp to cusp, all at radius R.
	const limb = limbPath(p);
	for (const [x, y] of limb) {
		assert.ok(Math.abs(Math.hypot(x - p.cx, y - p.cy) - p.R) < 1e-6, 'limb is not circular');
	}
});

test('the terminator circle really does pass through the cusps and the apex', () => {
	const r = shoot(0.55);
	const c = r.circles;
	assert.ok(c.shadow, 'expected a finite second circle at this phase');
	const p = r.circularParams;
	const ux = Math.cos(p.theta), uy = Math.sin(p.theta);
	const pts = [
		[p.cx - p.R * uy, p.cy + p.R * ux],
		[p.cx + p.R * uy, p.cy - p.R * ux],
		[p.cx - p.R * p.cosI * ux, p.cy - p.R * p.cosI * uy],
	];
	for (const [x, y] of pts) {
		const d = Math.hypot(x - c.shadow.cx, y - c.shadow.cy);
		assert.ok(Math.abs(d - c.shadow.r) < 1e-6, `point off the second circle by ${d - c.shadow.r}`);
	}
	assert.equal(c.mode, 'intersect');
});

test('near quarter phase the second circle is reported as a straight line', () => {
	const r = shoot(0.005);
	assert.equal(r.circles.shadow, null);
	assert.ok(r.circles.straight, 'expected the limiting line');
});

test('the fitter and the geometry module agree on what is lit', () => {
	// compare() inlines the membership test rather than calling into
	// geometry.js, for speed -- it runs per pixel, per optimiser step. That is
	// a place where the two could silently drift apart, with the maths tests
	// still passing while the fit uses something else, so pin them together.
	const w = 61, h = 61;
	const params = { cx: 30.3, cy: 29.6, R: 24, theta: 0.9, cosI: 0 };
	for (const variant of ['exact', 'circular']) {
		const predicate = variant === 'exact' ? isLitExact : isLitCircular;
		for (const cosI of [-0.95, -0.6, -0.2, 0, 0.2, 0.6, 0.95]) {
			const p = { ...params, cosI };
			const u = [Math.cos(p.theta), Math.sin(p.theta)];
			// Build the mask geometry.js says is lit...
			const mask = new Uint8Array(w * h);
			let area = 0;
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (predicate(x, y, p.cx, p.cy, p.R, u, cosI)) { mask[y * w + x] = 1; area++; }
				}
			}
			// ...and ask the fitter to score its own model against it.
			const c = compare(p, variant, mask, w, h, area, [0, 0, w - 1, h - 1]);
			assert.equal(c.symDiff, 0,
				`${variant} at cosI=${cosI}: fitter and geometry disagree on ${c.symDiff} px`);
			assert.equal(c.iou, 1);
		}
	}
});
