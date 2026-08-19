/**
 * Localisation. Czech is the default; English is a toggle.
 *
 * Both dictionaries are bundled rather than fetched, because the game has to
 * work as static files with no network at runtime — and because a navigation
 * display that waits on a request to know what to call the throttle is not a
 * navigation display.
 *
 * Moon names are deliberately *not* in here. Saturn's satellites carry the same
 * international forms in Czech as in English, so translating them would mean
 * inventing declensions for fifty-four proper nouns; the interface is phrased
 * to put them in the nominative throughout, which is the one form that is
 * certainly right.
 */

import cs from './cs.json';
import en from './en.json';

export type Locale = 'cs' | 'en';

export const LOCALES: readonly Locale[] = ['cs', 'en'];

const DICTIONARIES: Record<Locale, Record<string, string>> = { cs, en };

const STORAGE_KEY = 'saturn.locale';

/**
 * Read a stored preference.
 *
 * localStorage may be disabled, full, or blocked by the browser's privacy
 * settings. Every access is guarded: losing a language preference is not worth
 * an exception that takes the whole game down with it.
 */
function readStoredLocale(): Locale | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'cs' || stored === 'en' ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // The preference simply will not persist; nothing else depends on it.
  }
}

let current: Locale = readStoredLocale() ?? 'cs';

export const getLocale = (): Locale => current;

export function setLocale(locale: Locale): void {
  current = locale;
  writeStoredLocale(locale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

/**
 * Look up a key, substituting `{{name}}` placeholders.
 *
 * A missing key returns the key itself rather than throwing or quietly falling
 * back — an untranslated string is then obvious on screen instead of reading as
 * English in a Czech interface.
 */
export function t(key: string, values?: Record<string, string | number>): string {
  const template = DICTIONARIES[current][key] ?? DICTIONARIES.en[key] ?? key;
  if (!values) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

export const hasTranslation = (key: string): boolean =>
  key in DICTIONARIES[current] || key in DICTIONARIES.en;

/*
 * Formatters are built once and kept, keyed by locale and shape.
 *
 * Constructing an `Intl.NumberFormat` costs a hundred times what using one
 * does. That is nothing once and a great deal sixty times a second, which is
 * what a navigation readout with a dozen numbers on it would otherwise be
 * doing every frame.
 */
const numberFormats = new Map<string, Intl.NumberFormat>();

const intlLocale = (): string => (current === 'cs' ? 'cs-CZ' : 'en-GB');

export function formatNumber(value: number, fractionDigits = 2): string {
  const key = `${intlLocale()}|${fractionDigits}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(intlLocale(), {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    numberFormats.set(key, format);
  }
  return format.format(value);
}

const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

const superscript = (exponent: number): string =>
  (exponent < 0 ? '⁻' : '') +
  Math.abs(exponent)
    .toString()
    .split('')
    .map((digit) => SUPERSCRIPTS[Number(digit)])
    .join('');

/**
 * A magnitude as a mantissa and a power of ten.
 *
 * The gravitational field in this game spans from 10 m/s2 at Saturn's cloud
 * tops to 10^-9 out among the Norse moons. Fixed-point notation cannot show
 * that range, and thousands separators are beside the point.
 */
export function formatExponent(value: number, digits = 2): string {
  if (value === 0) return '0';
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  const mantissa = value / 10 ** exponent;
  return `${formatNumber(mantissa, digits)}·10${superscript(exponent)}`;
}

/**
 * A distance, in whatever unit keeps it readable.
 *
 * Kilometres up to a million, then millions of kilometres. Below a kilometre it
 * switches to metres, which only happens on final approach — and that is
 * exactly when a player wants metres.
 */
export function formatDistance(km: number): string {
  const magnitude = Math.abs(km);
  if (magnitude >= 1e6) return `${formatNumber(km / 1e6, 3)} ${t('unit.millionKm')}`;
  if (magnitude >= 1) return `${formatNumber(km, magnitude >= 1000 ? 0 : 2)} km`;
  return `${formatNumber(km * 1000, 0)} m`;
}

/** A duration, in the largest unit that keeps it under three digits. */
export function formatDuration(seconds: number): string {
  const magnitude = Math.abs(seconds);
  if (magnitude >= 86_400) return `${formatNumber(seconds / 86_400, 2)} ${t('unit.day')}`;
  if (magnitude >= 3_600) return `${formatNumber(seconds / 3_600, 2)} ${t('unit.hour')}`;
  if (magnitude >= 60) return `${formatNumber(seconds / 60, 1)} ${t('unit.minute')}`;
  return `${formatNumber(seconds, 0)} ${t('unit.second')}`;
}

/** The simulation clock as a calendar date. */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(intlLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}
