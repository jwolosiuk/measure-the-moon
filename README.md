# Measure the Moon

Point a camera at the Moon and measure what fraction of its disc is lit, by
fitting two overlapping circles to the shape. Runs entirely in the browser.

Live: <https://measure-the-moon.oraculum-aeternum.duckdns.org>

## The geometry

The lit part of the Moon is bounded by the **limb**, an arc of the Moon's own
circular outline, and the **terminator**, the day/night line. The cusps sit at
opposite ends of a diameter at every phase, so the lit limb is always exactly a
half-circle.

The shape is **not** the intersection of two overlapping circles. An
intersection of convex sets is convex, and a crescent is not. The same two
circles have to be combined two different ways:

| phase | lit region |
| --- | --- |
| gibbous | disc ∩ second circle |
| quarter | second circle's radius → ∞, its arc becomes a straight line |
| crescent | disc − second circle |

`test/geometry.test.mjs` proves the non-convexity directly: two points near
opposite cusps are lit, their midpoint is not.

## The circular arc is an approximation

The real terminator is a circle in 3D seen at an angle, so it projects to half
an ellipse with semi-axes `R` and `R·cos i`, giving `k = (1 + cos i) / 2`.
Substituting a circular arc through the same three points changes the enclosed
area, always towards 50%:

| true `k` | 5% | 20% | 35% | 50% | 65% | 80% | 95% |
| --- | --- | --- | --- | --- | --- | --- | --- |
| two-circle | 6.2% | 22.8% | 37.0% | 50.0% | 63.0% | 77.2% | 93.8% |
| bias | +1.2 | +2.8 | +2.0 | 0.0 | −2.0 | −2.8 | −1.2 |

Peak bias is **2.80 points** at `cos i = ±0.564`; it vanishes at quarter, full
and new. The app fits both models: the headline number comes from the exact
ellipse, the drawn circles from the circular fit, and the gap between the green
line and the blue region on screen is the bias at true scale.

## Why there is no single error rate

The error sources behave differently with phase and with how the photo was
taken, so they are reported separately and added in quadrature:

- **Edge softness** — haze, defocus and shake smear the limb over several
  pixels. Otsu lands near the middle of that band, so the displacement is
  priced at an eighth of the transition width — calibrated so the band behaves
  like an actual one-sigma, not a worst-case bound. Usually dominant.
- **Shape mismatch** — how well an idealised Moon matches the blob (IoU).
- **Radius uncertainty** — `k` is an area over `πR²`, so an error in `R` enters
  doubled.
- **Unresolved sliver** — fires when the thin sliver (lit near new, dark near
  full) is no wider than the blur smearing it; capped at the distance to
  empty/full. Near full this is what stops a soft photo from being reported
  as certain.
- **Model bias** — the table above. Reported but not summed in, since the
  headline number is the ellipse fit and does not carry it.

The band is calibrated as a true one-sigma: against synthetic Moons of known
phase the truth lands inside it in **114 of 123** cases (93%), median error
0.17σ, nothing beyond 2σ. One real-world point too: a photo taken 5½ hours
before the August 2026 full moon (true illumination 99.94%) measured 98.45% —
0.6σ against the quoted band. Nine further images were **declined**
rather than measured: a crescent thinner than the blur hiding it still leaves a
blob for Otsu to find, and fitting it produced a confident 99% from an image
with no Moon in it, so the analyser now refuses when the bright region is not
clearly brighter than its surroundings.

## How the fit works

1. Otsu threshold, largest 8-connected blob, interior holes filled (maria and
   craters dip below the threshold).
2. Reject if the blob is not clearly brighter than the background.
3. Initial guess with no iteration: the widest caliper width of the lit region
   is the diameter at every phase, which gives `R` and the cusp axis; the phase
   comes from the area; the centre is placed so the model's centroid lands on
   the measured one.
4. Nelder-Mead on `(cx, cy, R, θ, cos i)` maximising IoU, run twice — once for
   the exact ellipse terminator, once for the circular arc.
5. Error budget from the measured limb transition width, the residual symmetric
   difference, and the limb fit residual.

Step 3's centroid placement is load-bearing. Thresholding clips the tapering
tips off a crescent, which drags a naive centre guess sideways until the model
and the blob do not overlap at all — and IoU is then flat at zero in every
direction, so the simplex never moves.

## What it cannot tell you

- **Waxing or waning.** That needs your hemisphere and the camera's orientation.
  The app says "crescent", never "waxing crescent".
- **An overexposed Moon.** Phone cameras meter for the dark sky and blow the
  disc out to a white blob that reads as nearly full. The app measures the
  clipped fraction and warns.
- **Photometric truth.** This is the *geometric* lit fraction. Lunar mountains
  scallop the real terminator and the limb is darker than the centre.

## Layout

```
index.html         page and the long-form explanation
styles.css
js/geometry.js     the maths: both terminator models, areas, the second circle
js/vision.js       pixels to mask: Otsu, blobs, hull, callipers, edge width
js/fit.js          Nelder-Mead, IoU objective, the error budget
js/analyze.js      end to end, pixels in, measurement out
js/overlay.js      drawing the circles and the region
js/demo.js         renders a Moon of known phase (also used by the tests)
js/app.js          UI wiring
test/run.sh        ./test/run.sh [--unit]
deploy.sh          copies into public/, which Caddy serves
```

No backend, no database, no analytics. Nothing leaves the browser.
