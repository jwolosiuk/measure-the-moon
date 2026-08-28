// Drawing the fitted model on top of the frame.

import { shadowCircle } from './geometry.js';

// Points along the terminator, in image coordinates. `variant` picks the
// circular arc (what the two drawn circles actually produce) or the exact
// half-ellipse, so both can be shown at once and the gap between them is the
// model bias made visible.
export function terminatorPath(params, variant, n = 160) {
	const { cx, cy, R, theta, cosI } = params;
	const ux = Math.cos(theta), uy = Math.sin(theta);
	const s = -R * cosI;
	const pts = [];
	if (variant === 'exact') {
		for (let i = 0; i <= n; i++) {
			const eta = R * (1 - (2 * i) / n);
			const xi = s * Math.sqrt(Math.max(0, 1 - (eta * eta) / (R * R)));
			pts.push([cx + xi * ux - eta * uy, cy + xi * uy + eta * ux]);
		}
		return pts;
	}
	const sc = shadowCircle(R, cosI);
	for (let i = 0; i <= n; i++) {
		const eta = R * (1 - (2 * i) / n);
		let xi;
		if (sc.straight) {
			xi = 0;
		} else {
			// The arc of the shadow circle, expressed over the same cusp axis.
			const inside = sc.rho * sc.rho - eta * eta;
			const root = Math.sqrt(Math.max(0, inside));
			xi = sc.mode === 'intersect' ? sc.t - root : sc.t + root;
		}
		pts.push([cx + xi * ux - eta * uy, cy + xi * uy + eta * ux]);
	}
	return pts;
}

// The lit limb: the half of the Moon's own circle that is always lit, cusp to
// cusp through the sunward point.
export function limbPath(params, n = 160) {
	const { cx, cy, R, theta } = params;
	const pts = [];
	for (let i = 0; i <= n; i++) {
		const a = theta + Math.PI / 2 - (i / n) * Math.PI;
		pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
	}
	return pts;
}

function trace(ctx, pts, scale) {
	ctx.beginPath();
	ctx.moveTo(pts[0][0] * scale, pts[0][1] * scale);
	for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * scale, pts[i][1] * scale);
}

export function draw(ctx, result, scale, opts = {}) {
	const { showCircles = true, showRegion = true, showExact = true } = opts;
	const cp = result.circularParams;
	const ep = result.params;

	if (showRegion) {
		// The lit region as the two-circle model has it: limb half-circle from
		// cusp to cusp, closed by the terminator arc.
		const pts = limbPath(cp).concat(terminatorPath(cp, 'circular').reverse());
		trace(ctx, pts, scale);
		ctx.closePath();
		ctx.fillStyle = 'rgba(120, 190, 255, 0.22)';
		ctx.fill();
		ctx.strokeStyle = 'rgba(140, 205, 255, 0.95)';
		ctx.lineWidth = 2;
		ctx.stroke();
	}

	if (showCircles) {
		const circles = result.circles;
		ctx.setLineDash([6, 5]);
		ctx.lineWidth = 1.5;
		// Circle 1: the Moon's limb.
		ctx.strokeStyle = 'rgba(255, 214, 120, 0.9)';
		ctx.beginPath();
		ctx.arc(circles.limb.cx * scale, circles.limb.cy * scale, circles.limb.r * scale, 0, Math.PI * 2);
		ctx.stroke();
		// Circle 2: the one whose arc is the terminator. Near quarter phase its
		// radius runs off to infinity, so draw the limiting straight line.
		ctx.strokeStyle = 'rgba(255, 130, 160, 0.9)';
		ctx.beginPath();
		if (circles.shadow) {
			ctx.arc(circles.shadow.cx * scale, circles.shadow.cy * scale, circles.shadow.r * scale, 0, Math.PI * 2);
		} else {
			const L = 4000;
			const st = circles.straight;
			ctx.moveTo((st.x - st.ux * L) * scale, (st.y - st.uy * L) * scale);
			ctx.lineTo((st.x + st.ux * L) * scale, (st.y + st.uy * L) * scale);
		}
		ctx.stroke();
		ctx.setLineDash([]);
	}

	if (showExact) {
		// The physically correct terminator, for comparison with the circular
		// arc above. The visible gap between them IS the model bias.
		trace(ctx, terminatorPath(ep, 'exact'), scale);
		ctx.strokeStyle = 'rgba(130, 255, 190, 0.95)';
		ctx.lineWidth = 2;
		ctx.stroke();
	}

	// Cusps.
	const ux = Math.cos(cp.theta), uy = Math.sin(cp.theta);
	for (const sgn of [1, -1]) {
		const x = (cp.cx - sgn * cp.R * uy) * scale;
		const y = (cp.cy + sgn * cp.R * ux) * scale;
		ctx.beginPath();
		ctx.arc(x, y, 3.5, 0, Math.PI * 2);
		ctx.fillStyle = 'rgba(255,255,255,0.9)';
		ctx.fill();
	}
}
