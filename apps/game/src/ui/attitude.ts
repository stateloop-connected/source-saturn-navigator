/**
 * The attitude dial: point the engine anywhere, by dragging.
 *
 * ## Why a dial and not two number fields
 *
 * Thrust direction is a point on a sphere, and the six cardinal modes reach
 * only six points of it. Everything interesting between them — a plane change
 * part-way through a burn, a trim during a rendezvous, a retrograde burn canted
 * to lower periapsis on the same pass — needs the rest, and needs it chosen by
 * eye against the orbit rather than typed.
 *
 * So the whole sphere is drawn flat: **prograde at the centre, retrograde at
 * the rim.** The projection is azimuthal equidistant, meaning the distance from
 * the centre is exactly the angle away from prograde, linearly. That is the
 * property worth having — halfway out really is 90 degrees off, so a burn
 * placed by eye is placed correctly — and it is why this is not a globe with a
 * hidden far side, which would put half the available directions behind the
 * near one.
 *
 * The cost is that retrograde smears around the entire rim instead of being a
 * point. Since retrograde is one of the six buttons anyway, that costs nothing
 * a pilot needs.
 *
 * ## Frame
 *
 * The plane of the dial is the orbital plane: right is radial-out, up is
 * normal. A vector drawn to the upper-left therefore means "prograde, tilted
 * out of the plane and inward", which is what the ship will do.
 */

import { anglesFromDirection } from '@saturn/core/module';
import { RAD, TAU } from '@saturn/core/vec';
import { THEME } from '../render/theme.js';

export interface AttitudeCallbacks {
  /** Called continuously while dragging, with radians. */
  onAim: (yaw: number, pitch: number) => void;
  /** Called when the dial is clicked with no drag, to hand control back. */
  onRelease?: () => void;
}

/**
 * Screen offset (in dial radii) for a given yaw and pitch.
 *
 * The angle from prograde is the polar distance; the direction round the dial
 * is the yaw. Both fall straight out of the two angles, which is the point of
 * choosing this projection.
 */
export function toDial(yaw: number, pitch: number): { x: number; y: number } {
  // Angle away from prograde, 0 at the centre and pi at the rim.
  const fromPrograde = Math.acos(
    Math.max(-1, Math.min(1, Math.cos(pitch) * Math.cos(yaw))),
  );
  const radius = fromPrograde / Math.PI;

  // Direction round the dial: the component of the aim perpendicular to
  // prograde, resolved into radial (x) and normal (y).
  const alongRadial = Math.cos(pitch) * Math.sin(yaw);
  const alongNormal = Math.sin(pitch);
  const spread = Math.hypot(alongRadial, alongNormal);
  if (spread < 1e-9) {
    /*
     * The two points where the direction *round* the dial is undefined.
     *
     * Prograde is the centre and needs no direction. Retrograde is the entire
     * rim — that is the cost of this projection, noted above — so any point on
     * it is as correct as any other, and the radial axis is chosen for being
     * stable. Collapsing both to the centre, which is what a single guard does,
     * would silently turn an exact retrograde aim into a prograde one.
     */
    return radius < 0.5 ? { x: 0, y: 0 } : { x: radius, y: 0 };
  }

  return {
    x: (alongRadial / spread) * radius,
    y: (alongNormal / spread) * radius,
  };
}

/** The inverse: yaw and pitch from a position on the dial. */
export function fromDial(x: number, y: number): { yaw: number; pitch: number } {
  const radius = Math.min(1, Math.hypot(x, y));
  const fromPrograde = radius * Math.PI;

  if (radius < 1e-9) return { yaw: 0, pitch: 0 };

  const direction = { x: x / radius, y: y / radius };
  // Rebuild the unit vector in (prograde, radial, normal) and read the angles
  // back off it, so this is exactly the inverse of `toDial`.
  const alongPrograde = Math.cos(fromPrograde);
  const perpendicular = Math.sin(fromPrograde);

  return anglesFromDirection(
    {
      prograde: { x: 1, y: 0, z: 0 },
      radial: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
    {
      x: alongPrograde,
      y: perpendicular * direction.x,
      z: perpendicular * direction.y,
    },
  );
}

export class AttitudeDial {
  readonly element: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;
  private dragging = false;

  yaw = 0;
  pitch = 0;
  /** Drawn differently while the engine is actually firing. */
  active = false;
  /** True when the ship is under one of the cardinal modes, not free aim. */
  cardinal = true;
  throttle = 0;

  constructor(size: number, private readonly callbacks: AttitudeCallbacks) {
    this.size = size;
    this.element = document.createElement('canvas');
    this.element.className = 'attitude';

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.element.width = size * ratio;
    this.element.height = size * ratio;
    this.element.style.width = `${size}px`;
    this.element.style.height = `${size}px`;

    this.ctx = this.element.getContext('2d')!;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    this.bind();
  }

  private bind(): void {
    const aimAt = (event: PointerEvent): void => {
      const bounds = this.element.getBoundingClientRect();
      const half = this.size / 2;
      const margin = 14;
      const usable = half - margin;

      const x = (event.clientX - bounds.left - half) / usable;
      // Canvas y runs downward; the dial's normal axis runs up.
      const y = -(event.clientY - bounds.top - half) / usable;

      const { yaw, pitch } = fromDial(x, y);
      this.yaw = yaw;
      this.pitch = pitch;
      this.callbacks.onAim(yaw, pitch);
      this.draw();
    };

    this.element.addEventListener('pointerdown', (event) => {
      this.element.setPointerCapture(event.pointerId);
      this.dragging = true;
      aimAt(event);
    });
    this.element.addEventListener('pointermove', (event) => {
      if (this.dragging) aimAt(event);
    });
    this.element.addEventListener('pointerup', (event) => {
      this.element.releasePointerCapture(event.pointerId);
      this.dragging = false;
    });
  }

  set(yaw: number, pitch: number): void {
    if (this.dragging) return;
    this.yaw = yaw;
    this.pitch = pitch;
  }

  draw(): void {
    const ctx = this.ctx;
    const half = this.size / 2;
    const margin = 14;
    const usable = half - margin;

    ctx.clearRect(0, 0, this.size, this.size);

    // Face.
    ctx.beginPath();
    ctx.arc(half, half, usable, 0, TAU);
    ctx.fillStyle = 'rgba(8, 14, 24, 0.85)';
    ctx.fill();
    ctx.strokeStyle = THEME.hud.border;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Rings at 45, 90 and 135 degrees from prograde. Evenly spaced, because
    // the projection is equidistant — that is the whole point of it.
    ctx.strokeStyle = 'rgba(120, 155, 195, 0.20)';
    ctx.lineWidth = 1;
    for (const fraction of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.arc(half, half, usable * fraction, 0, TAU);
      ctx.stroke();
    }

    // Cross-hairs along the radial and normal axes.
    ctx.beginPath();
    ctx.moveTo(half - usable, half);
    ctx.lineTo(half + usable, half);
    ctx.moveTo(half, half - usable);
    ctx.lineTo(half, half + usable);
    ctx.stroke();

    ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(150, 175, 205, 0.65)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', half, margin * 0.55);
    ctx.fillText('N−', half, this.size - margin * 0.55);
    ctx.fillText('R', this.size - margin * 0.5, half);
    ctx.fillText('R−', margin * 0.5, half);

    // Prograde marker at the centre.
    ctx.beginPath();
    ctx.arc(half, half, 3.5, 0, TAU);
    ctx.strokeStyle = THEME.module.body;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // The aim itself.
    const aim = toDial(this.yaw, this.pitch);
    const px = half + aim.x * usable;
    const py = half - aim.y * usable;

    const colour = this.active
      ? THEME.node.burning
      : this.cardinal
        ? 'rgba(150, 175, 205, 0.55)'
        : THEME.node.marker;

    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(half, half);
    ctx.lineTo(px, py);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(px, py, 5, 0, TAU);
    ctx.stroke();
    // Filled proportionally to throttle: the dial says both where and how hard.
    if (this.throttle > 0) {
      ctx.beginPath();
      ctx.arc(px, py, 5 * Math.min(1, this.throttle), 0, TAU);
      ctx.fill();
    }
  }

  /** The current aim as degrees, for the readout beside the dial. */
  degrees(): { yaw: number; pitch: number } {
    return { yaw: this.yaw * RAD, pitch: this.pitch * RAD };
  }
}
