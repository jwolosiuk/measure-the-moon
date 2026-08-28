import { litCentroidOffset, shadowCircle } from './geometry.js';
// Turning a photo into a binary "this pixel is lit Moon" mask, plus the
// measurements the error budget needs (edge softness, clipping, limb residual).

export function luminance(rgba, w, h) {
	const lum = new Uint8ClampedArray(w * h);
	for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
		lum[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
	}
	return lum;
}

// Otsu's method. The Moon on night sky is strongly bimodal, which is the one
// case Otsu is genuinely good at.
export function otsuThreshold(lum) {
	const hist = new Float64Array(256);
	for (let i = 0; i < lum.length; i++) hist[lum[i]]++;
	const total = lum.length;
	let sum = 0;
	for (let t = 0; t < 256; t++) sum += t * hist[t];
	let sumB = 0, wB = 0, best = 0, bestT = 128;
	for (let t = 0; t < 256; t++) {
		wB += hist[t];
		if (wB === 0) continue;
		const wF = total - wB;
		if (wF === 0) break;
		sumB += t * hist[t];
		const mB = sumB / wB, mF = (sum - sumB) / wF;
		const between = wB * wF * (mB - mF) * (mB - mF);
		if (between > best) { best = between; bestT = t; }
	}
	return bestT;
}

// Largest 8-connected blob above the threshold, with interior holes filled.
// Holes matter: maria and big craters can dip under the threshold and would
// otherwise be punched out of the lit area.
export function segment(lum, w, h, threshold) {
	const above = new Uint8Array(w * h);
	for (let i = 0; i < above.length; i++) above[i] = lum[i] >= threshold ? 1 : 0;

	const label = new Int32Array(w * h).fill(-1);
	const stack = new Int32Array(w * h);
	let best = -1, bestArea = 0, next = 0;
	for (let seed = 0; seed < above.length; seed++) {
		if (!above[seed] || label[seed] !== -1) continue;
		const id = next++;
		let sp = 0, area = 0;
		stack[sp++] = seed;
		label[seed] = id;
		while (sp > 0) {
			const p = stack[--sp];
			area++;
			const px = p % w, py = (p / w) | 0;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = px + dx, ny = py + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const q = ny * w + nx;
					if (above[q] && label[q] === -1) { label[q] = id; stack[sp++] = q; }
				}
			}
		}
		if (area > bestArea) { bestArea = area; best = id; }
	}
	const mask = new Uint8Array(w * h);
	if (best < 0) return { mask, area: 0, empty: true };
	for (let i = 0; i < mask.length; i++) if (label[i] === best) mask[i] = 1;

	fillHoles(mask, w, h);
	let area = 0, sx = 0, sy = 0;
	let minX = w, minY = h, maxX = -1, maxY = -1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!mask[y * w + x]) continue;
			area++; sx += x; sy += y;
			if (x < minX) minX = x; if (x > maxX) maxX = x;
			if (y < minY) minY = y; if (y > maxY) maxY = y;
		}
	}
	return {
		mask, area, empty: area === 0,
		centroid: [sx / area, sy / area],
		bbox: [minX, minY, maxX, maxY],
		touchesBorder: minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1,
	};
}

// Flood the background inwards from the border; anything left unset is a hole.
function fillHoles(mask, w, h) {
	const outside = new Uint8Array(w * h);
	const stack = [];
	for (let x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
	for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }
	while (stack.length) {
		const p = stack.pop();
		if (mask[p] || outside[p]) continue;
		outside[p] = 1;
		const px = p % w, py = (p / w) | 0;
		if (px > 0) stack.push(p - 1);
		if (px < w - 1) stack.push(p + 1);
		if (py > 0) stack.push(p - w);
		if (py < h - 1) stack.push(p + w);
	}
	for (let i = 0; i < mask.length; i++) if (!mask[i] && !outside[i]) mask[i] = 1;
}

// How far the bright region stands out from everything else, in grey levels.
// A blurred sliver lost in noise still produces a confident-looking blob, and
// this is what tells it apart from an actual Moon.
export function contrast(lum, mask) {
	let si = 0, ni = 0, so = 0, no = 0;
	for (let i = 0; i < mask.length; i++) {
		if (mask[i]) { si += lum[i]; ni++; } else { so += lum[i]; no++; }
	}
	if (!ni || !no) return 0;
	return si / ni - so / no;
}

export function boundaryPoints(mask, w, h) {
	const pts = [];
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!mask[y * w + x]) continue;
			if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
				!mask[y * w + x - 1] || !mask[y * w + x + 1] ||
				!mask[(y - 1) * w + x] || !mask[(y + 1) * w + x]) pts.push([x, y]);
		}
	}
	return pts;
}

// Andrew's monotone chain.
export function convexHull(points) {
	if (points.length < 3) return points.slice();
	const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower = [];
	for (const q of p) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
		lower.push(q);
	}
	const upper = [];
	for (let i = p.length - 1; i >= 0; i--) {
		const q = p[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
		upper.push(q);
	}
	lower.pop(); upper.pop();
	return lower.concat(upper);
}

// Initial guess for (centre, radius, Sun direction, phase) with no iteration.
//
// The trick is that the two cusps sit at cm ± R·v for EVERY phase, so the lit
// region's widest direction is always the cusp axis and that width is always
// the full diameter 2R. Get v by rotating calipers, and the rest follows:
// the disc centre is the midpoint of that extreme pair and the Sun axis is
// perpendicular to it. The phase comes from the measured area, not from the
// extent along the Sun axis -- that extent is R·(1 + cosI) for a gibbous Moon
// but a flat R for every crescent, because the cusps pin its near end.
export function initialGuess(hull, centroid, area) {
	let bestW = -1, bestAngle = 0, bestPair = null;
	for (let i = 0; i < 180; i++) {
		const a = (i * Math.PI) / 180;
		const vx = Math.cos(a), vy = Math.sin(a);
		let lo = Infinity, hi = -Infinity, loP = null, hiP = null;
		for (const p of hull) {
			const proj = p[0] * vx + p[1] * vy;
			if (proj < lo) { lo = proj; loP = p; }
			if (proj > hi) { hi = proj; hiP = p; }
		}
		if (hi - lo > bestW) { bestW = hi - lo; bestAngle = a; bestPair = [loP, hiP]; }
	}
	const R = bestW / 2;
	const cm = [(bestPair[0][0] + bestPair[1][0]) / 2, (bestPair[0][1] + bestPair[1][1]) / 2];
	// Sun axis: perpendicular to the cusp axis, pointing at the lit centroid.
	let ux = -Math.sin(bestAngle), uy = Math.cos(bestAngle);
	const dx = centroid[0] - cm[0], dy = centroid[1] - cm[1];
	if (dx * ux + dy * uy < 0) { ux = -ux; uy = -uy; }
	const k = Math.max(0.001, Math.min(0.999, area / (Math.PI * R * R)));
	const cosI = Math.max(-0.999, Math.min(0.999, 2 * k - 1));
	// Place the disc so that the model's centroid lands on the measured one,
	// rather than trusting the extreme pair -- see litCentroidOffset.
	const off = litCentroidOffset(R, cosI);
	return {
		cx: centroid[0] - off * ux,
		cy: centroid[1] - off * uy,
		R, theta: Math.atan2(uy, ux), cosI,
		// The widest caliper width IS the diameter, at every phase, so it also
		// bounds how far the fit may wander. Thresholding clips the tapering
		// tips off a crescent, so allow generous headroom upwards only.
		callipers: bestW,
	};
}

// How soft is the lit limb, in pixels? This is the honest scale of "where
// exactly is the edge", and for a hand-held phone shot it is usually the
// dominant error term.
//
// Measured as amplitude / peak-gradient rather than by 10%-to-90% crossings.
// Crossings need a flat plateau on both sides, and a thin crescent that is
// blurrier than it is wide never has one -- which is exactly the case where
// the softness matters most. For a Gaussian-blurred step of height A the peak
// gradient is A/(sigma*sqrt(2pi)) and the 10-90 width is 2.563*sigma, so
// width = 1.0225 * A / gmax, with no plateau required.
export function limbEdgeWidth(lum, w, h, cx, cy, R, theta) {
	const widths = [];
	for (let i = 0; i < 24; i++) {
		// Rays fanned across the lit limb only (±80 deg around the Sun axis).
		const a = theta + ((i / 23) * 2 - 1) * (80 * Math.PI / 180);
		const dx = Math.cos(a), dy = Math.sin(a);
		const step = 0.5;
		const prof = [];
		for (let r = R * 0.55; r <= R * 1.45; r += step) {
			const x = cx + dx * r, y = cy + dy * r;
			if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) { prof.length = 0; break; }
			prof.push(sampleBilinear(lum, w, h, x, y));
		}
		if (prof.length < 9) continue;
		// Light smoothing first: pixel noise otherwise fakes a huge gradient
		// and makes every edge look razor sharp.
		const sm = prof.map((_, j) => {
			const a0 = prof[Math.max(0, j - 1)], a1 = prof[j], a2 = prof[Math.min(prof.length - 1, j + 1)];
			return (a0 + 2 * a1 + a2) / 4;
		});
		let hi = -Infinity, lo = Infinity, gmax = 0;
		for (let j = 0; j < sm.length; j++) {
			if (sm[j] > hi) hi = sm[j];
			if (sm[j] < lo) lo = sm[j];
			if (j > 0) gmax = Math.max(gmax, Math.abs(sm[j] - sm[j - 1]) / step);
		}
		const amp = hi - lo;
		if (amp < 15 || gmax <= 0) continue; // no usable edge along this ray
		widths.push(Math.max(1, Math.min(0.5 * R, (1.0225 * amp) / gmax)));
	}
	if (widths.length === 0) return { width: 0.05 * R, samples: 0, uncertain: true };
	widths.sort((a, b) => a - b);
	return {
		width: widths[widths.length >> 1],
		samples: widths.length,
		uncertain: widths.length < 6,
	};
}

export function sampleBilinear(lum, w, h, x, y) {
	const x0 = Math.floor(x), y0 = Math.floor(y);
	const fx = x - x0, fy = y - y0;
	const at = (xx, yy) => lum[Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))];
	return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
		at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
}

// Fraction of the lit region that is clipped white. High values mean the
// exposure blew out the disc and the shape carries little phase information.
export function clippedFraction(lum, mask) {
	let lit = 0, clipped = 0;
	for (let i = 0; i < mask.length; i++) {
		if (!mask[i]) continue;
		lit++;
		if (lum[i] >= 250) clipped++;
	}
	return lit ? clipped / lit : 0;
}

// RMS radial residual of the boundary points that lie on the lit limb. Feeds
// the uncertainty on R.
//
// Being near the fitted radius is not enough to be a limb point: a good part of
// the terminator also runs close to it, and counting those inflates the figure
// with a deviation that is not limb noise at all. So each candidate is assigned
// to whichever of the two curves it is actually closer to.
export function limbResidual(boundary, params) {
	const { cx, cy, R, theta, cosI } = params;
	const ux = Math.cos(theta), uy = Math.sin(theta);
	const sc = shadowCircle(R, cosI);
	const sx = cx + (sc.straight ? 0 : sc.t * ux);
	const sy = cy + (sc.straight ? 0 : sc.t * uy);
	let n = 0, sum = 0;
	for (const [x, y] of boundary) {
		const dLimb = Math.hypot(x - cx, y - cy) - R;
		if (Math.abs(dLimb) > 0.25 * R) continue;
		const dTerm = sc.straight
			? Math.abs((x - cx) * ux + (y - cy) * uy)
			: Math.abs(Math.hypot(x - sx, y - sy) - sc.rho);
		if (Math.abs(dLimb) > dTerm) continue; // belongs to the terminator
		sum += dLimb * dLimb;
		n++;
	}
	return { rms: n ? Math.sqrt(sum / n) : 0, count: n };
}
