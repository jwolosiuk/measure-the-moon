// Fitting the model to a mask, and the error budget.

import { shadowCircle, litFractionExact, circularModelBias, litCentroidOffset } from './geometry.js';

// Nelder-Mead. Five parameters, a cheap-ish objective, no derivatives
// available -- this is exactly its use case.
export function nelderMead(f, x0, { step = 1, maxEvals = 400, tol = 1e-7 } = {}) {
	const n = x0.length;
	const steps = Array.isArray(step) ? step : new Array(n).fill(step);
	let simplex = [{ x: x0.slice(), fx: f(x0) }];
	for (let i = 0; i < n; i++) {
		const x = x0.slice();
		x[i] += steps[i];
		simplex.push({ x, fx: f(x) });
	}
	let evals = n + 1;
	const centroid = () => {
		const c = new Array(n).fill(0);
		for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i].x[j] / n;
		return c;
	};
	while (evals < maxEvals) {
		simplex.sort((a, b) => a.fx - b.fx);
		if (Math.abs(simplex[n].fx - simplex[0].fx) < tol) break;
		const c = centroid();
		const worst = simplex[n];
		const move = (t) => c.map((ci, i) => ci + t * (worst.x[i] - ci));
		const xr = move(-1), fr = f(xr); evals++;
		if (fr < simplex[0].fx) {
			const xe = move(-2), fe = f(xe); evals++;
			simplex[n] = fe < fr ? { x: xe, fx: fe } : { x: xr, fx: fr };
		} else if (fr < simplex[n - 1].fx) {
			simplex[n] = { x: xr, fx: fr };
		} else {
			const xc = move(0.5), fc = f(xc); evals++;
			if (fc < worst.fx) {
				simplex[n] = { x: xc, fx: fc };
			} else {
				for (let i = 1; i <= n; i++) {
					const x = simplex[i].x.map((xi, j) => simplex[0].x[j] + 0.5 * (xi - simplex[0].x[j]));
					simplex[i] = { x, fx: f(x) }; evals++;
				}
			}
		}
	}
	simplex.sort((a, b) => a.fx - b.fx);
	return { x: simplex[0].x, fx: simplex[0].fx, evals };
}

// Params are packed as [cx, cy, R, theta, z] with cosI = tanh(z), so the
// optimiser runs unconstrained and still cannot leave the physical range.
export const pack = (p) => [p.cx, p.cy, p.R, p.theta, Math.atanh(Math.max(-0.999, Math.min(0.999, p.cosI)))];
export const unpack = (x) => ({ cx: x[0], cy: x[1], R: Math.abs(x[2]), theta: x[3], cosI: Math.tanh(x[4]) });

// Compare a model to the observed mask over the union of their bounding boxes.
// Returns intersection / union / symmetric difference, in pixels.
export function compare(params, variant, mask, w, h, obsArea, obsBox) {
	const { cx, cy, R, theta, cosI } = params;
	const ux = Math.cos(theta), uy = Math.sin(theta);
	const sc = shadowCircle(R, cosI);
	const sx = sc.straight ? 0 : cx + sc.t * ux, sy = sc.straight ? 0 : cy + sc.t * uy;
	const rho2 = sc.straight ? 0 : sc.rho * sc.rho;
	const wantInside = sc.mode === 'intersect';
	const s = -R * cosI, R2 = R * R;

	const x0 = Math.max(0, Math.min(obsBox[0], Math.floor(cx - R) - 1));
	const y0 = Math.max(0, Math.min(obsBox[1], Math.floor(cy - R) - 1));
	const x1 = Math.min(w - 1, Math.max(obsBox[2], Math.ceil(cx + R) + 1));
	const y1 = Math.min(h - 1, Math.max(obsBox[3], Math.ceil(cy + R) + 1));

	let inter = 0, model = 0;
	for (let y = y0; y <= y1; y++) {
		const row = y * w;
		for (let x = x0; x <= x1; x++) {
			const dx = x - cx, dy = y - cy;
			let lit = dx * dx + dy * dy <= R2;
			if (lit) {
				if (variant === 'exact') {
					const eta = -dx * uy + dy * ux;
					const q = 1 - (eta * eta) / R2;
					lit = (dx * ux + dy * uy) >= s * Math.sqrt(q > 0 ? q : 0);
				} else if (sc.straight) {
					lit = dx * ux + dy * uy >= 0;
				} else {
					const ex = x - sx, ey = y - sy;
					const d2 = ex * ex + ey * ey;
					lit = wantInside ? d2 <= rho2 : d2 >= rho2;
				}
			}
			if (lit) { model++; if (mask[row + x]) inter++; }
		}
	}
	const union = obsArea + model - inter;
	return { inter, model, union, symDiff: union - inter, iou: union ? inter / union : 0 };
}

// Fit one model variant to the mask, starting from the analytic guess.
//
// The objective is 1 - IoU plus a small pull towards aligning the model's
// centroid with the blob's. That second term costs nothing to evaluate and
// removes the one way this optimisation can fail outright: if the model starts
// with no overlap at all, IoU is exactly zero in every direction and the
// simplex sits on a flat plateau forever.
export function fitModel(guess, variant, obs, maxEvals = 400) {
	const { mask, w, h, area, bbox, centroid, touchesBorder } = obs;
	// A thin crescent and a huge mostly-off-frame gibbous can look alike over a
	// small patch, and on a blurred sliver the optimiser will happily run off to
	// the second one. Two facts rule it out: the widest width of the lit region
	// is the diameter at every phase, and if the blob does not reach the frame
	// edge then the whole Moon is inside the picture, so its disc must be too.
	const maxR = guess.callipers ? (guess.callipers / 2) * 1.6 : Infinity;
	const minR = guess.callipers ? (guess.callipers / 2) * 0.55 : 0;
	const diag = Math.hypot(w, h);

	const cost = (x) => {
		const p = unpack(x);
		if (!(p.R > 2) || !isFinite(p.R)) return 2;
		const c = compare(p, variant, mask, w, h, area, bbox);
		const off = litCentroidOffset(p.R, p.cosI);
		const mx = p.cx + off * Math.cos(p.theta), my = p.cy + off * Math.sin(p.theta);
		const pull = Math.hypot(mx - centroid[0], my - centroid[1]) / p.R;

		let penalty = Math.max(0, p.R / maxR - 1) + Math.max(0, minR / p.R - 1);
		if (!touchesBorder) {
			// How far the fitted disc pokes out of the frame, as a fraction of
			// its own radius.
			const out = Math.max(0, -(p.cx - p.R), -(p.cy - p.R), (p.cx + p.R) - w, (p.cy + p.R) - h);
			penalty += out / Math.max(p.R, 1);
		}
		return 1 - c.iou + 1e-3 * Math.min(pull, 10) + Math.min(penalty, 20);
	};
	const run = (start) => nelderMead(cost, pack(start), {
		step: [start.R * 0.04, start.R * 0.04, start.R * 0.04, 0.15, 0.3],
		maxEvals,
	});

	let best = run(guess);
	// Only if that went badly: a few restarts, since a bad segmentation can put
	// the analytic guess in the wrong basin.
	if (1 - best.fx < 0.75) {
		for (const alt of restarts(guess)) {
			const r = run(alt);
			if (r.fx < best.fx) best = r;
		}
	}
	const params = unpack(best.x);
	return { params, ...compare(params, variant, mask, w, h, area, bbox) };
}

function restarts(g) {
	const out = [];
	for (const dth of [-0.5, 0.5]) out.push({ ...g, theta: g.theta + dth });
	for (const sr of [1.12, 0.9]) out.push({ ...g, R: g.R * sr });
	for (const dc of [-0.3, 0.3]) out.push({ ...g, cosI: Math.max(-0.99, Math.min(0.99, g.cosI + dc)) });
	return out;
}

// Half-perimeter of the terminator ellipse (semi-axes R and |s|), Ramanujan.
function halfEllipsePerimeter(a, b) {
	if (b === 0) return 2 * a;
	const hh = ((a - b) * (a - b)) / ((a + b) * (a + b));
	return (Math.PI * (a + b) * (1 + (3 * hh) / (10 + Math.sqrt(4 - 3 * hh)))) / 2;
}

// The error budget. Deliberately not one number: the terms behave completely
// differently with phase and with how the photo was taken.
export function errorBudget({ params, iou, symDiff, litArea, edgeWidth, edgeUncertain, limbRms, limbCount }) {
	const { R, cosI } = params;
	const disc = Math.PI * R * R;
	const s = Math.abs(R * cosI);
	const kExact = litFractionExact(cosI);

	// 1. Where exactly is the edge? A soft limb means the threshold could sit
	//    anywhere inside the transition band, moving the whole outline by up to
	//    half its width. Scales with the perimeter, so it hurts thin crescents.
	const perimeter = Math.PI * R + halfEllipsePerimeter(R, s);
	// Too few rays gave a usable edge to trust the median, so double it rather
	// than quietly report a confident-looking number.
	const sigmaEdge = ((perimeter * (edgeWidth / 2)) / disc) * (edgeUncertain ? 2 : 1);

	// 2. How well does an idealised Moon match the actual blob at all? Half the
	//    symmetric difference is the area genuinely in dispute.
	const sigmaFit = (0.5 * symDiff) / disc;

	// 3. Radius uncertainty. k scales as 1/R², so it enters doubled.
	const sigmaR = limbCount > 0 ? (2 * kExact * (limbRms / Math.sqrt(limbCount))) / R : 0;

	// 4. Resolution. A crescent narrower than about two edge-transition widths
	//    is not resolved at all: thresholding a sub-pixel sliver widens it, and
	//    the radius then has to be inferred from that same sliver. Measured on
	//    the observed blob (area over its length), not on the fitted lune --
	//    the fitted one has already been widened by the very effect this term
	//    is meant to price in. Crescents only: near full Moon the thin lune is
	//    the dark one and the limb is a nearly complete circle, so R stays well
	//    determined.
	const luneWidth = litArea / (Math.PI * R);
	const unresolved = Math.max(0, 2 * edgeWidth - luneWidth);
	const sigmaRes = cosI < 0 ? (perimeter * 0.5 * unresolved) / disc : 0;

	const total = Math.sqrt(sigmaEdge ** 2 + sigmaFit ** 2 + sigmaR ** 2 + sigmaRes ** 2);
	return {
		sigmaEdge, sigmaFit, sigmaR, sigmaRes, total,
		// Not summed in: this one is a known bias, and the headline number is
		// the ellipse fit, which does not carry it.
		modelBias: circularModelBias(cosI),
		terms: [
			{ key: 'edge', label: 'Edge softness', value: sigmaEdge, detail: `limb transition ${edgeWidth.toFixed(1)} px${edgeUncertain ? ', poorly sampled (doubled)' : ''}` },
			{ key: 'fit', label: 'Shape mismatch', value: sigmaFit, detail: `IoU ${(iou * 100).toFixed(1)}%` },
			{ key: 'radius', label: 'Radius uncertainty', value: sigmaR, detail: `limb RMS ${limbRms.toFixed(2)} px over ${limbCount} px` },
			...(sigmaRes > 0 ? [{ key: 'res', label: 'Unresolved crescent', value: sigmaRes, detail: `lit sliver averages ${luneWidth.toFixed(1)} px across, against a ${edgeWidth.toFixed(1)} px edge` }] : []),
		],
	};
}

export function warnings({ params, iou, R, clipped, edgeWidth, touchesBorder }) {
	const out = [];
	const width = R * (1 - Math.abs(params.cosI)); // thickness of the thinner lune
	if (R < 20) out.push({ level: 'bad', text: `The Moon is only ${(2 * R).toFixed(0)} px across. Zoom in or move closer to the screen; below ~40 px the shape carries very little phase information.` });
	else if (R < 45) out.push({ level: 'warn', text: `Small target (${(2 * R).toFixed(0)} px across). Zooming in would tighten the estimate.` });
	if (clipped > 0.6) out.push({ level: 'bad', text: `${(clipped * 100).toFixed(0)}% of the lit area is clipped to pure white. The exposure has blown out the disc, so the outline is bloomed outwards and the result is optimistic.` });
	else if (clipped > 0.05) out.push({ level: 'warn', text: `${(clipped * 100).toFixed(0)}% of the lit area is clipped. Lower the exposure if you can.` });
	if (touchesBorder) out.push({ level: 'bad', text: 'The bright region touches the frame edge, so part of the Moon may be cut off.' });
	if (width < 6 && width > 0) out.push({ level: 'warn', text: `The thin lune is only ${width.toFixed(1)} px wide. Near new and near full, a pixel of boundary noise moves the answer a long way.` });
	if (iou < 0.9) out.push({ level: 'bad', text: `The bright blob only matches an ideal Moon to ${(iou * 100).toFixed(0)}%. Clouds, a foreground object or a second light source may be included.` });
	if (edgeWidth > 0.12 * R) out.push({ level: 'warn', text: 'The limb is very soft (haze, defocus or camera shake), which is the dominant error here.' });
	return out;
}
