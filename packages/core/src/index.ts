/**
 * @saturn/core — a Newtonian model of the Saturn system.
 *
 * The barrel is a convenience, not the interface. Every module is also its own
 * entry point (`@saturn/core/forces`, `@saturn/core/moons`), so a consumer that
 * wants the integrator without the catalogue, or the catalogue without the
 * integrator, can take exactly that.
 */

export * from './vec.js';
export * from './units.js';
export * from './time.js';
export * from './saturn.js';
export * from './sun.js';
export * from './moons.js';
export * from './elements.js';
export * from './forces.js';
export * from './system.js';
export * from './module.js';
export * from './manoeuvre.js';
export * from './transfer.js';
export * from './predict.js';
export * from './mission.js';
export * from './field.js';
export * from './illumination.js';
