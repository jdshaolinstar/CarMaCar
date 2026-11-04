// Wires the simulated city to the platform. Truth stays here; only pixels and pose are sent.
import { distance, dot, generateCity, rightOf, scale, type AgentEvent, type CameraPose, type TripPlan, type TwinSnapshot, type Vec2 } from '@carmacar/shared';
import { LiveMap } from './map';
import { navigate } from './nav';
import { PlatformClient } from './platform';
import { CityScene, type CameraView } from './scene';
import { renderSystems, type SystemDef } from './systems';
import { World, type Car, CAR_COLORS } from './world';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 11);
const scouts = Number(params.get('scouts') ?? 8);
const drivers = Number(params.get('drivers') ?? 30);
const networkShare = Number(params.get('network') ?? 0.7);
let framesPerSecond = Number(params.get('fps') ?? 1);
const parkedShare = Number(params.get('parked') ?? 0.62);
let timeScale = Number(params.get('speed') ?? 1);
let visionOn = true;
let agentOn = true;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
function showStatus(text: string | null) {
  statusEl.hidden = !text;
  statusEl.textContent = text ?? '';
}

const city = generateCity();
const platform = await PlatformClient.connect().catch((err: Error) => {
  showStatus(`Can't reach the platform. Start it, then reload. (${err.message})`);
  return null;
});

const world = new World(city, seed, platform);
world.keepCarsInCity = true;
world.networkShare = networkShare;
world.populateParked(parkedShare);
world.addScouts(scouts);
const hero = world.addHero();
world.setDemand(World.makeDemand(city, seed + 1, drivers, 300, networkShare));

const scene = new CityScene($('city') as HTMLCanvasElement, city, world);
const map = new LiveMap($('map') as HTMLCanvasElement, city);

let twin: TwinSnapshot | null = null;
let highlight: string | null = null;
const frameImages = new Map<string, string>();
const truthAtCapture = new Map<string, Set<string>>();
const readings = { right: 0, falseFree: [] as string[], falseTaken: [] as string[] };
let inFlight = 0;
let frameLimitHit = false;

/** Which side of the street has stalls near this car, if any. */
function stallSideFor(car: Car): { side: Vec2; stallIds: string[] } | null {
  if (car.phase !== 'drive') return null;
  const graph = world.graph;
  const seg = graph.segmentBetween(car.edge.from, car.edge.to);
  const dir = graph.edgeDir(car.edge);
  if (dot(car.heading, dir) < 0.98) return null;
  const nearby = city.stalls.filter((s) => s.segmentId === seg.id && distance(s.center, car.pos) < 26);
  if (nearby.length === 0) return null;
  const onRight = dot(nearby[0].normal, rightOf(car.heading)) > 0;
  return { side: scale(rightOf(car.heading), onRight ? 1 : -1), stallIds: nearby.map((s) => s.id) };
}

/** Every network car is a camera. The one looking at the stalest stalls goes next. */
function chooseCamera(): { car: Car; pose: CameraPose } | null {
  let best: { car: Car; side: Vec2 } | null = null;
  let bestAge = -1;
  const now = Date.now();
  for (const car of world.cars.values()) {
    if (!['scout', 'network', 'hero'].includes(car.role) || car.metersSinceCapture < 8) continue;
    const view = stallSideFor(car);
    if (!view) continue;
    // A driver looking at their own reserved stall comes first: that photo can save them the trip.
    const watchingOwnStall = car.targetStallId !== null && view.stallIds.includes(car.targetStallId);
    const age = watchingOwnStall
      ? Infinity
      : Math.max(
          ...view.stallIds.map((id) => {
            const seen = twin?.stalls[id]?.updatedAt;
            return seen ? now - seen : 1e9;
          }),
        );
    if (age > bestAge) {
      bestAge = age;
      best = { car, side: view.side };
    }
  }
  return best ? { car: best.car, pose: scene.poseFor(best.car, best.side) } : null;
}

async function takePhoto() {
  if (!platform || !visionOn || inFlight >= 3 || frameLimitHit) return;
  const choice = chooseCamera();
  if (!choice) return;
  inFlight++;
  choice.car.metersSinceCapture = 0;
  try {
    const dataUrl = await scene.captureFrame(choice.pose);
    const capturedAt = Date.now();
    frameImages.set(`${choice.car.id}:${capturedAt}`, dataUrl);
    truthAtCapture.set(`${choice.car.id}:${capturedAt}`, new Set(world.stallOwner.keys()));
    if (frameImages.size > 16) frameImages.delete(frameImages.keys().next().value!);
    const ok = await platform.sendFrame({
      scoutId: choice.car.id,
      jpeg: dataUrl.split(',')[1],
      pose: choice.pose,
      capturedAt,
    });
    if (!ok) frameLimitHit = (twin?.usage.frames ?? 0) >= (twin?.usage.frameLimit ?? Infinity) || !!twin?.usage.budgetExhausted;
  } catch (err) {
    console.warn('Photo failed', err);
  } finally {
    inFlight--;
  }
}

/** Scores each reading against what was true when the photo was taken. Runs only in the browser. */
function scoreReadings() {
  for (const report of twin?.frames ?? []) {
    const key = `${report.scoutId}:${report.capturedAt}`;
    const truth = truthAtCapture.get(key);
    if (!truth) continue;
    truthAtCapture.delete(key);
    for (const { id, state } of report.stalls) {
      const occupied = truth.has(id);
      if ((state === 'occupied') === occupied) readings.right++;
      else if (state === 'free') readings.falseFree.push(id);
      else readings.falseTaken.push(id);
    }
  }
}

let shownFrame = '';
function showLatestFrame() {
  const report = twin?.frames[0];
  if (!report || report.frameId === shownFrame) return;
  const image = frameImages.get(`${report.scoutId}:${report.capturedAt}`);
  if (!image) return;
  shownFrame = report.frameId;
  const img = $('frame-img') as HTMLImageElement;
  img.src = image;
  img.hidden = false;
  $('frame-empty').hidden = true;
  const svg = $('frame-masks');
  svg.innerHTML = report.detections
    .map((d) => {
      const [l, t, r, b] = d.box;
      const sx = (r - l) / d.maskWidth;
      const sy = (b - t) / d.maskHeight;
      const tag = d.stallId
        ? `<rect class="tag" x="${l}" y="${Math.max(t - 32, 0)}" width="${d.stallId.length * 18 + 16}" height="32"/><text x="${l + 8}" y="${Math.max(t - 8, 24)}">${d.stallId}</text>`
        : '';
      return `<path class="mask" transform="translate(${l} ${t}) scale(${sx} ${sy})" d="${d.maskPath}"/>${tag}`;
    })
    .join('');
  const vehicles = report.detections.length;
  $('frame-caption').textContent =
    `${report.model} found ${vehicles} ${vehicles === 1 ? 'vehicle' : 'vehicles'} in ${(report.latencyMs / 1000).toFixed(1)} s and read ${report.stalls.length} stalls. Photo deleted.`;
}

function updateStats() {
  if (!twin) return;
  let open = 0;
  let seen = 0;
  let matches = 0;
  for (const s of city.stalls) {
    const state = twin.stalls[s.id]?.state;
    if (state === 'free') open++;
    if (state === 'free' || state === 'occupied') {
      seen++;
      // Truth is only compared here, in the browser. It never goes to the platform.
      if ((state === 'occupied') === world.stallOwner.has(s.id)) matches++;
    }
  }
  $('stat-open').textContent = String(open);
  $('stat-seen').textContent = `${seen} of ${city.stalls.length}`;
  $('stat-accuracy').textContent = seen ? `${Math.round((100 * matches) / seen)}%` : 'No data';
  $('stat-frames').textContent = String(twin.usage.frames);
  const total = readings.right + readings.falseFree.length + readings.falseTaken.length;
  $('stat-readings').textContent = total ? `${((100 * readings.right) / total).toFixed(1)}%` : 'No data';
  $('stat-karma').textContent = String(Object.values(twin.karma).reduce((sum, k) => sum + k, 0));
  showStatus(twin.usage.budgetExhausted ? "Today's camera budget is used up. The map has stopped updating." : twin.usage.frames >= twin.usage.frameLimit ? 'This session reached its photo limit. Reload to start a new city.' : null);
}

const shownEvents = new Set<string>();
function updateLog() {
  if (!twin) return;
  const log = $('log');
  const events = [...twin.agentEvents].reverse();
  for (const e of events) {
    const key = `${e.at}:${e.kind}:${e.detail}`;
    if (shownEvents.has(key)) continue;
    shownEvents.add(key);
    const li = document.createElement('li');
    li.className = e.kind;
    renderEvent(li, e);
    log.prepend(li);
  }
}

function renderEvent(li: HTMLElement, e: AgentEvent) {
  if (e.kind === 'tool_call' || e.kind === 'tool_result') {
    const name = document.createElement('b');
    name.textContent = e.name ?? 'tool';
    li.append(name, ` ${e.kind === 'tool_call' ? 'called with' : 'returned'} ${e.detail}`);
  } else {
    li.textContent = e.detail;
  }
}

const appliedPlans = new Map<string, string>();
function applyTrips() {
  for (const plan of twin?.trips ?? []) {
    const car = world.cars.get(plan.carId);
    if (plan.status !== 'ready' || !car) continue;
    const signature = planSignature(plan);
    if (appliedPlans.get(plan.tripId) === signature) continue;
    appliedPlans.set(plan.tripId, signature);
    world.applyPlan(car, plan);
    highlight = plan.legs[0]?.stallId ?? null;
  }
}

const planSignature = (plan: TripPlan) => plan.legs.map((l) => `${l.destinationId}:${l.stallId}`).join('|');

async function pollTwin() {
  if (!platform) return;
  twin = await platform.twin().catch(() => null);
  if (!twin) return;
  scene.setStallStates(twin.stalls);
  world.syncWithTwin(twin);
  scoreReadings();
  updateStats();
  updateLog();
  showLatestFrame();
  applyTrips();
}

let placing = false;
function toggleStallCar(stallId: string) {
  const stall = world.stalls.get(stallId);
  if (!stall) return;
  if (world.stallOwner.has(stallId)) world.removeCarFromStall(stallId);
  else world.parkCarInStall(stall, 0, CAR_COLORS[stallId.length % CAR_COLORS.length], true);
  highlight = stallId;
}

const placeButton = $('place');
placeButton.addEventListener('click', () => {
  placing = !placing;
  placeButton.setAttribute('aria-pressed', String(placing));
  placeButton.textContent = placing ? 'Stop placing cars' : 'Place a car';
  $('place-hint').hidden = !placing;
  $('map').classList.toggle('placing', placing);
});

$('map').addEventListener('click', (e) => {
  const id = placing ? map.stallAt(e.clientX, e.clientY) : map.carAt(e.clientX, e.clientY, world);
  if (id && placing) toggleStallCar(id);
  else if (id) selectCar(id);
});

// A click, not the end of a drag that was moving the camera.
let pressedAt = { x: 0, y: 0 };
$('city').addEventListener('pointerdown', (e) => {
  pressedAt = { x: e.offsetX, y: e.offsetY };
});
$('city').addEventListener('pointerup', (e) => {
  if (Math.hypot(e.offsetX - pressedAt.x, e.offsetY - pressedAt.y) > 6) return;
  const id = placing ? scene.pickStall(e.offsetX, e.offsetY) : scene.pickCar(e.offsetX, e.offsetY);
  if (id && placing) toggleStallCar(id);
  else if (id) selectCar(id);
});

let selectedId: string = hero.id;
let currentView: CameraView = 'city';

function describeCar(car: Car): string {
  const kind = { hero: 'Your car', scout: 'Survey car', network: 'Network driver', manual: 'Driver with no app', parked: 'Parked car' }[car.role];
  const place = city.destinations.find((d) => d.id === car.destinationId);
  return place ? `${kind}, heading to ${place.name}` : kind;
}

function showSelection() {
  const car = world.cars.get(selectedId);
  $('selected-car').textContent = car ? describeCar(car) : 'That car has left the city. Click another.';
}

function setView(view: CameraView) {
  currentView = view;
  scene.setView(view, selectedId);
  for (const [id, name] of [['view-city', 'city'], ['view-chase', 'chase'], ['view-dash', 'dash']] as const) {
    $(id).setAttribute('aria-pressed', String(view === name));
  }
}

function selectCar(id: string) {
  selectedId = id;
  if (currentView !== 'city') scene.setView(currentView, id);
  showSelection();
}

$('view-city').addEventListener('click', () => setView('city'));
$('view-chase').addEventListener('click', () => setView('chase'));
$('view-dash').addEventListener('click', () => setView('dash'));

const labelsToggle = $('toggle-labels') as HTMLInputElement;
labelsToggle.addEventListener('change', () => scene.setLabelsVisible(labelsToggle.checked));

// The systems panel. Every switch here changes something real.
const systems: SystemDef[] = [
  {
    id: 'vision',
    name: 'Camera vision',
    description: 'Turns car photos into the parking map.',
    layer: 'production',
    engine: 'Meta SAM 3.1 with geometry code',
    control: { type: 'toggle', value: true },
  },
  {
    id: 'photoRate',
    name: 'Photos per second',
    description: 'How often the network looks. More photos cost more.',
    layer: 'production',
    engine: 'Setting',
    control: { type: 'range', value: framesPerSecond, min: 0.25, max: 3, step: 0.25, format: (v) => `${v}/s` },
  },
  {
    id: 'guidance',
    name: 'Parking guidance',
    description: 'Reserves stalls and sends network cars to them.',
    layer: 'production',
    engine: 'Rules, no LLM',
    control: { type: 'toggle', value: true },
  },
  {
    id: 'agent',
    name: 'Trip agent',
    description: 'Understands requests and plans trips with tools.',
    layer: 'production',
    engine: 'Meta Muse Spark',
    control: { type: 'toggle', value: true },
  },
  {
    id: 'scouts',
    name: 'Survey cars',
    description: 'Cars that drive around only to take photos.',
    layer: 'simulation',
    engine: 'Scripted, no AI',
    control: { type: 'range', value: scouts, min: 0, max: 16, step: 1, format: (v) => String(v) },
  },
  {
    id: 'drivers',
    name: 'City drivers',
    description: 'Cars taking trips and pulling out of stalls.',
    layer: 'simulation',
    engine: 'Scripted, no AI',
    control: { type: 'toggle', value: true },
  },
  {
    id: 'network',
    name: 'Drivers on the network',
    description: 'Share of drivers using CarMaCar. The rest search by eye.',
    layer: 'simulation',
    engine: 'Setting',
    control: { type: 'range', value: networkShare, min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
  },
  {
    id: 'lights',
    name: 'Traffic lights',
    description: 'Timed lights at every intersection.',
    layer: 'simulation',
    engine: 'Scripted, no AI',
    control: { type: 'toggle', value: true },
  },
  {
    id: 'speed',
    name: 'Simulation speed',
    description: 'How fast the city runs compared with real time.',
    layer: 'simulation',
    engine: 'Setting',
    control: { type: 'range', value: timeScale, min: 1, max: 4, step: 0.5, format: (v) => `${v}x` },
  },
];

function applySystem(id: string, value: boolean | number | string) {
  if (id === 'vision') {
    visionOn = value as boolean;
    $('map-note').hidden = visionOn;
  } else if (id === 'photoRate') framesPerSecond = value as number;
  else if (id === 'guidance') world.guidance = value as boolean;
  else if (id === 'agent') {
    agentOn = value as boolean;
    ($('trip-send') as HTMLButtonElement).disabled = !agentOn;
    $('agent-note').hidden = agentOn;
  } else if (id === 'scouts') world.setScoutCount(value as number);
  else if (id === 'drivers') world.driversEnabled = value as boolean;
  else if (id === 'network') world.networkShare = value as number;
  else if (id === 'lights') world.signals.mode = value ? 'fixed' : 'off';
  else if (id === 'speed') timeScale = value as number;
}

renderSystems($('systems-list'), systems, applySystem);

const systemsButton = $('systems-open');
systemsButton.addEventListener('click', () => {
  const panel = $('systems');
  panel.hidden = !panel.hidden;
  systemsButton.setAttribute('aria-pressed', String(!panel.hidden));
});

// Driving by hand.
const keys = new Set<string>();
let driving = false;

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (!driving) return;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyP') {
    const car = world.cars.get(selectedId);
    if (car) world.togglePark(car);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function readControls() {
  const car = driving ? world.cars.get(selectedId) : null;
  if (!car?.control) return;
  const up = keys.has('ArrowUp') || keys.has('KeyW');
  const down = keys.has('ArrowDown') || keys.has('KeyS') || keys.has('Space');
  const left = keys.has('ArrowLeft') || keys.has('KeyA');
  const right = keys.has('ArrowRight') || keys.has('KeyD');
  car.control.throttle = Number(up) - Number(down);
  car.control.steer = Number(right) - Number(left);
}

const driveButton = $('drive');
function setDriving(on: boolean) {
  const car = world.cars.get(selectedId);
  if (on) {
    if (!car || !world.takeControl(car)) {
      showStatus('Pick a moving car to drive. Parked cars have to pull out first.');
      return;
    }
  } else if (car?.control) {
    world.releaseControl(car);
  }
  driving = on;
  driveButton.setAttribute('aria-pressed', String(on));
  driveButton.textContent = on ? 'Stop driving' : 'Drive this car';
  $('drive-help').hidden = !on;
  if (on) setView('chase');
  else {
    $('nav').hidden = true;
    scene.setRoute(null);
    route = null;
  }
  driveButton.blur();
}
driveButton.addEventListener('click', () => setDriving(!driving));

let route: Vec2[] | null = null;
let routeKey = '';
function updateNav() {
  if (!driving) return;
  const car = world.cars.get(selectedId);
  const step = car ? navigate(world, car) : null;
  $('nav').hidden = !step;
  if (!step) {
    route = null;
    scene.setRoute(null);
    routeKey = '';
    return;
  }
  const arrows = { straight: '\u2191', left: '\u2190', right: '\u2192', arrive: '\u2691', park: 'P' };
  $('nav-icon').textContent = arrows[step.icon];
  $('nav-distance').textContent = step.distance;
  $('nav-instruction').textContent = step.instruction;
  route = step.path.points;
  const key = `${car!.edge.from}${car!.edge.to}${car!.targetStallId}${Math.round(route.length)}`;
  if (key !== routeKey) {
    routeKey = key;
    scene.setRoute(route);
  }
}
setInterval(updateNav, 400);

$('trip').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('trip-text') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !platform || !agentOn) return;
  input.value = '';
  const car = world.cars.get(selectedId) ?? hero;
  const id = await platform.requestTrip({ carId: car.id, text, position: car.pos });
  if (!id) showStatus('The trip agent did not accept that request. Try again.');
});

scene.start((dt) => {
  readControls();
  world.tick(dt * timeScale);
  map.draw(twin, world, highlight, selectedId, route);
});

function photoLoop() {
  void takePhoto();
  setTimeout(photoLoop, 1000 / framesPerSecond);
}
photoLoop();
setInterval(() => void pollTwin(), 700);
setInterval(showSelection, 1000);
showSelection();

// For scripted test runs.
Object.assign(window, { carmacar: { world, scene, hero, readings, getTwin: () => twin, toggleStallCar } });
