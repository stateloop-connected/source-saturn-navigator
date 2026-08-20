# Accuracy

What this model gets right, what it gets wrong, and why in each case. The short
version is in the README; this is the accounting behind it.

---

## 1. Saturn

| Quantity | Value | Source |
|---|---|---|
| GM | 37 931 206.2 km³/s² | JPL sat441 |
| Equatorial radius (1 bar) | 60 268 km | |
| Polar radius (1 bar) | 54 364 km | |
| Gravity reference radius | 60 330 km | JPL |
| J2 | 1.629 056·10⁻² | Cassini Grand Finale |
| J4 | −9.358 3·10⁻⁴ | |
| J6 | 8.614·10⁻⁵ | |
| Rotation period | 10h 33m 38s | ring seismology |
| Pole (J2000) | RA 40.589°, Dec 83.537° | IAU 2015 |

Two details here are easy to get wrong and are deliberately kept apart.

**The gravity reference radius is not the 1-bar radius.** A spherical-harmonic
expansion is only defined together with the radius it was normalised against.
JPL's Saturn field uses 60 330 km; using the 1-bar figure of 60 268 instead
would misscale J2 by a part in a thousand. Small, and exactly the kind of error
that never announces itself.

**The obliquity is 28.05°, not 26.73°.** The familiar figure is Saturn's tilt
against *its own orbit*, which is itself inclined 2.49° to the ecliptic. The
working frame here is referred to the ecliptic, so the larger figure is the one
that applies. It is derived from the IAU pole rather than tabulated, so
changing the pole changes the frame everywhere.

The expansion stops at J6. J8 is around 10⁻⁵ and contributes less than the
error in the moon elements at every altitude the module can reach.

---

## 2. The moons

### What is measured

GM is tabulated for 17 moons, from Cassini flybys or from their effect on the
rings. Those are the ones that matter dynamically; together they are more than
99.99% of the moon mass in the system. Radii and albedos are observational
throughout.

For the remaining 36 — kilometre-scale irregulars and small inner moons — GM is
estimated from the radius at an assumed density of 500 kg/m³. That is right to
within a factor of two, and wrong by far less than the number matters: every
estimated moon pulls less than a millionth of what Mimas does. The catalogue
flags which is which (`gmMeasured`), and the interface shows it.

### What is right about the orbits

Semi-major axis, eccentricity and inclination, and therefore:

- periods, to the precision of the published values — checked in the tests
  against Pan, Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Hyperion, Iapetus,
  Kiviuq, Phoebe and Siarnaq;
- orbital speeds, escape speeds and Hill radii;
- which orbits cross which, and what a transfer between any two costs.

Inclinations for the regular moons are referred to Saturn's equator, because
that is the plane Saturn's oblateness forces them into. The irregulars are
referred to the ecliptic, because they are far enough out that the bulge has
stopped mattering and the Sun has taken over. The frame travels with the
numbers in the catalogue; conflating the two would put Phoebe's orbit 28° out
of place.

### What is wrong about the orbits

**Mean longitude at epoch.** Where each moon sits along its orbit is synthetic —
an FNV-1a hash of the moon's name, spread over a full turn. Node and periapsis
likewise.

This is a deliberate choice over the alternative of inventing precise-looking
numbers. The consequence is stated rather than hidden: **the configuration of
the system on any given date is wrong.** Anyone wanting the real one should run
`scripts/fetch-elements.mjs`, which pulls state vectors from JPL Horizons.

For near-circular, near-equatorial orbits the node and periapsis are nearly
undefined anyway, and Saturn's oblateness spins both round within months —
Mimas's node completes a full turn in under a year — so their epoch values
carry little meaning even when they are real.

**The resonances are not set up.** Mimas–Tethys, Enceladus–Dione and
Titan–Hyperion are all genuine librating resonances, and none of them will be
found librating here, because a resonance is a relationship between phases and
the phases are synthetic. The orbits are right; the lock is not. Feeding real
elements in fixes it.

### The two exceptions

Phase is not always a free parameter. Two cases are dynamical facts, and getting
them wrong would be visible within a week of simulated time:

**Trojans.** Telesto and Calypso sit 60° ahead of and behind Tethys, Helene and
Polydeuces the same about Dione. Placed anywhere else they simply fall out of
the Lagrange point. They also take their parent's semi-major axis exactly — two
co-orbitals must share a period, and 40 km of difference in *a* is enough to
unstick them within a few years. A test holds all four inside their tadpole
range over sixty days.

**Janus and Epimetheus.** Their semi-major axes differ by 50 km, less than the
sum of their radii, and they exchange orbits every four years without ever
approaching within 15 000 km. That only works from a wide starting separation,
so Epimetheus is anchored half a turn from Janus. A test runs them for 120 days
and checks they never close inside 15 000 km.

### The 2019-and-later discoveries

Saturn's confirmed satellite count now exceeds 270. The 53 modelled here are
those with orbits well enough determined to state: the 23 regular and inner
moons, and the 30 named irregulars.

The remainder are recent Norse-group discoveries — a few kilometres across, 20
to 25 million km out, on orbits that take three to four years. They are omitted
because their elements are not something a source file should be inventing, and
because their effect on anything the module does is nil. The fetch script brings
them in for anyone who wants completeness.

---

## 3. The integration

**Scheme.** Yoshida's fourth-order symplectic composition: three velocity-Verlet
sub-steps whose lengths cancel the leading error term, the middle one running
backwards. Three force evaluations per step for O(dt⁴) accuracy and bounded
rather than accumulating energy error.

**Step.** 60 s by default. Set by Pan, the innermost moon, whose period is
49 680 s — 828 steps per orbit, far more than a fourth-order scheme needs.

**Frame.** Barycentric, Saturn as body 0. Keeps the Hamiltonian separable so the
composition is genuinely symplectic. Saturn's oblateness enters as an
interaction between Saturn and each other body, with the reaction applied back
to Saturn, so momentum is conserved exactly.

**Measured behaviour.** Energy is conserved to better than 1 part in 10¹⁰ over
three days of the full 54-body system. Mimas's orbit-averaged semi-major axis
holds to 1.8·10⁻⁷ over 120 days. The instantaneous osculating value oscillates
by 2.1·10⁻⁴ over each orbit, which is *not* integration error — it is Saturn's
bulge breathing the ellipse twice per orbit, and a test that failed to average
over whole periods would read it as drift.

**Circular orbits are not `sqrt(GM/r)`.** J2 adds 2.4% to Saturn's equatorial
field at the cloud tops, so the true circular speed there is 1.3% higher than
the point-mass value. Seeding an orbit at the point-mass speed produces an
ellipse whose periapsis is 3 100 km lower — underground. `circularSpeedInField`
derives the speed from the actual acceleration instead, and everything placing a
spacecraft near Saturn uses it.

**Burns are duty-cycled across a step.** Thrust is held constant over an
integration step, so testing "is the clock inside the burn window?" at the start
of each step over-runs the end by up to a full step. At a 60 s step a 1 330 s
burn ran for 1 380 s — 3.8% extra Δv, which at periapsis put apoapsis 68% past
its target. The autopilot therefore scales its thrust by the fraction of the
coming step that falls inside the window, which makes the delivered Δv exact at
any step size, and lets the predictor use a coarser step than the live
simulation without the two disagreeing.

**What is neglected.** The Sun's tidal pull across the moon system, about 10⁻⁷
of Saturn's own — smaller than the error in the moon elements by orders of
magnitude. Saturn's pole is held fixed, neglecting the torque the moons exert
on the bulge, which acts on a spin angular momentum thousands of times larger
over timescales of millions of years. Ring mass is tabulated (1.54·10¹⁹ kg,
from the Grand Finale) but is 3·10⁻¹¹ of Saturn's pull and changes no
trajectory anyone will fly. General relativity, entirely.

**Time range.** The model is offered over 1980–2120. Not a limit of the
integrator, which will run as far as it is asked, but a limit of honesty: the
elements are a Cassini-era fit.

---

## 4. The module

Massless, and treated as such throughout — a tonne against Mimas's 3.7·10¹⁹ kg
is 26 orders of magnitude down. It feels gravity and exerts none.

The rocket equation is implemented in full — thrust costs mass and the mass loss
feeds back into the acceleration within the same burn — but it is currently
switched off: `infinitePropellant` defaults to true while the module's
properties are not configurable. The flag suppresses consumption, never physics.

Thrust is 15 kN against a 2 100 kg module, giving 7.1 m/s². That figure was set
by one requirement rather than chosen: a burn must be short against the orbit it
is made from. At the 2 kN this was first built with, the 9.5 km/s departure burn
took 2.9 hours out of a 4.25-hour orbit, so the thrust vector swung through most
of a revolution and apoapsis came out at a fifth of the target. 15 kN brings the
same burn to 23 minutes — about a twelfth of an orbit, short enough to behave
roughly as planned and long enough that the losses stay visible.

Those losses are not small and are not hidden. A single departure burn still
falls about 20% short of its impulsive target, which is why the mission is flown
as successive periapsis burns.

What *is* simplified is attitude. There are no reaction wheels and no time spent
slewing; a thrust command takes effect at once. That is a real omission, and the
reason for it is that this game is about where to burn and how much, and
pointing a spacecraft is a different game that would sit on top of this one
rather than inside it.

---

## 5. Prediction

The predicted path is produced by forking the entire simulation and running it
forward with the same force law and the same integrator. It is not an estimate
of what the simulation will do — it is what the simulation will do, to within
the difference in step size.

A test holds this to the letter: it predicts two days ahead, then flies the live
system the same distance, and requires the two final positions to agree to
within 10⁻⁶ km.

The prediction step defaults to 120 s against the live 60 s, which is the only
approximation involved and is exposed as a control. At 300 s the path is still
good to a few kilometres over a week.

---

## 6. Rendering

One deliberate visual lie, isolated as tightly as possible: **moons are drawn no
smaller than 1.6 pixels.** Daphnis is 4 km across on a view 800 000 km wide,
which is a millionth of a pixel, and the alternative is a screen with Titan on
it and nothing else.

The floor applies only to the drawn radius. Nothing the physics reads is
affected — collision uses the real radius, as do the Hill sphere and every
figure in the interface — and the marker changes from a flat dot to a shaded
sphere the moment the true size exceeds the floor, so it is visible when a moon
has stopped being a symbol.

Saturn's shadow is modelled as a cylinder rather than a cone. The Sun subtends
0.055° at Saturn, so the umbra converges only after 1.25·10⁸ km — five times
further out than the most distant moon modelled. Within the system the shadow is
parallel-sided to well under a kilometre.

The starfield is scenery and makes no claim to be a sky.
