import test from 'node:test';
import assert from 'node:assert/strict';
import {
	litFractionExact, litFractionCircular, circularModelBias, arcBulgeArea,
	shadowCircle, isLitCircular, isLitExact, cosIFromCircularFraction, litCentroidOffset,
} from '../js/geometry.js';

const U = [Math.cos(0.7), Math.sin(0.7)];

// Rasterise the membership test and compare against the closed-form area, on a
// dense grid. This is what actually keeps the two representations honest: the
// per-pixel test the fitter uses, and the formula the readout quotes.
function rasterFraction(pred, cosI, n = 700) {
	let lit = 0, disc = 0;
	for (let i = 0; i < n; i++) {
		const y = -1 + (2 * (i + 0.5)) / n;
		for (let j = 0; j < n; j++) {
			const x = -1 + (2 * (j + 0.5)) / n;
			if (x * x + y * y > 1) continue;
			disc++;
			if (pred(x, y, 0, 0, 1, U, cosI)) lit++;
		}
	}
	return lit / disc;
}

test('exact model matches the textbook illuminated fraction', () => {
	for (const [cosI, k] of [[-1, 0], [-0.5, 0.25], [0, 0.5], [0.5, 0.75], [1, 1]]) {
		assert.equal(litFractionExact(cosI), k);
	}
});

test('the exact per-pixel test encloses exactly (1 + cos i) / 2 of the disc', () => {
	for (const cosI of [-0.9, -0.6, -0.25, 0, 0.25, 0.6, 0.9]) {
		const raster = rasterFraction(isLitExact, cosI);
		assert.ok(Math.abs(raster - litFractionExact(cosI)) < 2e-3,
			`cosI=${cosI}: raster ${raster} vs ${litFractionExact(cosI)}`);
	}
});

test('the two-circle per-pixel test encloses exactly what the circular formula says', () => {
	for (const cosI of [-0.9, -0.6, -0.25, 0, 0.25, 0.6, 0.9]) {
		const raster = rasterFraction(isLitCircular, cosI);
		assert.ok(Math.abs(raster - litFractionCircular(cosI)) < 2e-3,
			`cosI=${cosI}: raster ${raster} vs ${litFractionCircular(cosI)}`);
	}
});

test('circular model is exact at quarter, full and new', () => {
	for (const cosI of [-1, 0, 1]) {
		assert.ok(Math.abs(circularModelBias(cosI)) < 1e-9, `cosI=${cosI}`);
	}
});

test('circular model bias peaks at 2.8 points and always pulls towards 50%', () => {
	let worst = 0, worstAt = 0;
	for (let i = -1000; i <= 1000; i++) {
		const cosI = i / 1000;
		const bias = circularModelBias(cosI);
		if (Math.abs(bias) > worst) { worst = Math.abs(bias); worstAt = cosI; }
		// Towards 50% means: raises a crescent, lowers a gibbous.
		if (cosI < -1e-6) assert.ok(bias >= -1e-9, `crescent bias should be >= 0 at ${cosI}`);
		if (cosI > 1e-6) assert.ok(bias <= 1e-9, `gibbous bias should be <= 0 at ${cosI}`);
	}
	assert.ok(worst > 0.027 && worst < 0.029, `peak bias ${worst}`);
	assert.ok(Math.abs(Math.abs(worstAt) - 0.564) < 0.01, `peak at cosI=${worstAt}`);
});

test('the published bias table is what the code computes', () => {
	const rows = [[0.05, 0.062], [0.20, 0.228], [0.35, 0.370], [0.50, 0.500],
		[0.65, 0.630], [0.80, 0.772], [0.95, 0.938]];
	for (const [kTrue, kCirc] of rows) {
		const cosI = 2 * kTrue - 1;
		assert.ok(Math.abs(litFractionCircular(cosI) - kCirc) < 5e-4,
			`k=${kTrue}: got ${litFractionCircular(cosI)}, table says ${kCirc}`);
	}
});

test('circular fraction inverts', () => {
	for (const cosI of [-0.93, -0.4, 0, 0.4, 0.93]) {
		assert.ok(Math.abs(cosIFromCircularFraction(litFractionCircular(cosI)) - cosI) < 1e-6);
	}
});

test('arc bulge area spans zero to a half-disc', () => {
	assert.equal(arcBulgeArea(0), 0);
	assert.ok(Math.abs(arcBulgeArea(1) - Math.PI / 2) < 1e-12);
	let prev = -1;
	for (let h = 0; h <= 1.0001; h += 0.01) {
		const a = arcBulgeArea(h);
		assert.ok(a > prev, `not monotone at h=${h}`);
		prev = a;
	}
});

test('the combination flips: intersect for gibbous, subtract for crescent', () => {
	assert.equal(shadowCircle(10, 0.5).mode, 'intersect');
	assert.equal(shadowCircle(10, -0.5).mode, 'subtract');
	assert.ok(shadowCircle(10, 0).straight, 'quarter phase degenerates to a line');
});

test('a crescent is genuinely non-convex, so no intersection could produce it', () => {
	// The whole reason the model has to flip its combining operation. Take two
	// lit points near opposite cusps; their midpoint is not lit. A convex set
	// contains every segment between its points, and an intersection of convex
	// sets is convex, so no A n B can be this shape.
	const cosI = -0.5;
	const at = (xi, eta) => [xi * U[0] - eta * U[1], xi * U[1] + eta * U[0]];
	const eta = 0.999;
	const g = Math.sqrt(1 - eta * eta);            // half-width of the disc there
	const xi = 0.5 * g + 0.5 * (g - 0.5 * g);      // inside the sliver, between terminator and limb
	const a = at(xi, eta), b = at(xi, -eta);
	assert.equal(isLitExact(a[0], a[1], 0, 0, 1, U, cosI), true, 'near one cusp');
	assert.equal(isLitExact(b[0], b[1], 0, 0, 1, U, cosI), true, 'near the other cusp');
	const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
	assert.equal(isLitExact(mid[0], mid[1], 0, 0, 1, U, cosI), false, 'but their midpoint is dark');
	// Same construction on a gibbous Moon is convex, and there the midpoint is lit.
	assert.equal(isLitExact(mid[0], mid[1], 0, 0, 1, U, 0.5), true);
	// The two-circle model reproduces exactly the same behaviour.
	assert.equal(isLitCircular(a[0], a[1], 0, 0, 1, U, cosI), true);
	assert.equal(isLitCircular(mid[0], mid[1], 0, 0, 1, U, cosI), false);
});

test('the terminator circle blows up towards quarter phase and shrinks to the limb at the ends', () => {
	assert.ok(Math.abs(shadowCircle(100, 1).rho - 100) < 1e-9);
	assert.ok(Math.abs(shadowCircle(100, -1).rho - 100) < 1e-9);
	assert.ok(shadowCircle(100, 0.02).rho > 2000);
	let prev = Infinity;
	for (let c = 0.05; c <= 1; c += 0.05) {
		const r = shadowCircle(100, c).rho;
		assert.ok(r < prev, `radius should fall towards full moon, at ${c}`);
		prev = r;
	}
});

test('lit centroid offset agrees with a numerical integral', () => {
	for (const cosI of [-0.8, -0.3, 0.2, 0.7]) {
		const n = 900;
		let m = 0, a = 0;
		for (let i = 0; i < n; i++) {
			const y = -1 + (2 * (i + 0.5)) / n;
			for (let j = 0; j < n; j++) {
				const x = -1 + (2 * (j + 0.5)) / n;
				if (x * x + y * y > 1) continue;
				if (!isLitExact(x, y, 0, 0, 1, U, cosI)) continue;
				a++;
				m += x * U[0] + y * U[1];
			}
		}
		assert.ok(Math.abs(m / a - litCentroidOffset(1, cosI)) < 3e-3, `cosI=${cosI}`);
	}
});
