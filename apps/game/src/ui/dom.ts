/**
 * Element construction, kept to the few shapes this interface actually uses.
 *
 * Not a framework and not trying to be one. The panels are rebuilt from state
 * a few times a second at most — everything that changes at frame rate is on
 * the canvas — so there is nothing here for a virtual DOM to save, and a
 * hundred lines of helpers is cheaper to read than a dependency.
 */

type Attributes = Record<string, string | number | boolean | undefined>;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const div = (className: string, children: (Node | string)[] = []): HTMLDivElement =>
  element('div', { class: className }, children);

export const text = (className: string, content: string): HTMLSpanElement =>
  element('span', { class: className, text: content });

/**
 * A label-and-value row.
 *
 * The whole navigation readout is these, and they are the reason it stays
 * legible: the values are right-aligned in a tabular figure font, so a column
 * of numbers can be scanned for a changing digit rather than read.
 */
export function readout(label: string, value: string, tone?: 'warn' | 'danger'): HTMLElement {
  return div('readout', [
    text('readout-label', label),
    text(`readout-value${tone ? ` is-${tone}` : ''}`, value),
  ]);
}

export function button(
  label: string,
  onClick: () => void,
  options: { active?: boolean; className?: string; title?: string } = {},
): HTMLButtonElement {
  const node = element('button', {
    class: `${options.className ?? 'button'}${options.active ? ' is-active' : ''}`,
    type: 'button',
    title: options.title,
  });
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

export function toggle(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
): HTMLLabelElement {
  const input = element('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return element('label', { class: 'toggle' }, [input, text('toggle-label', label)]);
}

export function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (value: number) => void,
  formatValue: (value: number) => string = String,
): HTMLElement {
  const input = element('input', {
    type: 'range',
    min,
    max,
    step,
    value,
  });
  const display = text('slider-value', formatValue(value));
  input.addEventListener('input', () => {
    const next = Number(input.value);
    display.textContent = formatValue(next);
    onInput(next);
  });
  return div('slider', [
    div('slider-head', [text('slider-label', label), display]),
    input,
  ]);
}

export function select<T extends string>(
  value: T,
  options: { value: T; label: string }[],
  onChange: (value: T) => void,
): HTMLSelectElement {
  const node = element('select', { class: 'select' });
  for (const option of options) {
    const child = element('option', { value: option.value });
    child.textContent = option.label;
    if (option.value === value) child.selected = true;
    node.append(child);
  }
  node.addEventListener('change', () => onChange(node.value as T));
  return node;
}

/** A collapsible panel. Open state is remembered for the session only. */
export function panel(
  title: string,
  body: HTMLElement,
  open = true,
): HTMLDetailsElement {
  const summary = element('summary', { class: 'panel-title' });
  summary.textContent = title;
  const node = element('details', { class: 'panel' }, [summary, body]);
  node.open = open;
  return node;
}

export const clear = (node: HTMLElement): void => {
  node.replaceChildren();
};
