// jsdom has no canvas, and the real node-canvas needs a native build. The app
// only ever asks a canvas for four things -- scale an image into it, read the
// pixels back, write pixels in, and draw decoration on top -- so a shim that
// stores a pixel buffer and no-ops the decoration exercises the whole pipeline
// for real: the analysis in the smoke test runs on genuinely scaled pixels.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

function pixels(canvas) {
	const w = Math.max(1, canvas.width | 0), h = Math.max(1, canvas.height | 0);
	if (!canvas.__px || canvas.__w !== w || canvas.__h !== h) {
		canvas.__px = new Uint8ClampedArray(w * h * 4);
		canvas.__w = w;
		canvas.__h = h;
	}
	return canvas.__px;
}

function makeContext(canvas) {
	return {
		canvas,
		// Decoration: accepted and discarded.
		beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {},
		fill() {}, stroke() {}, setLineDash() {}, save() {}, restore() {},
		clearRect() {}, fillRect() {},

		drawImage(src, dx = 0, dy = 0, dw, dh) {
			const sp = src.__px || pixels(src);
			const sw = src.__w || src.width, sh = src.__h || src.height;
			const tw = dw === undefined ? sw : Math.round(dw);
			const th = dh === undefined ? sh : Math.round(dh);
			const dst = pixels(canvas);
			const W = canvas.__w, H = canvas.__h;
			for (let y = 0; y < th; y++) {
				const ty = (dy | 0) + y;
				if (ty < 0 || ty >= H) continue;
				const sy = Math.min(sh - 1, Math.floor((y * sh) / th));
				for (let x = 0; x < tw; x++) {
					const tx = (dx | 0) + x;
					if (tx < 0 || tx >= W) continue;
					const sx = Math.min(sw - 1, Math.floor((x * sw) / tw));
					const s = (sy * sw + sx) * 4, d = (ty * W + tx) * 4;
					dst[d] = sp[s]; dst[d + 1] = sp[s + 1]; dst[d + 2] = sp[s + 2]; dst[d + 3] = sp[s + 3];
				}
			}
		},

		getImageData(x, y, w, h) {
			const src = pixels(canvas);
			const W = canvas.__w;
			const out = new Uint8ClampedArray(w * h * 4);
			for (let j = 0; j < h; j++) {
				for (let i = 0; i < w; i++) {
					const s = ((y + j) * W + (x + i)) * 4, d = (j * w + i) * 4;
					out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
				}
			}
			return { data: out, width: w, height: h };
		},

		putImageData(img, dx = 0, dy = 0) {
			const dst = pixels(canvas);
			const W = canvas.__w, H = canvas.__h;
			for (let j = 0; j < img.height; j++) {
				for (let i = 0; i < img.width; i++) {
					const ty = dy + j, tx = dx + i;
					if (ty < 0 || ty >= H || tx < 0 || tx >= W) continue;
					const s = (j * img.width + i) * 4, d = (ty * W + tx) * 4;
					dst[d] = img.data[s]; dst[d + 1] = img.data[s + 1];
					dst[d + 2] = img.data[s + 2]; dst[d + 3] = img.data[s + 3];
				}
			}
		},
	};
}

export function boot(htmlPath) {
	const dom = new JSDOM(fs.readFileSync(htmlPath, 'utf8'), { pretendToBeVisual: true });
	const { window } = dom;

	// jsdom does not fetch the external stylesheet, so visibility bugs where
	// CSS overrides the hidden attribute are invisible to it. Inline the real
	// stylesheet so getComputedStyle answers for the page as actually served.
	const cssPath = new URL('styles.css', 'file://' + htmlPath).pathname;
	if (fs.existsSync(cssPath)) {
		const style = window.document.createElement('style');
		style.textContent = fs.readFileSync(cssPath, 'utf8');
		window.document.head.appendChild(style);
	}

	window.HTMLCanvasElement.prototype.getContext = function () {
		if (!this.__ctx) this.__ctx = makeContext(this);
		return this.__ctx;
	};
	class ImageDataShim {
		constructor(data, width, height) {
			this.data = data;
			this.width = width;
			this.height = height === undefined ? data.length / 4 / width : height;
		}
	}
	window.ImageData = ImageDataShim;
	window.HTMLMediaElement.prototype.play = () => Promise.resolve();

	globalThis.window = window;
	globalThis.document = window.document;
	globalThis.ImageData = ImageDataShim;
	globalThis.Image = window.Image;
	Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
	return dom;
}
