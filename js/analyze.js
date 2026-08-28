// End to end: pixels in, illuminated fraction with an uncertainty out.

import * as V from './vision.js';
import { fitModel, errorBudget, warnings } from './fit.js';
import { litFractionExact, litFractionCircular, shadowCircle } from './geometry.js';

export function shapeName(k) {
	if (k < 0.02) return 'New';
	if (k < 0.45) return 'Crescent';
	if (k < 0.55) return 'Quarter';
	if (k < 0.98) return 'Gibbous';
	return 'Full';
}

export function analyze(rgba, w, h, { maxEvals = 400 } = {}) {
	const lum = V.luminance(rgba, w, h);
	const threshold = V.otsuThreshold(lum);
	const seg = V.segment(lum, w, h, threshold);
	if (seg.empty || seg.area < 60) {
		return { ok: false, reason: 'Nothing bright enough to measure. Point the camera at the Moon, or load a photo of it.' };
	}
	// Refuse before fitting if the bright region is barely brighter than its
	// surroundings. A crescent thinner than the blur that hides it still leaves
	// a blob for Otsu to find, and fitting it produces a confident-looking
	// number with nothing behind it.
	const contrast = V.contrast(lum, seg.mask);
	if (contrast < 18) {
		return {
			ok: false,
			reason: `The brightest region is only ${contrast.toFixed(0)} grey levels above the background, which is not enough to be a Moon. Try a sharper or better-exposed photo.`,
		};
	}

	const boundary = V.boundaryPoints(seg.mask, w, h);
	const hull = V.convexHull(boundary);
	if (hull.length < 3) return { ok: false, reason: 'The bright region is too small or too thin to fit.' };

	const guess = V.initialGuess(hull, seg.centroid, seg.area);
	if (!(guess.R > 3)) return { ok: false, reason: 'The bright region is too small to fit a disc to.' };

	// Two fits of the same blob: the exact half-ellipse terminator, and the
	// circular-arc approximation that the two drawn circles represent.
	const obs = {
		mask: seg.mask, w, h, area: seg.area, bbox: seg.bbox,
		centroid: seg.centroid, touchesBorder: seg.touchesBorder,
	};
	const exact = fitModel(guess, 'exact', obs, maxEvals);
	const circular = fitModel(guess, 'circular', obs, maxEvals);

	const p = exact.params;
	const disc = Math.PI * p.R * p.R;
	const edge = V.limbEdgeWidth(lum, w, h, p.cx, p.cy, p.R, p.theta);
	const limb = V.limbResidual(boundary, p.cx, p.cy, p.R);
	const clipped = V.clippedFraction(lum, seg.mask);

	const budget = errorBudget({
		params: p, iou: exact.iou, symDiff: exact.symDiff, litArea: seg.area,
		edgeWidth: edge.width, edgeUncertain: edge.uncertain,
		limbRms: limb.rms, limbCount: limb.count, clipped,
	});

	const k = litFractionExact(p.cosI);
	return {
		ok: true,
		k,
		sigma: budget.total,
		kCircular: litFractionCircular(circular.params.cosI),
		// Model-free cross-check: just how many lit pixels there are, divided by
		// the area of the fitted disc. Uses no terminator model at all.
		kArea: seg.area / disc,
		shape: shapeName(k),
		params: p,
		circularParams: circular.params,
		circles: drawableCircles(circular.params),
		iou: exact.iou,
		iouCircular: circular.iou,
		budget,
		threshold,
		contrast,
		edgeWidth: edge.width,
		edgeUncertain: edge.uncertain,
		clipped,
		mask: seg.mask,
		warnings: warnings({
			params: p, iou: exact.iou, R: p.R, clipped, edgeWidth: edge.width,
			edgeUncertain: edge.uncertain, touchesBorder: seg.touchesBorder, litArea: seg.area,
		}),
	};
}

// The two circles to draw: the limb, and the one whose arc is the terminator.
// Near quarter phase the second one's radius runs off to infinity, so past a
// point we report a straight line instead of a uselessly huge circle.
export function drawableCircles(params) {
	const { cx, cy, R, theta, cosI } = params;
	const ux = Math.cos(theta), uy = Math.sin(theta);
	const sc = shadowCircle(R, cosI);
	const limb = { cx, cy, r: R };
	if (sc.straight || sc.rho > 40 * R) {
		return { limb, shadow: null, straight: { x: cx, y: cy, ux: -uy, uy: ux }, mode: sc.mode };
	}
	return {
		limb,
		shadow: { cx: cx + sc.t * ux, cy: cy + sc.t * uy, r: sc.rho },
		straight: null,
		mode: sc.mode, // 'intersect' for gibbous, 'subtract' for crescent
	};
}
