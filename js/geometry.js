// Geometry of the lunar terminator, and the two-circle approximation of it.
//
// Coordinates: the Moon's disc is a circle of radius R centred at `cm`. `u` is
// the unit vector pointing towards the Sun (towards the middle of the lit
// limb), `v` is `u` rotated by +90 deg. The two cusps always sit at `cm ± R·v`,
// for every phase, so the lit limb is always exactly a half-circle.
//
// The phase is one number: cosI = cos of the phase angle, in [-1, 1].
//   cosI = +1  full        cosI =  0  quarter        cosI = -1  new
// The terminator's apex lies at `cm + s·u` with
//   s = -R · cosI
// so it is on the far (anti-Sun) side for a gibbous Moon and on the near side
// for a crescent.

// True illuminated fraction of the disc. The terminator projects to a
// half-ellipse with semi-axes R (along v) and |s| (along u), so the lit area is
// a half-disc plus/minus a half-ellipse and the fraction collapses to this.
export function litFractionExact(cosI) {
	return (1 + cosI) / 2;
}

// Area cut off by a circular arc that spans a diameter of the unit disc (chord
// length 2) and bulges a height h past it, h in [0, 1]. Used by the two-circle
// model, where the terminator is a circular arc rather than an ellipse arc.
export function arcBulgeArea(h) {
	if (h <= 1e-12) return 0;
	if (h > 1) h = 1;
	const rho = (1 + h * h) / (2 * h); // radius of the arc's own circle
	return rho * rho * Math.acos((1 - h * h) / (1 + h * h)) - (1 - h * h) / (2 * h);
}

// Illuminated fraction the two-circle model reports for the same geometry.
// Agrees with the truth exactly at quarter, full and new; biased in between.
export function litFractionCircular(cosI) {
	const bulge = arcBulgeArea(Math.abs(cosI)) / Math.PI;
	return 0.5 + (cosI >= 0 ? bulge : -bulge);
}

// Signed error the circular arc introduces. Peaks at about +/- 2.8 points.
export function circularModelBias(cosI) {
	return litFractionCircular(cosI) - litFractionExact(cosI);
}

// The second circle: the one whose arc runs through both cusps and the
// terminator apex. Returned offset `t` is measured from the disc centre along
// u. `mode` says how to combine it with the disc to get the lit region --
// this is the operation that has to flip, because an intersection of two
// circles is convex and a crescent is not.
export function shadowCircle(R, cosI) {
	const c = Math.max(-1, Math.min(1, cosI));
	const mode = c >= 0 ? 'intersect' : 'subtract';
	if (Math.abs(c) < 1e-6) {
		// Quarter Moon: the arc degenerates into the straight cusp line.
		return { t: Infinity, rho: Infinity, mode, straight: true };
	}
	return {
		t: (R * (1 - c * c)) / (2 * c),
		rho: (R * (1 + c * c)) / (2 * Math.abs(c)),
		mode,
		straight: false,
	};
}

// Is a point lit, according to the two-circle model? `p` and `cm` are [x, y],
// `u` is the unit Sun direction.
export function isLitCircular(px, py, cmx, cmy, R, u, cosI) {
	const dx = px - cmx, dy = py - cmy;
	if (dx * dx + dy * dy > R * R) return false;
	const sc = shadowCircle(R, cosI);
	if (sc.straight) return dx * u[0] + dy * u[1] >= 0;
	const ex = dx - sc.t * u[0], ey = dy - sc.t * u[1];
	const d2 = ex * ex + ey * ey, r2 = sc.rho * sc.rho;
	return sc.mode === 'intersect' ? d2 <= r2 : d2 >= r2;
}

// Is a point lit, according to the exact half-ellipse terminator?
export function isLitExact(px, py, cmx, cmy, R, u, cosI) {
	const dx = px - cmx, dy = py - cmy;
	if (dx * dx + dy * dy > R * R) return false;
	const xi = dx * u[0] + dy * u[1];          // along the Sun axis
	const eta = -dx * u[1] + dy * u[0];        // along the cusp axis
	const q = 1 - (eta * eta) / (R * R);
	const s = -R * cosI;
	return xi >= s * Math.sqrt(Math.max(0, q));
}

// Distance from the disc centre to the centroid of the lit region, along the
// Sun axis. Integrating the half-disc plus the half-ellipse collapses to this:
//   xi = 4R(1 - cosI) / 3pi
// Used to place the model on the blob before optimising -- a thin crescent's
// tips fall under any threshold, which drags a purely geometric centre guess
// sideways, and if the model starts with zero overlap then IoU is flat at zero
// and the optimiser has nothing to descend.
export function litCentroidOffset(R, cosI) {
	return (4 * R * (1 - cosI)) / (3 * Math.PI);
}
