// Wires the simulated city to the platform. Truth stays here; only pixels and pose are sent.
import { distance, dot, generateCity, rampCameraView, rightOf, scale, type AgentEvent, type CameraPose, type CityMap, type ParkingVision, type TrashVision, type TripPlan, type TwinSnapshot, type Vec2 } from '@carmacar/shared';
import { LiveMap } from './map';
import { navigate } from './nav';
import { PhoneApp } from './phone';
import { PlatformClient } from './platform';
import { CityScene, type CameraView, type TimeOfDay } from './scene';
import { renderSystems, type SystemDef } from './systems';
import { renderResults } from './results';
import { DEFAULT_GRAPHICS_LEVEL, GRAPHICS_LEVELS, GraphicsLevels } from './graphics';
import { HIGHWAY_MODES, HighwayDemo, highwayDemoLayout, type HighwayModeId, type HighwayScenario } from './highway-demo';
import { HighwayView } from './highway-view';
import { ROUND_SECONDS, TrashHunt } from './trash-hunt';
import { World, type Car, type NavMode, type Walker, CAR_COLORS } from './world';

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
const RECENT_DRIVERS = 20;
const RESIDENT_REST_MS = 45_000;
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

// The demo town by default, or any city described in a file. See docs/PORTING.md.
const cityFile = params.get('city');
const city: CityMap = cityFile ? await (await fetch(cityFile)).json() : generateCity();
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
const readings = { right: 0, falseFree: [] as string[], falseTaken: [] as string[], misses: [] as { id: string; report: unknown; image: string }[] };
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
const CLEAR_VIEW_METRES = 13;
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

function chooseCamera(): { car: Car; getPose: () => CameraPose } | null {
  let best: { car: Car; side: Vec2 } | null = null;
  let bestAge = -1;
  const now = Date.now();
  for (const car of world.cars.values()) {
    if (!['scout', 'network', 'hero'].includes(car.role) || car.metersSinceCapture < 8) continue;
    const view = stallSideFor(car);
    if (!view) continue;
    // A blocked view can look like an empty street, so a car right behind another stays quiet.
    if (!world.viewClear(car, CLEAR_VIEW_METRES)) continue;
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
  if (!best) return null;
  const { car, side } = best;
  return { car, getPose: () => scene.poseFor(car, side) };
}

async function takePhoto() {
  if (!platform || !visionOn || inFlight >= 3 || frameLimitHit) return;
  const fromGarage = ++photosTaken % 3 === 0 ? chooseGarageCamera() : null;
  const fromCar = fromGarage ? null : chooseCamera();
  const getPose = fromGarage ? () => fromGarage.pose : fromCar?.getPose;
  const scanTrash = !!fromCar && trashScanOn && photosTaken % 3 === 1;
  const scoutId = fromGarage?.id ?? fromCar?.car.id;
  if (!getPose || !scoutId) return;
  inFlight++;
  if (fromCar) fromCar.car.metersSinceCapture = 0;
  try {
    // Truth is copied at the moment of rendering, so a reading is judged on what the photo showed.
    let truth = new Set<string>();
    const { dataUrl, pose } = await scene.captureFrame(getPose, () => {
      truth = new Set(world.stallOwner.keys());
    });
    if (scanTrash) pose.scanTrash = true;
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
      else if (state === 'free') {
        readings.falseFree.push(id);
        if (readings.misses.length < 3) readings.misses.push({ id, report, image: frameImages.get(key) ?? '' });
      }
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
  const recent = world.parkedLog.filter((r) => r.role === 'network' || r.role === 'manual').slice(-RECENT_DRIVERS);
  if (recent.length) $('stat-park-time').textContent = `${Math.round(recent.reduce((t, r) => t + r.seconds, 0) / recent.length)} s`;
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
  const who = car.residentName ? `${car.residentName}, an AI resident` : roleText;
  const kind = `${who}, ${navText}${car.sharesGps ? ', sharing GPS' : ''}`;
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
    id: 'strategist',
    name: 'Spark Strategist',
    description: 'Reviews the whole city every 30 seconds and steers routes, lights and parking.',
    layer: 'production',
    engine: 'Meta Muse Spark',
    control: { type: 'toggle', value: false },
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
    id: 'highwayTes',
    name: 'Highway TES',
    description: 'Uses known exits to move cars over early, keep the right lane clear, and spread traffic across exits.',
    layer: 'production',
    engine: 'Routing logic, fed by GPS and ramp cameras',
    control: {
      type: 'choice',
      value: 'off',
      options: (Object.keys(HIGHWAY_MODES) as HighwayModeId[]).map((value) => ({ value, label: HIGHWAY_MODES[value].label })),
    },
  },
  {
    id: 'highwayLights',
    name: 'Smart ramp lights',
    description: 'Shifts green time between ramps and cross streets. In testing this did not reduce total delay, so it is off by default.',
    layer: 'production',
    engine: 'Routing logic, needs ramp cameras',
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
    id: 'residents',
    name: 'AI residents',
    description: 'Maya, Dev and Rosa decide their own evenings, then use the app like anyone else.',
    layer: 'simulation',
    engine: 'Meta Muse Spark',
    control: { type: 'toggle', value: false },
  },
  {
    id: 'graphics',
    name: 'Graphics level',
    description: 'How the city looks to you, from plain blocks up. Cameras see the same frames at every level.',
    layer: 'simulation',
    engine: 'Display only',
    control: {
      type: 'range',
      value: DEFAULT_GRAPHICS_LEVEL,
      min: 1,
      max: GRAPHICS_LEVELS.length,
      step: 1,
      format: (v) => `${v}: ${GRAPHICS_LEVELS[v - 1].name}`,
    },
  },
  {
    id: 'trashHunt',
    name: 'Trash hunt game',
    description: 'A timed round on foot against three rivals. Traffic carries on exactly as it would without it.',
    layer: 'simulation',
    engine: 'Game rules, no AI',
    control: { type: 'toggle', value: false },
  },
  {
    id: 'highway',
    name: 'Ring highway',
    description: 'A three-lane highway around the town with five interchanges. Its drivers are modeled, not scripted.',
    layer: 'simulation',
    engine: 'Driver model, no AI',
    control: { type: 'toggle', value: false },
  },
  {
    id: 'highwayScenario',
    name: 'Highway traffic',
    description: 'Evenly spread rush hour, or an event that sends half the traffic to one exit.',
    layer: 'simulation',
    engine: 'Scripted demand',
    control: {
      type: 'choice',
      value: 'rush',
      options: [
        { value: 'rush', label: 'Rush hour' },
        { value: 'stadium', label: 'Stadium event' },
      ],
    },
  },
  {
    id: 'highwayLimit',
    name: 'Highway speed limit',
    description: 'Restarts the highway with the same drivers.',
    layer: 'simulation',
    engine: 'Road setting',
    control: {
      type: 'choice',
      value: '65',
      options: [
        { value: '55', label: '55 mph' },
        { value: '65', label: '65 mph' },
        { value: '75', label: '75 mph' },
      ],
    },
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
    id: 'timeOfDay',
    name: 'Time of day',
    description: 'Cameras see the same light, so night also tests the vision models.',
    layer: 'simulation',
    engine: 'Setting',
    control: {
      type: 'choice',
      value: 'day',
      options: [
        { value: 'day', label: 'Day' },
        { value: 'dusk', label: 'Dusk' },
        { value: 'night', label: 'Night' },
      ],
    },
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
  else if (id === 'residents') {
    residentsOn = value as boolean;
    if (residentsOn) assignResidents();
  }
  else if (id === 'strategist') {
    strategistOn = value as boolean;
    syncTes();
  } else if (id === 'parkingVision') {
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
  else if (id === 'timeOfDay') {
    scene.setTimeOfDay(value as TimeOfDay);
    graphics.setTime(value as TimeOfDay);
  } else if (id === 'graphics') graphics.set(value as number);
  else if (id === 'highway') setHighway(value as boolean);
  else if (id === 'trashHunt') {
    if (value) startHunt();
    else if (hunt) quitHunt();
  }
  else if (id === 'highwayTes') highwayDemo().apply({ mode: value as HighwayModeId });
  else if (id === 'highwayLights') highwayDemo().apply({ smartLights: value as boolean });
  else if (id === 'highwayLimit') highwayDemo().apply({ limitMph: Number(value) });
  else if (id === 'highwayScenario') highwayDemo().apply({ scenario: value as HighwayScenario });
}

const graphics = new GraphicsLevels(scene, city);

// The highway, built only when someone asks for it.
let highwayView: HighwayView | null = null;
let highway: HighwayDemo | null = null;
let highwayOn = false;

function highwayDemo() {
  if (!highway) {
    highwayView = new HighwayView(scene.scene, city, highwayDemoLayout(), (variant, color) => scene.carTemplate(variant, color));
    highway = new HighwayDemo(highwayView, seed);
  }
  return highway;
}

function setHighway(on: boolean) {
  highwayOn = on;
  highwayDemo();
  highwayView!.setEnabled(on);
  scene.frameHighway(on);
  if (!on) stopRide();
  $('highway-panel').hidden = !on;
  document.body.classList.toggle('highway', on);
}

let ridingCar: string | null = null;

function stopRide() {
  ridingCar = null;
  scene.followPose(null);
  $('hw-ride').setAttribute('aria-pressed', 'false');
}

$('hw-ride').addEventListener('click', () => {
  if (ridingCar) return stopRide();
  ridingCar = highwayDemo().pickCar();
  if (!ridingCar) return;
  scene.followPose(() => highwayView!.pose(ridingCar!));
  $('hw-ride').setAttribute('aria-pressed', 'true');
});

function showHighway() {
  if (!highwayOn || !highway) return;
  const { live, baseline, reportingShare } = highway.stats();
  const trip = (s: number | null) => (s === null ? 'No data' : `${Math.round(s)} s`);
  $('highway-title').textContent = `Highway, ${HIGHWAY_MODES[highway.settings.mode].label}, ${highway.settings.limitMph} mph`;
  $('hw-mph').textContent = `${Math.round(live.mph)} mph`;
  $('hw-base-mph').textContent = `${Math.round(baseline.mph)} mph`;
  $('hw-slow').textContent = `${Math.round(live.slowShare * 100)}%`;
  $('hw-base-slow').textContent = `${Math.round(baseline.slowShare * 100)}%`;
  $('hw-trip').textContent = trip(live.tripSeconds);
  $('hw-base-trip').textContent = trip(baseline.tripSeconds);
  $('hw-missed').textContent = String(live.missed);
  $('hw-base-missed').textContent = String(baseline.missed);
  const seen = reportingShare === null ? '' : ` Ramp cameras show TES can see ${Math.round(reportingShare * 100)}% of traffic.`;
  $('hw-note').textContent = `Simulated. Blue cars are on TES. The band on the road shows speed.${seen}`;
  if (ridingCar && !highway.sim.cars.some((c) => c.id === ridingCar && c.place === 'main')) stopRide();
}
setInterval(showHighway, 500);

// Ramp cameras. One real frame at a time, in turn, read by SAM. Truth is copied when the frame is
// rendered and stays in the browser, for the score only.
const RAMP_FRAME_MS = 2500;
const rampReadings: { exit: number; count: number; truth: number; ms: number }[] = [];
let nextRamp = 0;

async function readRamp() {
  if (!highwayOn || !highway || !highwayView || !platform || !visionOn) return;
  const { tes } = HIGHWAY_MODES[highway.settings.mode];
  if (!tes?.cameras) return;
  const exit = nextRamp;
  nextRamp = (nextRamp + 1) % highwayView.layout.interchanges.length;
  const view = rampCameraView(highwayView.interchanges[exit].offRamp, 1280, 720);
  let truth = 0;
  const { dataUrl } = await scene.captureFrame(
    () => view.pose,
    () => (truth = highwayView!.carsInView(view)),
  );
  const reply = await platform.sendRampFrame({ exit, jpeg: dataUrl.split(',')[1], pose: view.pose, region: view.region }).catch(() => null);
  if (!reply) return;
  highway.sim.setRampReading(exit, reply.count);
  rampReadings.push({ exit, count: reply.count, truth, ms: reply.latencyMs });
  ($('hw-frame') as HTMLImageElement).src = dataUrl;
  $('hw-camera').hidden = false;
  $('hw-boxes').innerHTML = reply.boxes
    .map(([x0, y0, x1, y1]) => `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}"></rect>`)
    .join('');
  const name = highwayView.layout.interchanges[exit].name;
  $('hw-reading').hidden = false;
  $('hw-reading').textContent = `${name} ramp camera: ${reply.model} counted ${reply.count} cars. Actual: ${truth}.`;
}
setInterval(() => void readRamp().catch((err) => console.warn('Ramp photo failed', err)), RAMP_FRAME_MS);

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
    id: 'los-angeles',
    title: 'Los Angeles, one morning commute',
    description: "Leaves the 3D city for a 2D study of TES on Los Angeles's real road network, with commuters modeled from Census data. Simulated traffic, not measurements.",
    watch: 'Compare the two maps at 8 AM, then change the share of drivers on TES.',
    run: () => window.location.assign('metro.html'),
  },
  {
    id: 'trash-hunt',
    title: 'Trash hunt',
    description: `A ${ROUND_SECONDS / 60} minute round on foot against three rivals. Bigger trash scores more, quick pickups build a streak, and gold is hidden on the sidewalks.`,
    watch: 'Rivals head for what cameras report, or what they can see. You can get ahead by spotting what cameras have missed.',
    run: () => setSystem('trashHunt', true),
  },
  {
    id: 'highway-off',
    title: 'Highway rush hour, no TES',
    description: 'Nobody knows where anyone is getting off. Drivers cut across lanes late and exit queues reach the mainline.',
    watch: 'Red bands on the road show where traffic has broken down. Count the missed exits in the panel.',
    run() {
      setSystem('highwayScenario', 'rush');
      setSystem('highwayTes', 'off');
      setSystem('highway', true);
    },
  },
  {
    id: 'highway-on',
    title: 'Highway rush hour, with TES',
    description: 'The same drivers, on autopilot. TES knows every exit, so cars move over early and through traffic keeps the right lane clear.',
    watch: 'The panel compares this run to the same drivers without TES. Press Ride along to see it from the road.',
    run() {
      setSystem('highwayScenario', 'rush');
      setSystem('highwayTes', 'autopilot');
      setSystem('highway', true);
    },
  },
  {
    id: 'highway-stadium',
    title: 'Stadium exit, with TES',
    description: 'Half the traffic wants one exit. TES knows everyone\'s destination and moves some to a quieter exit before the queue forms.',
    watch: 'This is where knowing destinations helps most. Compare trip time and missed exits in the panel.',
    run() {
      setSystem('highwayScenario', 'stadium');
      setSystem('highwayTes', 'autopilot');
      setSystem('highway', true);
    },
  },
  {
    id: 'highway-cameras',
    title: 'Only 30% share GPS',
    description: 'Most drivers aren\'t on the network. Ramp cameras count everyone, which shows TES how much traffic it can\'t see.',
    watch: 'Switch Highway TES between GPS only and plus cameras in Systems, using Stadium event traffic.',
    run() {
      setSystem('highwayScenario', 'stadium');
      setSystem('highwayTes', 'cameras30');
      setSystem('highway', true);
    },
  },
  {
    id: 'residents',
    title: 'Meet the residents',
    description: 'Muse Spark plays Maya, Dev and Rosa, who decide where to go next and ask the app for a trip.',
    watch: 'Their thoughts appear in the log. Each one then goes through the real trip agent.',
    run() {
      setSystem('tes', true);
      setSystem('residents', true);
    },
  },
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
      setSystem('strategist', false);
      world.addSurge(cinema.id, 70, 60);
    },
  },
  {
    id: 'surge-on',
    title: 'Movie theater surge, with TES',
    description: 'The same 70 cars, but TES spreads them across streets and garages, with Muse Spark reviewing the city.',
    watch: 'Cars peel off to different stalls and garages. Read what the strategist decides in the log.',
    run() {
      setSystem('tes', true);
      setSystem('smartLights', true);
      setSystem('strategist', true);
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

// AI residents: a few people played by Muse Spark, who decide their own evenings.
const RESIDENTS = [
  { name: 'Maya', persona: 'A nurse just off a long shift, hungry, loves noodles, and avoids crowds.' },
  { name: 'Dev', persona: 'A film nerd who never misses an opening night and always wants coffee first.' },
  { name: 'Rosa', persona: 'A retired teacher running errands, who chats with everyone at the grocery store.' },
];
const residentCars = new Map<string, { name: string; persona: string; car: Car; busy: boolean; lastPlace: string | null }>();
let residentsOn = false;

function assignResidents() {
  const drivers = [...world.cars.values()].filter((c) => c.role === 'parked' && !c.insideGarage && c.phase === 'parked');
  RESIDENTS.forEach((resident, i) => {
    const car = drivers[i * 7];
    if (!car || residentCars.has(resident.name)) return;
    car.residentName = resident.name;
    car.leaveAt = Infinity;
    world.setNavMode(car, 'guided');
    residentCars.set(resident.name, { ...resident, car, busy: false, lastPlace: null });
  });
}

async function runResidents() {
  if (!platform || !residentsOn) return;
  for (const resident of residentCars.values()) {
    const { car } = resident;
    // A resident thinks about what's next once they have arrived somewhere.
    if (resident.busy || car.phase !== 'parked' || !world.cars.has(car.id)) continue;
    resident.busy = true;
    const place = city.destinations.find((d) => d.id === car.destinationId)?.name ?? null;
    const choice = await platform.askResident({ name: resident.name, persona: resident.persona, lastPlace: place });
    if (choice) {
      resident.lastPlace = place;
      await platform.requestTrip({ carId: car.id, text: choice.request, position: car.pos });
    }
    setTimeout(() => (resident.busy = false), RESIDENT_REST_MS);
  }
}
setInterval(() => void runResidents(), 5000);

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
  if (walker) {
    if (e.code.startsWith('Arrow')) e.preventDefault();
    if (e.code === 'KeyE') world.pickUpLitter(walker);
    if (e.code === 'KeyV' && hunt) {
      huntEyes = !huntEyes;
      scene.setWalkerEyes(huntEyes);
    }
    return;
  }
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

// On foot, cleaning up.
let walker: Walker | null = null;
const walkButton = $('walk');
const PLAYER_COLOR = '#FF8A1F';

function setWalking(on: boolean) {
  if (on && driving) setDriving(false);
  if (on) {
    walker = world.takeWalker();
  } else if (walker) {
    world.releaseWalker(walker);
    walker = null;
  }
  scene.followWalker(walker);
  walkButton.setAttribute('aria-pressed', String(!!walker));
  walkButton.textContent = walker ? 'Stop walking' : 'Walk and clean';
  $('walk-help').hidden = !walker;
  if (!walker) $('nav').hidden = true;
  walkButton.blur();
}
walkButton.addEventListener('click', () => setWalking(!walker));

function readWalkKeys() {
  if (!walker?.input) return;
  const up = keys.has('ArrowUp') || keys.has('KeyW');
  const down = keys.has('ArrowDown') || keys.has('KeyS');
  const left = keys.has('ArrowLeft') || keys.has('KeyA');
  const right = keys.has('ArrowRight') || keys.has('KeyD');
  const running = hunt && !hunt.over && (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? RUN_FACTOR : 1;
  walker.input.forward = (Number(up) - Number(down) * 0.5) * running;
  walker.input.turn = Number(right) - Number(left);
}

/** Points the walker at the nearest trash that cameras have reported. */
function updateWalkGuide() {
  if (!walker) return;
  const pins = twin?.trashPins ?? [];
  $('nav').hidden = false;
  if (pins.length === 0) {
    $('nav-icon').textContent = '\u2691';
    $('nav-distance').textContent = 'All clear';
    $('nav-instruction').textContent = hunt ? 'No reports yet. Use your eyes.' : 'No trash reported nearby';
    return;
  }
  const from = walker.pos;
  const pin = [...pins].sort((a, b) => distance(a, from) - distance(b, from))[0];
  const to = { x: pin.x - from.x, z: pin.z - from.z };
  const ahead = dot(to, walker.heading);
  const side = dot(to, rightOf(walker.heading));
  const metres = Math.round(distance(pin, from));
  $('nav-icon').textContent = ahead > Math.abs(side) ? '\u2191' : side > 0 ? '\u2192' : '\u2190';
  $('nav-distance').textContent = `${metres} m`;
  $('nav-instruction').textContent = metres < 3 ? 'Press E to pick it up' : `Trash reported: ${pin.category}`;
}
setInterval(updateWalkGuide, 300);

// Trash hunt: a timed round on foot against other pedestrians. Traffic is not affected.
const RUN_FACTOR = 1.7;
const BEST_SCORE_KEY = 'carmacar-trash-hunt-best';
let hunt: TrashHunt | null = null;
let huntEyes = false;
let huntRound = 0;

function readBest() {
  try {
    return Number(localStorage.getItem(BEST_SCORE_KEY) ?? 0);
  } catch {
    return 0;
  }
}

function saveBest(score: number) {
  try {
    localStorage.setItem(BEST_SCORE_KEY, String(score));
  } catch {
    // Private windows can block storage. The game works without a saved best.
  }
}

function startHunt() {
  hunt?.finish();
  if (highwayOn) setSystem('highway', false);
  if (!walker) setWalking(true);
  if (!walker) return;
  if (walker.color !== PLAYER_COLOR) {
    walker.color = PLAYER_COLOR;
    scene.recolorWalker(walker);
  }
  hunt = new TrashHunt(world, walker, seed + 1000 + huntRound++);
  document.body.classList.add('hunting');
  $('hunt-panel').hidden = false;
  $('hunt-result').hidden = true;
  $('hunt-again').hidden = true;
}

function quitHunt() {
  hunt?.finish();
  hunt = null;
  huntEyes = false;
  document.body.classList.remove('hunting');
  $('hunt-panel').hidden = true;
  setWalking(false);
  setSystem('trashHunt', false);
}

function showHunt() {
  if (!hunt) return;
  const left = Math.ceil(hunt.timeLeft);
  $('hunt-clock').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  $('hunt-board').replaceChildren(
    ...hunt.standings.map((p) => {
      const row = document.createElement('li');
      if (p.isYou) row.className = 'you';
      const name = document.createElement('span');
      name.textContent = p.name;
      const score = document.createElement('span');
      score.textContent = String(p.score);
      row.append(name, score);
      return row;
    }),
  );
  const last = hunt.last ? `+${hunt.last.points} ${hunt.last.kind === 'treasure' ? 'gold!' : hunt.last.kind}. ` : '';
  const combo = hunt.combo > 1 ? `Streak x${hunt.combo}.` : '';
  $('hunt-combo').textContent = hunt.inReach() ? 'Press E to pick it up' : `${last}${combo}`;
  const hint = { hot: 'Gold nearby: hot', warm: 'Gold nearby: warm', cold: 'Gold nearby: cold', gone: 'All the gold is gone' };
  $('hunt-treasure').textContent = hint[hunt.treasureHint()];
  if (hunt.over && $('hunt-again').hidden) {
    const you = hunt.players[0].score;
    const best = readBest();
    if (you > best) saveBest(you);
    const place = ['1st', '2nd', '3rd', '4th'][hunt.place - 1];
    $('hunt-result').textContent = `Time! You came ${place} with ${you} points and ${hunt.picked} items. ${you > best ? 'New best score.' : `Your best is ${best}.`}`;
    $('hunt-result').hidden = false;
    $('hunt-again').hidden = false;
  }
}
setInterval(showHunt, 200);
$('hunt-start').addEventListener('click', () => setSystem('trashHunt', true));
$('hunt-again').addEventListener('click', startHunt);
$('hunt-quit').addEventListener('click', quitHunt);

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
  readWalkKeys();
  world.tick(dt * timeScale);
  hunt?.tick(dt);
  if (highwayOn) highway?.tick(dt * timeScale);
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

if (params.get('time')) setSystem('timeOfDay', params.get('time')!);
if (params.get('gfx')) setSystem('graphics', Number(params.get('gfx')));

// For scripted test runs.
Object.assign(window, { carmacar: { world, scene, hero, readings, getTwin: () => twin, toggleStallCar, highwayDemo, setHighway, rampReadings, graphics } });
