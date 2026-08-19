/**
 * Colour, in one place.
 *
 * The scene is drawn to canvas rather than styled with CSS, so a theme cannot
 * be a stylesheet — it has to be values the drawing code reads. Keeping them
 * here means the palette can be reasoned about as a palette instead of being
 * scattered through six hundred lines of path construction.
 *
 * The scheme is built around one constraint: **the display has to stay legible
 * against Saturn**, which is a large, pale, warm object filling much of the
 * screen at useful zooms. So everything functional — the module, its path, its
 * prediction — is cool and saturated, and everything physical is desaturated
 * and warm. Nothing the player *needs* competes with anything the player is
 * merely looking at.
 */

export const THEME = {
  space: '#05070d',
  /** Faint grid and framing lines. */
  rule: 'rgba(150, 175, 205, 0.16)',
  ruleStrong: 'rgba(150, 175, 205, 0.34)',

  saturn: {
    /** Bands from equator outward, blended across the disc. */
    bands: ['#f3e3c0', '#e6cfa1', '#d8bd8c', '#c9ab7c', '#b99a6f'],
    limb: '#8a7350',
    night: '#0b0d14',
    /** Shadow the rings throw across the globe. */
    ringShadow: 'rgba(10, 12, 20, 0.55)',
  },

  /** Per-band ring tints, keyed by the ids in `RING_BANDS`. */
  rings: {
    D: 'rgba(190, 175, 150, 0.10)',
    C: 'rgba(198, 182, 158, 0.34)',
    B: 'rgba(232, 216, 186, 0.86)',
    cassini: 'rgba(150, 138, 120, 0.20)',
    'A-inner': 'rgba(214, 199, 172, 0.62)',
    encke: 'rgba(120, 112, 100, 0.10)',
    'A-outer': 'rgba(210, 195, 168, 0.58)',
    keeler: 'rgba(120, 112, 100, 0.10)',
    'A-edge': 'rgba(205, 190, 164, 0.52)',
    roche: 'rgba(140, 130, 115, 0.08)',
    F: 'rgba(226, 214, 192, 0.42)',
    G: 'rgba(190, 190, 200, 0.05)',
    E: 'rgba(150, 190, 220, 0.035)',
  } as Record<string, string>,

  moon: {
    lit: '#e9eef5',
    dim: '#8e99a8',
    dark: '#1a1f2a',
    selected: '#66e0ff',
    label: 'rgba(214, 228, 244, 0.82)',
    labelDim: 'rgba(180, 196, 214, 0.42)',
  },

  orbit: {
    regular: 'rgba(120, 150, 185, 0.30)',
    irregular: 'rgba(120, 150, 185, 0.14)',
    selected: 'rgba(110, 210, 255, 0.62)',
    hill: 'rgba(110, 210, 255, 0.20)',
  },

  module: {
    body: '#5ef2d0',
    trail: 'rgba(94, 242, 208, 0.42)',
    /** The predicted path, and the ghosts that go with it. */
    prediction: 'rgba(255, 190, 92, 0.92)',
    predictionDim: 'rgba(255, 190, 92, 0.30)',
    ghost: 'rgba(255, 190, 92, 0.55)',
    impact: '#ff5a52',
    thrust: '#ffd166',
  },

  sun: '#ffe9a8',

  /**
   * Ramp for the gravity-field overlay, weak to strong.
   *
   * Perceptually ordered and colour-blind safe — it is read as a magnitude, so
   * a ramp that is merely pretty would be actively misleading. Deep blue to
   * pale yellow, monotonic in lightness throughout.
   */
  fieldRamp: [
    '#2c1a63',
    '#3b4bA0',
    '#3f7fb5',
    '#4fae9f',
    '#8fca6e',
    '#e0dc63',
    '#fdf6b5',
  ],

  hud: {
    panel: 'rgba(10, 14, 22, 0.86)',
    border: 'rgba(120, 155, 195, 0.22)',
    text: '#d6e4f4',
    dim: '#8b9cb0',
    accent: '#66e0ff',
    warn: '#ffbe5c',
    danger: '#ff5a52',
  },
} as const;

/** A colour from the field ramp, `t` in 0..1. */
export function fieldColour(t: number): string {
  const ramp = THEME.fieldRamp;
  const clamped = Math.min(1, Math.max(0, t));
  const position = clamped * (ramp.length - 1);
  return ramp[Math.round(position)] ?? ramp[0]!;
}

/**
 * Blend two hex colours.
 *
 * Used for the moon discs, whose colour runs from lit to unlit continuously
 * with the phase rather than switching at the terminator.
 */
export function mix(from: string, to: string, t: number): string {
  const parse = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(to);
  const clamped = Math.min(1, Math.max(0, t));
  const channel = (a: number, b: number): number => Math.round(a + (b - a) * clamped);
  return `rgb(${channel(r1, r2)}, ${channel(g1, g2)}, ${channel(b1, b2)})`;
}
