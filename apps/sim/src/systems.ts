// The control panel for every system in the demo.
// Production systems are the real product. Simulation systems stand in for the real world.
// New systems get added to SYSTEMS, so the panel always tells the truth about what is running.

export type Layer = 'production' | 'simulation';

type Control =
  | { type: 'toggle'; value: boolean }
  | { type: 'range'; value: number; min: number; max: number; step: number; format: (value: number) => string }
  | { type: 'choice'; value: string; options: { value: string; label: string; disabled?: boolean }[] };

export interface SystemDef<Id extends string = string> {
  id: Id;
  name: string;
  description: string;
  layer: Layer;
  /** What actually powers this, in plain words. */
  engine: string;
  control: Control;
}

const LAYER_TEXT: Record<Layer, { title: string; note: string }> = {
  production: { title: 'Production', note: 'The real product. These would run in a real city.' },
  simulation: { title: 'Simulation', note: 'Stand-ins for the real world. None of these exist in production.' },
};

function renderControl(system: SystemDef, onChange: (value: boolean | number | string) => void): HTMLElement {
  const { control } = system;
  if (control.type === 'toggle') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = control.value;
    input.setAttribute('aria-label', system.name);
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  }
  if (control.type === 'range') {
    const wrap = document.createElement('span');
    wrap.className = 'range';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(control.min);
    input.max = String(control.max);
    input.step = String(control.step);
    input.value = String(control.value);
    input.setAttribute('aria-label', system.name);
    const readout = document.createElement('output');
    readout.textContent = control.format(control.value);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      readout.textContent = control.format(value);
      onChange(value);
    });
    wrap.append(input, readout);
    return wrap;
  }
  const select = document.createElement('select');
  select.setAttribute('aria-label', system.name);
  for (const option of control.options) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    el.disabled = option.disabled ?? false;
    el.selected = option.value === control.value;
    select.append(el);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

export function renderSystems(root: HTMLElement, systems: SystemDef[], onChange: (id: string, value: boolean | number | string) => void) {
  root.replaceChildren();
  for (const layer of ['production', 'simulation'] as const) {
    const section = document.createElement('section');
    section.className = `layer ${layer}`;
    const heading = document.createElement('h2');
    heading.textContent = LAYER_TEXT[layer].title;
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = LAYER_TEXT[layer].note;
    section.append(heading, note);
    for (const system of systems.filter((s) => s.layer === layer)) {
      const row = document.createElement('div');
      row.className = 'system';
      const text = document.createElement('div');
      const name = document.createElement('p');
      name.className = 'system-name';
      name.textContent = system.name;
      const detail = document.createElement('p');
      detail.className = 'system-detail';
      detail.textContent = `${system.description} ${system.engine}.`;
      text.append(name, detail);
      row.append(text, renderControl(system, (value) => onChange(system.id, value)));
      section.append(row);
    }
    root.append(section);
  }
}
