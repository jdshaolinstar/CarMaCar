// Wires the simulated city to the platform. Truth stays here; only pixels and pose are sent.
import { distance, dot, generateCity, rightOf, scale, type AgentEvent, type CameraPose, type ParkingVision, type TrashVision, type TripPlan, type TwinSnapshot, type Vec2 } from '@carmacar/shared';
import { LiveMap } from './map';
import { navigate } from './nav';
import { PhoneApp } from './phone';
import { PlatformClient } from './platform';
import { CityScene, type CameraView } from './scene';
import { renderSystems, type SystemDef } from './systems';
import { renderResults } from './results';
import { World, type Car, type NavMode, CAR_COLORS } from './world';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 11);
const scouts = Number(params.get('scouts') ?? 8);
const drivers = Number(params.get('drivers') ?? 30);
const networkShare = Number(params.get('guided') ?? 0.4);
const autopilotShare = Number(params.get('autopilot') ?? 0.3);
const gpsShare = Number(params.get('gps') ?? 0.2);
let framesPerSecond = Number(params.get('fps') ?? 1);
const parkedShare = Number(params.get('parked') ?? 0.62);
let timeScale = Number(params.get('speed') ?? 1);
let visionOn = true;
let garageVisionOn = true;
let trashScanOn = true;
let parkingVision: ParkingVision = 'sam';
let trashVision: TrashVision = 'spark';
let strategistOn = false;
/** Set by the stolen stall playbook: the next stall the trip agent reserves gets taken. */
let stealNextPlannedStall = false;

interface Playbook {
  id: string;
  title: string;
  description: string;
  watch: string;
  run(): void;
}

let tesOn = true;
let smartLightsOn = false;
let lightsOn = true;
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
world.autopilotShare = autopilotShare;
world.gpsShare = gpsShare;
world.populateParked(parkedShare);
world.addScouts(scouts);
world.addWalkers(Number(params.get('walkers') ?? 60), 8, 8);
world.scatterLitter(Number(params.get('litter') ?? 25));
const hero = world.addHero();
world.setDemand(World.makeDemand(city, seed + 1, drivers, 300, { guided: networkShare, autopilot: autopilotShare, gps: gpsShare }));
if (platform) platform.edgeOf = (carId) => world.cars.get(carId)?.edge;
hero.nav = 'guided';
hero.sharesGps = true;

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
  if (car.phase !== 'drive' || car.insideGarage) return null;
  const graph = world.graph;
  const seg = graph.segmentBetween(car.edge.from, car.edge.to);
  const dir = graph.edgeDir(car.edge);
  if (dot(car.heading, dir) < 0.98) return null;
  const nearby = city.stalls.filter((s) => !s.garageId && s.segmentId === seg.id && distance(s.center, car.pos) < 26);
  if (nearby.length === 0) return null;
  const onRight = dot(nearby[0].normal, rightOf(car.heading)) > 0;
  return { side: scale(rightOf(car.heading), onRight ? 1 : -1), stallIds: nearby.map((s) => s.id) };
}

/** Every network car is a camera. The one looking at the stalest stalls goes next. */
const garageCameras = city.garages.flatMap((g) =>
  g.cameras.map((camera, index) => ({ id: `${g.id}-cam${index + 1}`, garage: g, camera })),
);
let photosTaken = 0;
let nextGarageCamera = 0;

/** Every third photo comes from a fixed garage camera, taking turns. */
function chooseGarageCamera(): { id: string; pose: CameraPose } | null {
  if (!garageVisionOn || garageCameras.length === 0) return null;
  const { id, garage, camera } = garageCameras[nextGarageCamera++ % garageCameras.length];
  return {
    id,
    pose: {
      position: camera.position,
      target: camera.target,
      fovY: camera.fovY,
      width: 1280,
      height: 720,
      garageId: garage.id,
      level: camera.level,
      floorY: camera.level * garage.floorHeight,
    },
  };
}

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
  const fromGarage = ++photosTaken % 3 === 0 ? chooseGarageCamera() : null;
  const fromCar = fromGarage ? null : chooseCamera();
  const pose = fromGarage?.pose ?? fromCar?.pose;
  if (pose && fromCar && trashScanOn && photosTaken % 3 === 1) pose.scanTrash = true;
  const scoutId = fromGarage?.id ?? fromCar?.car.id;
  if (!pose || !scoutId) return;
  inFlight++;
  if (fromCar) fromCar.car.metersSinceCapture = 0;
  try {
    // Truth is copied at the moment of rendering, so a reading is judged on what the photo showed.
    let truth = new Set<string>();
    const dataUrl = await scene.captureFrame(pose, () => {
      truth = new Set(world.stallOwner.keys());
    });
    const capturedAt = Date.now();
    frameImages.set(`${scoutId}:${capturedAt}`, dataUrl);
    truthAtCapture.set(`${scoutId}:${capturedAt}`, truth);
    if (frameImages.size > 16) frameImages.delete(frameImages.keys().next().value!);
    const ok = await platform.sendFrame({
      scoutId,
      jpeg: dataUrl.split(',')[1],
      pose,
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
  $('stat-gps').textContent = String([...world.cars.values()].filter((c) => c.sharesGps && c.phase === 'drive').length);
  $('stat-camera-cars').textContent = String(twin.cameraTrafficCounts);
  $('stat-trash').textContent = String(twin.trashPins.length);
  $('stat-clean').textContent = String(world.cleanupKarma);
  $('trash-note').textContent = twin.trashNote ?? '';
  world.litterPins = twin.trashPins;
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
    if (stealNextPlannedStall && highlight) {
      stealNextPlannedStall = false;
      toggleStallCar(highlight);
    }
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
  const navText = { self: 'plots its own route', guided: 'TES guided', autopilot: 'TES autopilot' }[car.nav];
  const roleText = { hero: 'Your car', scout: 'Survey car', network: 'Driver', manual: 'Driver', parked: 'Parked car' }[car.role];
  const kind = `${roleText}, ${navText}${car.sharesGps ? ', sharing GPS' : ''}`;
  const place = city.destinations.find((d) => d.id === car.destinationId);
  return place ? `${kind}, heading to ${place.name}` : kind;
}

function showSelection() {
  const car = world.cars.get(selectedId);
  if (car) ($('nav-mode') as HTMLSelectElement).value = car.nav;
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

const garageView = $('garage-view') as HTMLSelectElement;
garageView.addEventListener('change', () => scene.setGarageView(Number(garageView.value)));

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
    id: 'garageCameras',
    name: 'Garage cameras',
    description: 'Fixed cameras on every garage level.',
    layer: 'production',
    engine: 'Meta SAM 3.1 with geometry code',
    control: { type: 'toggle', value: true },
  },
  {
    id: 'trash',
    name: 'Trash detection',
    description: 'Every third street photo also looks for trash and pins it on the map.',
    layer: 'production',
    engine: 'Meta Muse Spark or SAM 3.1, chosen below',
    control: { type: 'toggle', value: true },
  },
  {
    id: 'parkingVision',
    name: 'Parking vision model',
    description: 'What reads stalls. SAM is fast and repeatable. Spark reasons about the scene but takes seconds.',
    layer: 'production',
    engine: 'Your choice',
    control: {
      type: 'choice',
      value: 'sam',
      options: [
        { value: 'sam', label: 'SAM 3.1' },
        { value: 'spark', label: 'Muse Spark' },
      ],
    },
  },
  {
    id: 'trashVision',
    name: 'Trash vision model',
    description: 'Spark found twice as much in testing and names the type. SAM is faster.',
    layer: 'production',
    engine: 'Your choice',
    control: {
      type: 'choice',
      value: 'spark',
      options: [
        { value: 'spark', label: 'Muse Spark' },
        { value: 'sam', label: 'SAM 3.1' },
        { value: 'sam+spark', label: 'SAM + Spark check' },
      ],
    },
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
    id: 'tes',
    name: 'Traffic Efficiency System',
    description: 'Plots a route and a stall for every connected car.',
    layer: 'production',
    engine: 'Routing code, with goals from Meta Muse Spark',
    control: { type: 'toggle', value: true },
  },
  {
    id: 'smartLights',
    name: 'Smart traffic lights',
    description: 'Lights favor the direction with the most cars.',
    layer: 'production',
    engine: 'Routing code, no LLM',
    control: { type: 'toggle', value: false },
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
    name: 'Guided cars',
    description: 'Get a TES route, but a person may ignore it.',
    layer: 'simulation',
    engine: 'Scripted people, no AI',
    control: { type: 'range', value: networkShare, min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
  },
  {
    id: 'autopilot',
    name: 'Autopilot cars',
    description: 'Follow TES exactly. Tighter gaps, quicker starts.',
    layer: 'simulation',
    engine: 'Scripted self-driving stand-in',
    control: { type: 'range', value: autopilotShare, min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
  },
  {
    id: 'gps',
    name: 'Other cars sharing GPS',
    description: 'Self-routed cars that still report location. The rest only cameras can see.',
    layer: 'simulation',
    engine: 'Setting',
    control: { type: 'range', value: gpsShare, min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
  },
  {
    id: 'litterers',
    name: 'People dropping litter',
    description: 'A few pedestrians drop trash as they walk.',
    layer: 'simulation',
    engine: 'Scripted, no AI',
    control: { type: 'toggle', value: true },
  },
  {
    id: 'samaritans',
    name: 'Good samaritans',
    description: 'Walkers in green head for pinned trash and earn karma.',
    layer: 'simulation',
    engine: 'Scripted, no AI',
    control: { type: 'toggle', value: true },
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

function syncTes() {
  world.signals.mode = !lightsOn ? 'off' : tesOn && smartLightsOn ? 'smart' : 'fixed';
  platform?.setTes({ enabled: tesOn, smartLights: tesOn && smartLightsOn, parkingVision, trashVision, strategist: tesOn && strategistOn });
}

async function sendTelemetry() {
  if (!platform || !tesOn) return;
  const vehicles = [...world.cars.values()]
    .filter((c) => c.sharesGps && c.phase === 'drive' && !c.insideGarage)
    .map((c) => ({ carId: c.id, edge: c.edge, speed: c.speed }));
  const reply = await platform.telemetry(vehicles).catch(() => null);
  for (const [node, axis] of Object.entries(reply?.signals ?? {})) world.signals.request(node, axis);
}
setInterval(() => void sendTelemetry(), 1000);

function applySystem(id: string, value: boolean | number | string) {
  if (id === 'vision') {
    visionOn = value as boolean;
    $('map-note').hidden = visionOn;
  } else if (id === 'garageCameras') garageVisionOn = value as boolean;
  else if (id === 'trash') trashScanOn = value as boolean;
  else if (id === 'parkingVision') {
    parkingVision = value as ParkingVision;
    syncTes();
  } else if (id === 'trashVision') {
    trashVision = value as TrashVision;
    syncTes();
  }
  else if (id === 'litterers') world.litterEnabled = value as boolean;
  else if (id === 'samaritans') world.samaritansEnabled = value as boolean;
  else if (id === 'photoRate') framesPerSecond = value as number;
  else if (id === 'tes') {
    tesOn = value as boolean;
    world.guidance = tesOn;
    syncTes();
  } else if (id === 'smartLights') {
    smartLightsOn = value as boolean;
    syncTes();
  }  else if (id === 'agent') {
    agentOn = value as boolean;
    ($('trip-send') as HTMLButtonElement).disabled = !agentOn;
    $('agent-note').hidden = agentOn;
  } else if (id === 'scouts') world.setScoutCount(value as number);
  else if (id === 'drivers') world.driversEnabled = value as boolean;
  else if (id === 'network') world.networkShare = value as number;
  else if (id === 'autopilot') world.autopilotShare = value as number;
  else if (id === 'gps') world.gpsShare = value as number;
  else if (id === 'lights') {
    lightsOn = value as boolean;
    syncTes();
  }  else if (id === 'speed') timeScale = value as number;
}

renderSystems($('systems-list'), systems, applySystem);

const systemsButton = $('systems-open');
systemsButton.addEventListener('click', () => {
  const panel = $('systems');
  panel.hidden = !panel.hidden;
  systemsButton.setAttribute('aria-pressed', String(!panel.hidden));
  if (!panel.hidden) {
    $('playbooks').hidden = true;
    $('playbooks-open').setAttribute('aria-pressed', 'false');
  }
});

// ---- Playbooks: one click sets up a scenario worth showing. ----

function setSystem(id: string, value: boolean | number | string) {
  const system = systems.find((s) => s.id === id);
  if (system) system.control.value = value as never;
  applySystem(id, value);
}

function openStreets() {
  for (const stall of city.stalls) {
    if (Math.random() < 0.5) world.removeCarFromStall(stall.id);
  }
}

const cinema = city.destinations.find((d) => d.kind === 'cinema')!;

const playbooks: Playbook[] = [
  {
    id: 'cleanup',
    title: 'Clean up the block',
    description: 'A burst of litter hits the sidewalks. Cameras pin it, and good samaritans in green go and get it.',
    watch: 'Yellow pins appear on the map, then clear only once a camera sees the spot is empty.',
    run() {
      setSystem('trash', true);
      setSystem('samaritans', true);
      world.scatterLitter(30);
    },
  },
  {
    id: 'surge-off',
    title: 'Movie theater surge, no TES',
    description: 'Spiderdude just let in. 70 cars head for Galaxy Cinema with no coordination, circling for spaces.',
    watch: 'Queues build around the cinema while the garages sit half empty.',
    run() {
      setSystem('tes', false);
      setSystem('smartLights', false);
      world.addSurge(cinema.id, 70, 60);
    },
  },
  {
    id: 'surge-on',
    title: 'Movie theater surge, with TES',
    description: 'The same 70 cars, but TES spreads them across streets and garages before they arrive.',
    watch: 'Cars peel off to different stalls and garages. Compare with the run without TES.',
    run() {
      setSystem('tes', true);
      setSystem('smartLights', true);
      setSystem('network', 0.4);
      setSystem('autopilot', 0.4);
      world.addSurge(cinema.id, 70, 60);
    },
  },
  {
    id: 'autopilot',
    title: 'Self-driving city',
    description: 'Nearly every car follows TES on autopilot, with smart lights.',
    watch: 'Tighter gaps and quicker starts at each light.',
    run() {
      setSystem('tes', true);
      setSystem('smartLights', true);
      setSystem('network', 0.05);
      setSystem('autopilot', 0.95);
      world.addSurge(cinema.id, 30, 90);
    },
  },
  {
    id: 'parade',
    title: 'Parade on Market St',
    description: 'A plain-language goal goes to the Muse Spark city operator, which steers TES away from a street.',
    watch: 'Market St turns dashed blue on the map. Connected cars route around it.',
    run() {
      setSystem('tes', true);
      ($('operator-text') as HTMLInputElement).value = "There's a parade on Market St tonight. Keep cars away from it.";
      $('operator').dispatchEvent(new Event('submit', { cancelable: true }));
    },
  },
  {
    id: 'stolen-stall',
    title: 'Someone takes your stall',
    description: 'Your car gets a stall from the trip agent. A car takes it. Only a camera can reveal that.',
    watch: 'The map still says free, then a camera sees it and the agent moves you to another stall.',
    run() {
      setSystem('tes', true);
      const input = $('trip-text') as HTMLInputElement;
      input.value = 'Take me to Trattoria Luna and find parking';
      selectCar(hero.id);
      $('trip').dispatchEvent(new Event('submit', { cancelable: true }));
      stealNextPlannedStall = true;
    },
  },
  {
    id: 'no-cameras',
    title: 'What GPS alone misses',
    description: 'Camera vision goes off. GPS still shows connected cars, but no one can see parking or anyone else.',
    watch: 'The parking map freezes while traffic keeps changing around it.',
    run() {
      setSystem('vision', false);
      setSystem('garageCameras', false);
    },
  },
  {
    id: 'quiet',
    title: 'Back to normal',
    description: 'Resets every system to its default.',
    watch: 'A typical evening with a mix of drivers.',
    run() {
      setSystem('vision', true);
      setSystem('garageCameras', true);
      setSystem('tes', true);
      setSystem('smartLights', false);
      setSystem('network', 0.4);
      setSystem('autopilot', 0.3);
    },
  },
];

function runPlaybook(playbook: Playbook) {
  playbook.run();
  renderSystems($('systems-list'), systems, applySystem);
  $('playbook-title').textContent = `Running: ${playbook.title}`;
  $('playbook-watch').textContent = `Watch for: ${playbook.watch}`;
  $('playbook-now').hidden = false;
}

function renderPlaybooks() {
  const list = $('playbook-list');
  list.replaceChildren();
  for (const playbook of playbooks) {
    const button = document.createElement('button');
    button.type = 'button';
    const title = document.createElement('b');
    title.textContent = playbook.title;
    const text = document.createElement('span');
    text.textContent = playbook.description;
    button.append(title, text);
    button.addEventListener('click', () => runPlaybook(playbook));
    list.append(button);
  }
}
renderPlaybooks();

const playbooksButton = $('playbooks-open');
playbooksButton.addEventListener('click', () => {
  const panel = $('playbooks');
  panel.hidden = !panel.hidden;
  playbooksButton.setAttribute('aria-pressed', String(!panel.hidden));
  if (!panel.hidden) {
    $('systems').hidden = true;
    $('systems-open').setAttribute('aria-pressed', 'false');
  }
});

$('nav-mode').addEventListener('change', (e) => {
  const car = world.cars.get(selectedId);
  if (!car) return;
  const mode = (e.target as HTMLSelectElement).value as NavMode;
  // Autopilot means hands off.
  if (mode === 'autopilot' && driving) setDriving(false);
  world.setNavMode(car, mode);
  showSelection();
});

// Directions for a driven car follow TES, but nothing stops the driver going their own way.
let lastRouteAsk = 0;
function refreshDrivenRoute() {
  const car = driving ? world.cars.get(selectedId) : null;
  const stall = car?.targetStallId ? world.stalls.get(car.targetStallId) : null;
  if (!car || !stall || !platform || !tesOn || car.nav === 'self' || car.insideGarage) return;
  if (Date.now() - lastRouteAsk < 2500) return;
  lastRouteAsk = Date.now();
  void platform.route(car.id, car.edge, world.graph.approachEdge(stall)).then((chain) => {
    car.tesChain = chain;
  });
}
setInterval(refreshDrivenRoute, 500);

// Results.
renderResults($('results-list'));
const resultsButton = $('results-open');
resultsButton.addEventListener('click', () => {
  const panel = $('results');
  panel.hidden = !panel.hidden;
  resultsButton.setAttribute('aria-pressed', String(!panel.hidden));
  if (!panel.hidden) {
    for (const other of ['systems', 'playbooks']) {
      $(other).hidden = true;
      $(`${other}-open`).setAttribute('aria-pressed', 'false');
    }
  }
});

// The driver's phone.
const phone = new PhoneApp($('phone-map') as HTMLCanvasElement, city, world);
phone.renderDestinations($('phone-places'), (name) => {
  ($('trip-text') as HTMLInputElement).value = `Take me to ${name} and find parking`;
  $('trip').dispatchEvent(new Event('submit', { cancelable: true }));
});
const phoneButton = $('phone-open');
phoneButton.addEventListener('click', () => {
  const panel = $('phone');
  panel.hidden = !panel.hidden;
  phoneButton.setAttribute('aria-pressed', String(!panel.hidden));
});
setInterval(() => {
  if (!$('phone').hidden) phone.update(world.cars.get(selectedId), twin);
}, 250);

// Driving by hand.
const keys = new Set<string>();
let driving = false;

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (!driving) return;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  const car = world.cars.get(selectedId);
  if (!car) return;
  if (e.code === 'KeyP') world.togglePark(car);
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) world.useTransporter(car, Number(digit[1]) - 1);
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

$('operator').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('operator-text') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !platform || !agentOn) return;
  input.value = '';
  if (!(await platform.askOperator(text))) showStatus('The city operator did not accept that request. Try again.');
});

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
