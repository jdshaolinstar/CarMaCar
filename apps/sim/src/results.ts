// The results panel: the offline study, shown in the app. Always labelled as simulated.
import highwayRows from '../scripts/highway-results.json';
import rows from '../scripts/tes-results-all.json';

interface Row {
  scenario: string;
  mode: string;
  parked: number;
  searching: number;
  seconds: number;
  meters: number;
  walk: number;
  km: number;
}

const data = rows as Row[];

interface HighwayRow {
  scenario: string;
  limit: number;
  mode: string;
  seconds: number;
  missed: number;
  slow: number;
  systemHours: number;
}

const HIGHWAY_TABS: { label: string; scenario: string }[] = [
  { label: 'Highway rush hour', scenario: 'Rush hour' },
  { label: 'Highway stadium', scenario: 'Stadium event' },
];
const HIGHWAY_LIMIT = 65;

const SHORT_MODE: Record<string, string> = {
  'TES off': 'TES off',
  'TES on, 60% guided': '60% guided',
  'TES on, 30% guided, 30% autopilot': '30% guided, 30% autopilot',
  'TES on, 100% autopilot': '100% autopilot',
  'Same, plus smart lights': '100% autopilot + smart lights',
};

function barChart(title: string, unit: string, items: { label: string; value: number; baseline: boolean; note: string }[]) {
  const figure = document.createElement('figure');
  const caption = document.createElement('figcaption');
  caption.textContent = title;
  figure.append(caption);
  const max = Math.max(...items.map((i) => i.value));
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.title = item.note;
    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = item.label;
    const track = document.createElement('span');
    track.className = 'bar-track';
    const bar = document.createElement('span');
    bar.className = item.baseline ? 'bar baseline' : 'bar';
    bar.style.width = `${(item.value / max) * 100}%`;
    track.append(bar);
    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = `${Math.round(item.value)} ${unit}`;
    row.append(label, track, value);
    figure.append(row);
  }
  return figure;
}

export function renderResults(root: HTMLElement) {
  const scenarios = [...new Set(data.map((d) => d.scenario))];
  const tabs = [...scenarios, ...HIGHWAY_TABS.map((t) => t.label)];
  const body = document.createElement('div');

  function showHighway(scenario: string) {
    const rows = (highwayRows as HighwayRow[]).filter((d) => d.scenario === scenario && d.limit === HIGHWAY_LIMIT);
    const note = (d: HighwayRow) => `${Math.round(d.slow * 100)}% of mainline time below 30 mph, ${Math.round(d.systemHours)} vehicle-hours including cross streets`;
    const caption = document.createElement('p');
    caption.className = 'caption';
    caption.textContent = `Simulated at ${HIGHWAY_LIMIT} mph against the best fixed signal timing. TES cars keep the same following distance as people.`;
    body.replaceChildren(
      barChart('Average trip time', 's', rows.map((d) => ({ label: d.mode, value: d.seconds, baseline: d.mode === 'TES off', note: note(d) }))),
      barChart('Missed exits', '', rows.map((d) => ({ label: d.mode, value: d.missed, baseline: d.mode === 'TES off', note: note(d) }))),
      caption,
    );
  }

  function show(tab: string) {
    for (const [i, button] of [...buttons.children].entries()) {
      button.setAttribute('aria-pressed', String(tabs[i] === tab));
    }
    const highway = HIGHWAY_TABS.find((t) => t.label === tab);
    if (highway) showHighway(highway.scenario);
    else showCity(tab);
  }

  function showCity(scenario: string) {
    const scenarioRows = data.filter((d) => d.scenario === scenario);
    const off = scenarioRows.find((d) => d.mode === 'TES off');
    const label = (d: Row) => SHORT_MODE[d.mode] ?? d.mode;
    const note = (d: Row) => `${Math.round(d.parked)} parked, ${Math.round(d.searching)} still searching, ${Math.round(d.walk)} m walk`;
    const percent = (value: number, base: number | undefined) => (base ? ` (${value < base ? '' : '+'}${Math.round(((value - base) / base) * 100)}%)` : '');
    body.replaceChildren(
      barChart(
        'Average time to park',
        's',
        scenarioRows.map((d) => ({ label: label(d), value: d.seconds, baseline: d === off, note: `${note(d)}${percent(d.seconds, off?.seconds)}` })),
      ),
      barChart(
        'Drivers parked by the end',
        '',
        scenarioRows.map((d) => ({ label: label(d), value: d.parked, baseline: d === off, note: note(d) })),
      ),
    );
  }

  const buttons = document.createElement('div');
  buttons.className = 'views';
  for (const tab of tabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = tab;
    button.addEventListener('click', () => show(tab));
    buttons.append(button);
  }
  root.replaceChildren(buttons, body);
  show(tabs[0]);
}
