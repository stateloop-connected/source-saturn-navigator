# Saturn Navigator — a navigation game in a Newtonian model of the Saturn system

## 1. Purpose

Fly a module through the gravity field of Saturn and its moons. The system is
**integrated, not animated**: Saturn and 53 moons are advanced together by a
symplectic n-body scheme, and the module is a massless test particle in that
field.

The teaching goal sits underneath the game. Orbital mechanics around a giant
oblate planet with a crowded moon system is genuinely unintuitive — Hill spheres
are far smaller than people expect, J2 drags a low orbit's node round by degrees
a day, and "prograde" means something different in every frame — and the way to
make that tangible is to let someone try to fly it and show them the field they
are flying in.

## 2. Decisions locked

| Topic | Decision |
|---|---|
| Stack | **TypeScript + Vite, vanilla DOM**, no UI framework, no runtime dependencies |
| Scene rendering | **Canvas 2D.** Not CSS (the sibling Orrery's choice) — this scene has thousands of path segments per frame |
| Interface rendering | **DOM**, as a cockpit framing the viewport on four sides |
| Units | **km and seconds**, GM in km³/s². Never AU, never days |
| Frame | **Barycentric**, Saturn as body 0; Saturn's equator is the xy-plane |
| Integrator | **Yoshida 4th-order symplectic**, 60 s step, fixed |
| Saturn's figure | **Oblate, J2/J4/J6 in the force law**, never a point mass |
| Moon phases | **Synthetic and documented as such**, except trojans and Janus/Epimetheus |
| Prediction | **Fork the simulation and fly it.** No patched conics, no Keplerian shortcut |
| Manoeuvres | **Impulsive to plan, finite to fly.** One node at a time |
| Attitude | **Azimuthal equidistant dial**, prograde centred — not a globe |
| Propellant | **Unlimited for now**, via a flag; the rocket equation stays implemented |
| Camera | **Orthographic**, tilt over the full 0–180° so both ring faces are reachable |
| Default locale | **Czech**, English via toggle |
| Deployment | **Static files**, relative base, no backend, works offline |

## 3. Layout

```
packages/core   @saturn/core — the model. No DOM (enforced by tsconfig lib).
apps/game       @saturn/game — renderer, interface, prediction worker.
scripts/        Maintenance tools, run by hand. Not part of the build.
docs/           accuracy.md, which is the honest accounting.
```

`@saturn/core` is consumed **through its built output**, the same way a separate
repository would consume it, so every root script builds it first. Editing core
and running only the app's dev server will use a stale `dist`.

### Core modules

| Module | Holds |
|---|---|
| `vec` | Vec3, rotations, `basisFrom` |
| `units` | km/s conventions, GM↔mass, Hill radius, escape speed |
| `time` | Seconds from J2000; the only place a `Date` is touched |
| `saturn` | Physical figures, zonal harmonics, the working frame, ring bands |
| `sun` | Saturn's heliocentric orbit → the Sun's direction and the ring seasons |
| `moons` | The catalogue |
| `elements` | Elements ↔ state vectors, osculating orbits, orbit sampling |
| `forces` | **The force law, and the only place it is written down** |
| `system` | `SaturnSystem`: state, seeding, stepping, forking |
| `module` | The spacecraft: thrust modes, the rocket equation |
| `manoeuvre` | Nodes and solvers, plus the autopilot that flies them |
| `predict` | Fork-and-fly prediction, ghosts, approaches, impacts |
| `mission` | The mother ship, the objectives, and where the module starts |
| `transfer` | Hohmann figures and, more to the point, departure windows |
| `field` | Field sampling in absolute / tidal / co-rotating modes |
| `illumination` | Phases, Saturn's oblate shadow, ring lighting |

## 4. Rules that are load-bearing

**One force law.** Everything that needs gravity goes through `forces.ts` — the
integrator, the module, the predictor, and the overlay that draws arrows on
empty space. That is what makes the promise of the field overlay true: the
arrows shown are made of the arithmetic that will actually move the ship. Do not
add a second implementation for any reason, including speed.

**The prediction must remain the simulation.** `predict()` forks the real system
and runs the real integrator. If it is ever tempted toward an analytic shortcut,
the feature loses its entire point — a player will plan a capture burn on it.
`predict.test.ts` holds this to 10⁻⁶ km and must keep passing.

**The step size is not a performance lever.** At high warp the loop caps *steps
per frame* and lets the clock fall behind, reporting the warp actually achieved.
It never enlarges the step to catch up: the step is what keeps Pan's orbit
resolved, and trading it would let the inner moons come apart silently.

**Say what is not known.** The catalogue's synthetic phases are stated in the
module header, in the README, in `docs/accuracy.md` and in the interface. If
real elements are ever imported, all four say so.

**The autopilot must stay a pure function of time.** `autopilotThrust` takes no
accumulated "Δv delivered so far" counter, and must not gain one. A counter
would live in the live module and be absent from the predictor's fork, so a
predicted burn would diverge from the flown one — exactly when the player is
relying on it. The burn window is derived from the node's time and duration,
both known in advance, and the step length is an argument so the last partial
step can be duty-cycled rather than over-run.

**Plan manoeuvres in the influence frame, not the selection.** They differ
constantly, and relative to a body the module is not bound to every solver
correctly returns nothing — which reads as a dead button.

**The cockpit never covers the middle.** Panels frame the viewport and the
canvas draws its reader-facing marks against `camera.safeArea`, which is
measured from the real elements rather than hard-coded — the deck grows when the
burn indicator appears, and a fixed inset is wrong within one burn.

**The dial and the engine share one angle convention.** `fromDial` feeds
`setAim` directly, so a drift between the two would leave free aim working and
simply pointing somewhere other than the dial showed. `attitude.test.ts` checks
the dial against `thrustDirection` at all four cardinal points.

**The drawn-radius floor is the only visual lie.** Moons are drawn no smaller
than 1.6 px. Nothing the physics reads may ever use that number.

## 5. Testing

121 tests: 111 in core, 10 on the interface. The suite is not decorative — several caught real errors
during the build, and the shape of each is worth keeping.

- **`saturn.test.ts` is load-bearing.** It differentiates the potential
  numerically and compares against the hand-derived harmonic terms. A dropped
  sign in J2, J4 or J6 produces a field that still looks like gravity and is
  quietly wrong; this is the only cheap way to know.
- **Averaging over whole periods, not fixed intervals.** The osculating
  semi-major axis of an inner moon oscillates by 2·10⁻⁴ per orbit because of
  Saturn's bulge. Sampling on any other interval aliases and reads real physics
  as integrator drift. This mistake was made once already.
- **Trojans and Janus/Epimetheus have their own tests**, because they are the
  two places where a wrong initial phase produces a visibly broken system.
- Use a moon subset (`new SaturnSystem(0, 60, subset(...))`) for anything
  running longer than a few days, or the suite crawls.

## 6. Conventions

Comments explain **why**, not what — particularly where a choice looks odd
(barycentric frame, massless module, tilt range past 90°, synthetic phases).
Where a number was measured or derived, say where it came from.

Panels are built once and updated in place, never rebuilt: rebuilding closes
open panels, drops focus and interrupts a slider mid-drag.

Moon names are one string, not a per-locale pair — Saturn's satellites carry the
same international forms in Czech. The interface is phrased to keep them in the
nominative so no declensions have to be invented. Everything *around* them is
translated.

## 7. Known gaps

- No attitude dynamics; thrust takes effect instantly.
- One manoeuvre node at a time; no queue, and therefore no multi-burn plan.
- Transfers assume circular coplanar orbits; they are a plan, and the
  predictor is the authority. Titan's e is 0.029 and Iapetus is inclined 15°.
- Propellant is unlimited pending configurable module properties.
- Resonances other than the anchored two are not set up (see §4, phases).
- The 2019-and-later Norse discoveries are not in the catalogue.
- `scripts/fetch-elements.mjs` is written but has not been run against the live
  Horizons API; its parsing is against the documented format.
- The starfield is scenery, not a sky.
