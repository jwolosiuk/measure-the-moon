// UI wiring: get pixels from somewhere, analyse them, draw the model, explain
// the number. All of it in the browser -- nothing leaves the device.

import { analyze } from './analyze.js';
import * as overlay from './overlay.js';
import { renderMoon } from './demo.js';

const VERSION = '1.0';
const WORK_STILL = 420; // px on the long side for a one-off measurement
const WORK_LIVE = 288;  // smaller while the camera is running, to keep up

const $ = (id) => document.getElementById(id);
const view = $('view');
const vctx = view.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const cam = $('cam');

let liveTimer = null;
let stream = null;
let lastResult = null;
let lastSource = null;   // { el, w, h }
let demoTruth = null;    // known lit fraction when the demo is driving

/* ---------- analysis ---------- */

function measure(source, sw, sh, { live = false } = {}) {
	if (!sw || !sh) return;
	const target = live ? WORK_LIVE : WORK_STILL;
	const scale = Math.min(1, target / Math.max(sw, sh));
	work.width = Math.max(8, Math.round(sw * scale));
	work.height = Math.max(8, Math.round(sh * scale));
	wctx.drawImage(source, 0, 0, work.width, work.height);
	const img = wctx.getImageData(0, 0, work.width, work.height);

	const result = analyze(img.data, work.width, work.height, { maxEvals: live ? 160 : 500 });
	lastResult = result;
	lastSource = { el: source, w: sw, h: sh };
	render(source, sw, sh, result);
	return result;
}

function render(source, sw, sh, result) {
	// Display at a sane size; the model is in work-canvas coordinates, so it
	// scales by the ratio between the two.
	const box = $('viewport').getBoundingClientRect();
	const maxW = Math.max(320, Math.min(900, box.width || 640));
	const maxH = Math.max(240, (box.height || 480));
	const s = Math.min(maxW / sw, maxH / sh);
	view.width = Math.round(sw * s);
	view.height = Math.round(sh * s);
	vctx.drawImage(source, 0, 0, view.width, view.height);

	$('placeholder').hidden = true;
	if (!result.ok) {
		showFailure(result.reason);
		return;
	}
	overlay.draw(vctx, result, view.width / work.width, {
		showRegion: $('l-region').checked,
		showCircles: $('l-circles').checked,
		showExact: $('l-exact').checked,
	});
	showResult(result);
}

/* ---------- readout ---------- */

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const pp = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)} pp`;

function showFailure(reason) {
	$('readout').hidden = false;
	$('k-value').textContent = '—';
	$('k-sigma').textContent = '—';
	$('k-shape').textContent = 'no measurement';
	$('k-truth').hidden = true;
	$('budget').innerHTML = '';
	$('budget-total').textContent = '—';
	for (const id of ['m-exact', 'm-circ', 'm-bias', 'm-area']) $(id).textContent = '—';
	$('diag-rows').innerHTML = '';
	$('warnings').innerHTML = `<div class="note bad">${reason}</div>`;
}

function showResult(r) {
	$('readout').hidden = false;
	$('k-value').textContent = pct(r.k, 1);
	$('k-sigma').textContent = pct(r.sigma, 1);
	$('k-shape').textContent = r.shape;

	if (demoTruth !== null) {
		const err = r.k - demoTruth;
		const el = $('k-truth');
		el.hidden = false;
		const inside = Math.abs(err) <= r.sigma;
		el.className = 'truth' + (inside ? '' : ' off');
		el.textContent = `Demo truth ${pct(demoTruth, 1)} · measured off by ${pp(err)} · ` +
			(inside ? 'inside the quoted band' : 'outside the quoted band');
	} else {
		$('k-truth').hidden = true;
	}

	$('m-exact').textContent = pct(r.k, 2);
	$('m-circ').textContent = pct(r.kCircular, 2);
	$('m-bias').textContent = pp(r.kCircular - r.k, 2);
	$('m-area').textContent = pct(r.kArea, 2);

	const maxTerm = Math.max(1e-9, ...r.budget.terms.map((t) => t.value));
	$('budget').innerHTML = r.budget.terms.map((t) => `
		<div class="bar-row">
			<div class="bar-head"><span>${t.label}</span><span class="v">±${pct(t.value, 2)}</span></div>
			<div class="bar"><i style="width:${(t.value / maxTerm) * 100}%"></i></div>
			<div class="bar-detail">${t.detail}</div>
		</div>`).join('');
	$('budget-total').textContent = `±${pct(r.budget.total, 2)}`;

	$('warnings').innerHTML = r.warnings
		.map((w) => `<div class="note ${w.level === 'bad' ? 'bad' : ''}">${w.text}</div>`)
		.join('');

	const d = [
		['Fitted radius', `${r.params.R.toFixed(1)} px (${(2 * r.params.R).toFixed(0)} px across)`],
		['Shape match (IoU)', `${pct(r.iou, 1)} exact · ${pct(r.iouCircular, 1)} circular`],
		['Limb transition width', `${r.edgeWidth.toFixed(2)} px`],
		['Clipped to white', pct(r.clipped, 1)],
		['Otsu threshold', `${r.threshold} / 255`],
		['Phase angle cos i', r.params.cosI.toFixed(4)],
		['Terminator circle radius', r.circles.shadow
			? `${r.circles.shadow.r.toFixed(0)} px (${(r.circles.shadow.r / r.params.R).toFixed(1)}× the limb)`
			: 'infinite — drawn as a straight line'],
		['Combination', r.circles.mode === 'intersect' ? 'disc ∩ circle (gibbous)' : 'disc − circle (crescent)'],
	];
	$('diag-rows').innerHTML = d
		.map(([k, v]) => `<div class="row"><span class="lbl">${k}</span><span class="val">${v}</span></div>`)
		.join('');
}

/* ---------- camera ---------- */

async function startCamera() {
	stopDemo();
	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
		showFailure('This browser will not give a web page camera access. Open a photo instead.');
		return;
	}
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
			audio: false,
		});
	} catch (err) {
		const msg = err && err.name === 'NotAllowedError'
			? 'Camera permission was refused. You can still open a photo, or try the demo.'
			: `Could not open the camera (${err && err.name ? err.name : 'unknown error'}). Opening a photo works just as well — usually better, since phone cameras overexpose the Moon.`;
		showFailure(msg);
		return;
	}
	cam.srcObject = stream;
	await cam.play().catch(() => {});
	$('livebadge').hidden = false;
	$('btn-cam').textContent = 'Stop camera';
	$('btn-freeze').hidden = false;
	liveTimer = setInterval(() => {
		if (cam.videoWidth) measure(cam, cam.videoWidth, cam.videoHeight, { live: true });
	}, 180);
}

function stopCamera() {
	if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
	if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
	$('livebadge').hidden = true;
	$('btn-cam').textContent = 'Use camera';
	$('btn-freeze').hidden = true;
}

function freeze() {
	if (!cam.videoWidth) return;
	// Keep the frame, drop the live feed, then measure it properly.
	const snap = document.createElement('canvas');
	snap.width = cam.videoWidth;
	snap.height = cam.videoHeight;
	snap.getContext('2d').drawImage(cam, 0, 0);
	stopCamera();
	measure(snap, snap.width, snap.height);
}

/* ---------- demo ---------- */

function stopDemo() {
	demoTruth = null;
	$('demo-panel').hidden = true;
}

function runDemo() {
	stopCamera();
	$('demo-panel').hidden = false;
	const k = $('demo-phase').valueAsNumber / 1000;
	const blur = $('demo-blur').valueAsNumber / 10;
	const noise = $('demo-noise').valueAsNumber;
	$('demo-phase-val').textContent = `${(k * 100).toFixed(0)}%`;
	$('demo-blur-val').textContent = `${blur.toFixed(1)} px`;
	$('demo-noise-val').textContent = String(noise);

	const W = 480, H = 360;
	const cosI = Math.max(-0.999, Math.min(0.999, 2 * k - 1));
	const rgba = renderMoon(W, H, {
		cx: W / 2, cy: H / 2, R: 128, theta: -0.45, cosI, blur, noise,
	});
	const c = document.createElement('canvas');
	c.width = W; c.height = H;
	c.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
	demoTruth = (1 + cosI) / 2;
	measure(c, W, H);
}

/* ---------- wiring ---------- */

$('btn-cam').addEventListener('click', () => (stream ? stopCamera() : startCamera()));
$('btn-freeze').addEventListener('click', freeze);
$('btn-demo').addEventListener('click', runDemo);
for (const id of ['demo-phase', 'demo-blur', 'demo-noise']) {
	$(id).addEventListener('input', () => { if (!$('demo-panel').hidden) runDemo(); });
}

$('file').addEventListener('change', (e) => {
	const f = e.target.files && e.target.files[0];
	if (!f) return;
	stopCamera();
	stopDemo();
	const img = new Image();
	img.onload = () => { measure(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(img.src); };
	img.onerror = () => showFailure('That file could not be read as an image.');
	img.src = URL.createObjectURL(f);
	e.target.value = '';
});

for (const id of ['l-region', 'l-circles', 'l-exact']) {
	$(id).addEventListener('change', () => {
		if (lastResult && lastSource) render(lastSource.el, lastSource.w, lastSource.h, lastResult);
	});
}

window.addEventListener('resize', () => {
	if (lastResult && lastSource && !stream) render(lastSource.el, lastSource.w, lastSource.h, lastResult);
});

$('ver').textContent = `v${VERSION}`;
