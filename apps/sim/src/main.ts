// Wires the simulated city to the platform. Truth stays here; only pixels and pose are sent.
import { distance, dot, generateCity, rightOf, scale, type AgentEvent, type CameraPose, type TripPlan, type TwinSnapshot, type Vec2 } from '@carmacar/shared';
import { LiveMap } from './map';
import { PlatformClient } from './platform';
import { CityScene } from './scene';
import { World, type Car, CAR_COLORS } from './world';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 11);
const scouts = Number(params.get('scouts') ?? 5);
const drivers = Number(params.get('drivers') ?? 30);
const networkShare = Number(params.get('network') ?? 0.7);
const framesPerSecond = Number(params.get('fps') ?? 1);
const parkedShare = Number(params.get('parked') ?? 0.62);
const timeScale = Number(params.get('speed') ?? 1);

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
  if (!platform || inFlight >= 3 || frameLimitHit) return;
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
    if (plan.status !== 'ready' || plan.carId !== hero.id) continue;
    const signature = planSignature(plan);
    if (appliedPlans.get(plan.tripId) === signature) continue;
    appliedPlans.set(plan.tripId, signature);
    world.applyPlan(hero, plan);
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
  if (!placing) return;
  const id = map.stallAt(e.clientX, e.clientY);
  if (id) toggleStallCar(id);
});

$('city').addEventListener('pointerup', (e) => {
  if (!placing) return;
  const id = scene.pickStall(e.offsetX, e.offsetY);
  if (id) toggleStallCar(id);
});

const setView = (driver: boolean) => {
  scene.follow(driver ? hero.id : null);
  $('view-city').setAttribute('aria-pressed', String(!driver));
  $('view-driver').setAttribute('aria-pressed', String(driver));
};
$('view-city').addEventListener('click', () => setView(false));
$('view-driver').addEventListener('click', () => setView(true));

$('trip').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('trip-text') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !platform) return;
  input.value = '';
  const id = await platform.requestTrip({ carId: hero.id, text, position: hero.pos });
  if (!id) showStatus('The trip agent did not accept that request. Try again.');
});

scene.start((dt) => {
  world.tick(dt * timeScale);
  map.draw(twin, world, highlight);
});

setInterval(() => void takePhoto(), 1000 / framesPerSecond);
setInterval(() => void pollTwin(), 700);

// For scripted test runs.
Object.assign(window, { carmacar: { world, scene, hero, readings, getTwin: () => twin, toggleStallCar } });
