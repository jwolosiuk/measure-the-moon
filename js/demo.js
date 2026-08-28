// Renders a Moon of known phase. Used both by the in-app demo mode -- so the
// app is usable in daylight, or from a desk -- and by the test suite, which
// grades the analyser against these known-truth images.
import { isLitExact } from './geometry.js';

export function renderMoon(w, h, { cx, cy, R, theta, cosI, blur = 0, noise = 0, peak = 235, sky = 6, seed = 1 }) {
	const u = [Math.cos(theta), Math.sin(theta)];
	const gray = new Float64Array(w * h);
	const SS = 4; // supersample, so partial edge pixels are honest
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let n = 0;
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					if (isLitExact(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, cx, cy, R, u, cosI)) n++;
				}
			}
			gray[y * w + x] = sky + (peak - sky) * (n / (SS * SS));
		}
	}
	if (blur > 0) gaussianBlur(gray, w, h, blur);
	let s = seed;
	const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
	const rgba = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const v = Math.max(0, Math.min(255, gray[i] + (noise ? rnd() * noise * 2 : 0)));
		rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
	}
	return rgba;
}

function gaussianBlur(buf, w, h, sigma) {
	const rad = Math.max(1, Math.ceil(sigma * 3));
	const kern = [];
	let sum = 0;
	for (let i = -rad; i <= rad; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); kern.push(v); sum += v; }
	for (let i = 0; i < kern.length; i++) kern[i] /= sum;
	const tmp = new Float64Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		let acc = 0;
		for (let i = -rad; i <= rad; i++) acc += kern[i + rad] * buf[y * w + Math.min(w - 1, Math.max(0, x + i))];
		tmp[y * w + x] = acc;
	}
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		let acc = 0;
		for (let i = -rad; i <= rad; i++) acc += kern[i + rad] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
		buf[y * w + x] = acc;
	}
}
