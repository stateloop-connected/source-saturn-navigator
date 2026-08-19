# Saturn Navigator

Fly a module through the gravity field of Saturn and its moons, in a Newtonian
model of the system that is actually integrated rather than animated.

Saturn and 53 of its moons are advanced together by a fourth-order symplectic
integrator, with Saturn's oblateness in the force law from the start. The
module is a massless test particle in that field. Its predicted future is
produced by **forking the simulation and flying it** — the same force law, the
same integrator — so the dashed curve on screen is not an estimate of what will
happen, it is what will happen.

Browser-based, no backend, works offline once loaded. Czech interface by
default, English on a toggle.

---

## Running it

```bash
npm install
```

```bash
npm run dev
```

Then open the address Vite prints. To produce a static build:

```bash
npm run build
```

The output in `apps/game/dist` is plain files with a relative base path — it
will run from a subdirectory, or by opening `index.html` off the filesystem.

```bash
npm test
```

---

## What it does

**Navigation.** Throttle, prograde/retrograde/radial/normal thrust, a finite
propellant budget and the rocket equation behind it. The navigation readout
gives altitude, speed, and the osculating orbit about whichever body you have
selected — which is the point, because "prograde" near Titan means something
quite different depending on whether the frame is Titan's or Saturn's.

**Trajectory prediction.** Look ahead from an hour to three months. The result
is drawn as a path with *ghosts*: the moons sketched where they will be when
the module arrives, each labelled with how far ahead it is. A curve through
empty space says nothing about whether an encounter happens; the same curve
with Titan drawn at the moment of closest approach says everything. Runs in a
worker, so the frame rate is untouched.

**The gravity field, made visible.** A sampled grid of arrows over any patch of
space, in three modes:

- *Absolute* — the acceleration a free particle feels. Honest, and nearly
  useless close up, because Saturn dominates everywhere.
- *Tidal* — the reference body's own acceleration subtracted, leaving the part
  that actually acts on an orbit around it. This is the view in which a Hill
  sphere stops being a number and becomes a region.
- *Co-rotating* — with the centrifugal term of a frame turning with the target.
  Its stationary points are the Lagrange points, which is why Telesto and
  Calypso stop looking like a coincidence here.

**Lighting.** The Sun's direction is computed from Saturn's own orbit, so the
rings open and close over the 29-year cycle and the sub-solar latitude swings
through 53 degrees. Moons carry real phases and go dark in Saturn's shadow,
which is modelled as the elliptical cylinder it is rather than a circle —
Saturn is visibly oblate, and at an equinox its shadow is 5 900 km narrower
across the poles. Saturn's shadow falls across the rings as an exact conic
section, and the rings throw their own banded shadow back onto the globe.
Iapetus is drawn with both of its albedos.

**Selection and scale.** Every moon is clickable and listed by group. Zoom runs
from a 5 km view to 30 million km — seven decades, logarithmically, with a
scale bar that snaps to round numbers.

### Controls

| | |
|---|---|
| Drag | Pan |
| Wheel | Zoom about the cursor |
| Right-drag | Rotate and tilt |
| Click a moon | Select it |
| Shift / Ctrl | Throttle up and down |
| `z` / `x` | Full throttle / cut |
| `,` and `.` | Time warp |
| Space | Pause |
| `f` | Follow the module |
| `p` | Recompute the prediction |

---

## What is accurate, and what is not

Stated plainly, because a model that will not say is not worth much. The long
version is in [`docs/accuracy.md`](docs/accuracy.md).

**Accurate.** Masses, as GM, which is what tracking actually measures. Radii and
albedos. Orbit *shapes* — semi-major axis, eccentricity, inclination — and
therefore periods, speeds, Hill spheres, and the answer to every question the
game asks about flying somewhere. Saturn's gravity field to J6.

**Not accurate.** Where each moon sits *along* its orbit on a given date. Those
phases are synthetic, derived deterministically from the moon's name. The
configuration on any particular date is wrong, and the game does not claim
otherwise: this is a simulator of the system's dynamics, not an ephemeris of it.

Two exceptions, because there phase is a dynamical fact rather than a free
parameter: the trojans sit at their Lagrange points, and Epimetheus is anchored
half a turn from Janus so the two can perform their four-year orbit exchange
without colliding. Both are visible in play.

`scripts/fetch-elements.mjs` replaces the synthetic phases with real ones from
JPL Horizons for anyone who wants an ephemeris instead.

### Every moon over 100 metres

That was the brief, and taken literally it is not a set anyone can tabulate: the
A ring holds millions of unresolved *propeller* moonlets of 100 m to a
kilometre, known only from the wakes they cut. What exists is the catalogue of
confirmed satellites, and **every confirmed moon of Saturn is larger than
100 m** — the smallest, Aegaeon, is 660 m across. So the threshold is met by
taking the catalogue whole rather than by filtering, and the sub-100 m
population enters the model the only way it can: as ring mass and ring optical
depth.

The 53 moons modelled are the 23 regular and inner moons and the 30 named
irregulars. Saturn's confirmed count now exceeds 270, the remainder being
2019-and-later discoveries in the Norse group — a few kilometres across, twenty
million kilometres out, and dynamically irrelevant to anything the module does.
They are left out rather than invented; the fetch script brings them in.

---

## Layout

```
packages/core   @saturn/core — the model. No DOM, no framework, no dependencies.
apps/game       @saturn/game — canvas renderer, interface, worker.
```

`@saturn/core` is consumed through its built output, the same way a separate
repository would consume it, so every script here builds it first.

The core carries 68 tests. The load-bearing one differentiates Saturn's
gravitational potential numerically and compares it against the hand-derived
harmonic terms in the force law — a dropped sign in any of J2, J4 or J6 would
otherwise produce a field that still looks like gravity, still holds moons in
orbits, and is quietly wrong.

---

## Notes on the physics

**Why symplectic.** At a warp of 200 000 a session covers years of simulated
time. Any integrator that leaks energy shows it — moons spiral and the system
the player learned stops being the one they are flying in. A symplectic
composition does not conserve energy exactly either, but its error oscillates
instead of accumulating.

**Why barycentric.** Saturn is body 0 rather than a fixed origin. A
Saturn-centred frame is more convenient for drawing and gets that with one
subtraction, but it is not inertial, and paying for that with indirect terms
would cost the integrator its symplectic structure.

**Why J2 is not optional.** Saturn's J2 is 1.63·10⁻², fifteen times the Earth's.
It is what holds the inner moons in the ring plane, and it drags a low orbit's
node round by whole degrees a day. Model Saturn as a point mass and the game is
wrong in a way the player can see within one orbit.

**Why the module is massless.** A tonne against Mimas's 3.7·10¹⁹ kg is 26 orders
of magnitude down. Leaving it out of the mutual-gravity arrays means the moons'
motion is completely independent of what the player does — which is what makes
the predictor possible: fork the state once, then fly as many candidate courses
through it as you like.

---

## Related

A sibling of [ptolemy_copernicus_newton](https://github.com/richardLipka/ptolemy_copernicus_newton),
an interactive orrery comparing the Ptolemaic, Copernican, Keplerian and
Newtonian models of the solar system. The integrator here follows the same
Yoshida composition; the two projects deliberately agree about where Saturn is.

MIT licensed.
