// CarMaCar platform. Receives pixels and pose, keeps a live parking map, runs trip agents.
// It imports nothing from the sim. Its only contact with the sim is this HTTP API.
import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import {
  distance,
  generateCity,
  type FindParkingRequest,
  type FindParkingResponse,
  type FrameUpload,
  type OperatorRequest,
  type RouteReply,
  type RouteRequest,
  type TelemetryReply,
  type TelemetryUpload,
  type TesSettings,
  type TripPlan,
  type TripRequest,
} from '@carmacar/shared';
import Fastify from 'fastify';
import OpenAI from 'openai';
import { runTripAgent } from './agent';
import { runOperator } from './operator';
import { Twin } from './twin';
import { SamProvider } from './vision/sam';
import { analyzeFrame, isUsableFrame } from './vision/stalls';
import type { VisionProvider } from './vision/provider';

const PORT = Number(process.env.PORT ?? 8787);
const AGENT_MODEL = process.env.AGENT_MODEL ?? 'muse-spark-1.3-contributor';
const FRAME_LIMIT = Number(process.env.FRAME_LIMIT_PER_SESSION ?? 1200);
const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD ?? 15);
const MAX_INFLIGHT_PER_SESSION = 6;
const MAX_SESSIONS = 40;
const SESSION_IDLE_MS = 20 * 60_000;
const SAM_USD_PER_FRAME = 0.0025;
const AGENT_USD_PER_TOKEN = 0.2 / 1_000_000;

if (!process.env.MODEL_API_KEY) throw new Error('MODEL_API_KEY is not set.');

const client = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY });
const vision: VisionProvider = new SamProvider(client);
const city = generateCity();
const nodeById = new Map(city.nodes.map((n) => [n.id, n]));
const roadSegments = city.segments.map((s) => ({
  id: s.id,
  start: nodeById.get(s.a)!,
  dir: s.dir,
  length: s.length,
  halfWidth: city.roadHalfWidth - 2.2, // Driving lanes only, not the parking lane.
}));

const sessions = new Map<string, Twin>();
const inflight = new Map<string, number>();

// Public links spend real money, so everything counts against one daily ceiling.
let spendDay = new Date().toDateString();
let spentUsd = 0;
function addSpend(usd: number) {
  const today = new Date().toDateString();
  if (today !== spendDay) {
    spendDay = today;
    spentUsd = 0;
  }
  spentUsd += usd;
}
const budgetExhausted = () => new Date().toDateString() === spendDay && spentUsd >= DAILY_BUDGET_USD;

function getTwin(id: string): Twin | undefined {
  const twin = sessions.get(id);
  if (twin) twin.lastSeen = Date.now();
  return twin;
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, twin] of sessions) {
    if (twin.lastSeen < cutoff) sessions.delete(id);
  }
}, 60_000).unref();

const app = Fastify({ bodyLimit: 3 * 1024 * 1024, logger: { level: 'warn' } });
await app.register(cors, { origin: process.env.ALLOWED_ORIGIN ?? true });

app.get('/health', async () => ({ ok: true, sessions: sessions.size, model: vision.model }));

app.post('/v1/sessions', async (_req, reply) => {
  if (sessions.size >= MAX_SESSIONS) return reply.code(503).send({ error: 'Too many live sessions. Try again soon.' });
  const id = randomUUID();
  sessions.set(id, new Twin(city));
  return { sessionId: id };
});

app.post<{ Params: { id: string }; Body: FrameUpload }>('/v1/sessions/:id/frames', async (req, reply) => {
  const twin = getTwin(req.params.id);
  if (!twin) return reply.code(404).send({ error: 'Unknown session' });
  if (budgetExhausted()) return reply.code(429).send({ error: 'Daily budget reached' });
  if (twin.frameCount >= FRAME_LIMIT) return reply.code(429).send({ error: 'Session frame limit reached' });
  const busy = inflight.get(req.params.id) ?? 0;
  if (busy >= MAX_INFLIGHT_PER_SESSION) return reply.code(429).send({ error: 'Too many frames in flight' });

  const { jpeg, pose, scoutId, capturedAt } = req.body;
  const pixels = Buffer.from(jpeg, 'base64');
  // Never let a broken camera report a street as empty. That would send drivers to taken stalls.
  if (!isUsableFrame(pixels, pose.width, pose.height)) return reply.code(422).send({ error: 'Frame looks blank' });
  inflight.set(req.params.id, busy + 1);
  twin.frameCount++;
  addSpend(SAM_USD_PER_FRAME);

  const started = Date.now();
  try {
    // The frame lives only in this buffer and is gone when the request ends. It is never stored.
    const masks = await vision.findVehicles(pixels);
    const { observations, assignments, roadVehicles } = analyzeFrame(masks, pose, city.stalls, roadSegments);
    for (const [segmentId, count] of roadVehicles) {
      twin.tes.reportCameraCount(segmentId, count, Date.now() / 1000);
      twin.cameraTrafficCounts += count;
    }
    const changes = twin.observe(observations, Date.now());
    twin.addFrame({
      frameId: randomUUID(),
      scoutId,
      capturedAt,
      latencyMs: Date.now() - started,
      model: vision.model,
      detections: masks.map((m) => ({
        objectId: m.objectId,
        box: m.box,
        maskPath: m.svgPath,
        maskWidth: m.width,
        maskHeight: m.height,
        stallId: assignments.get(m.objectId) ?? null,
      })),
      stalls: observations.map((o) => ({ id: o.stallId, state: o.state })),
    });
    twin.karma.set(scoutId, (twin.karma.get(scoutId) ?? 0) + observations.length);

    // A camera confirmed a parked holder, so their reservation has done its job.
    for (const o of observations) {
      const holder = twin.stall(o.stallId)?.reservedBy;
      if (o.state === 'occupied' && holder && twin.hasArrived(holder)) twin.release(holder);
    }
    // A camera just showed a reserved stall is taken by someone else: move that driver.
    for (const change of changes) {
      if (change.to !== 'occupied') continue;
      const holder = twin.stall(change.stallId)?.reservedBy;
      if (holder) rerouteCar(twin, holder, change.stallId);
    }
    return reply.code(200).send({ stalls: observations.length, vehicles: masks.length });
  } catch (err) {
    req.log.warn(err);
    return reply.code(502).send({ error: 'Vision failed' });
  } finally {
    inflight.set(req.params.id, (inflight.get(req.params.id) ?? 1) - 1);
  }
});

function rerouteCar(twin: Twin, carId: string, takenStallId: string) {
  const trip = [...twin.trips.values()].find((t) => t.carId === carId && t.legs[0]?.stallId === takenStallId);
  if (!trip) {
    // Bulk drivers have no trip object; the sim sees the reservation vanish and asks again.
    twin.release(carId);
    return;
  }
  const leg = trip.legs[0];
  const destination = city.destinations.find((d) => d.id === leg.destinationId)!;
  twin.addEvent({ tripId: trip.tripId, kind: 'tool_result', name: 'twin_update', detail: `Camera shows ${takenStallId} is now taken.` });
  twin.addEvent({ tripId: trip.tripId, kind: 'tool_call', name: 'find_parking', detail: JSON.stringify({ destination_id: leg.destinationId, exclude_stall_ids: [takenStallId] }) });
  const found = twin.findParking(destination, [takenStallId]);
  if (found && twin.reserve(found.stall.id, carId)) {
    leg.stallId = found.stall.id;
    trip.reply = `${takenStallId} just got taken, so I moved you to ${found.stall.id}, a ${found.walkMeters} m walk from ${destination.name}.`;
    twin.addEvent({ tripId: trip.tripId, kind: 'tool_call', name: 'reserve_stall', detail: JSON.stringify({ stall_id: found.stall.id }) });
    twin.addEvent({ tripId: trip.tripId, kind: 'reply', detail: trip.reply });
  } else {
    twin.release(carId);
    leg.stallId = null;
    trip.reply = `${takenStallId} just got taken and nothing else nearby is free yet. Keep heading to ${destination.name}.`;
    twin.addEvent({ tripId: trip.tripId, kind: 'reply', detail: trip.reply });
  }
}

app.get<{ Params: { id: string } }>('/v1/sessions/:id/twin', async (req, reply) => {
  const twin = getTwin(req.params.id);
  if (!twin) return reply.code(404).send({ error: 'Unknown session' });
  return twin.snapshot(FRAME_LIMIT, budgetExhausted());
});

app.post<{ Params: { id: string }; Body: FindParkingRequest }>('/v1/sessions/:id/parking/find', async (req, reply) => {
  const twin = getTwin(req.params.id);
  if (!twin) return reply.code(404).send({ error: 'Unknown session' });
  const destination = city.destinations.find((d) => d.id === req.body.destinationId);
  if (!destination) return reply.code(400).send({ error: 'Unknown destination' });
  const exclude = req.body.exclude ?? [];
  // With the Traffic Efficiency System on, the choice weighs traffic on the way as well as the walk.
  const chosen =
    twin.tesEnabled && req.body.edge
      ? twin.tes.chooseStall(req.body.edge, destination, (s) => twin.available(s, exclude), Date.now() / 1000)
      : null;
  const found = chosen
    ? { stall: chosen, walkMeters: Math.round(distance(chosen.center, destination)) }
    : twin.findParking(destination, exclude);
  const response: FindParkingResponse = { stallId: null, walkMeters: null };
  if (found && twin.reserve(found.stall.id, req.body.carId)) {
    response.stallId = found.stall.id;
    response.walkMeters = found.walkMeters;
  }
  return response;
});

app.post<{ Params: { id: string }; Body: { carId: string } }>('/v1/sessions/:id/parking/release', async (req, reply) => {
  const twin = getTwin(req.params.id);
  if (!twin) return reply.code(404).send({ error: 'Unknown session' });
  twin.release(req.body.carId);
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: { carId: string } }>('/v1/sessions/:id/parking/arrived', async (req, reply) => {
  const twin = getTwin(req.params.id);
  if (!twin) return reply.code(404).send({ error: 'Unknown session' });
  twin.markArrived(req.body.carId);
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: TripRequest }>('/v1/sessions/:id/trips', async (req, reply) => {
  const twin = getTwin(req.params.id);
  if (!twin) return reply.code(404).send({ error: 'Unknown session' });
  if (budgetExhausted()) return reply.code(429).send({ error: 'Daily budget reached' });
  const { carId, text, position } = req.body;
  if (!text?.trim() || text.length > 400) return reply.code(400).send({ error: 'Trip request must be 1 to 400 characters' });

  const existing = [...twin.trips.values()].find((t) => t.carId === carId);
  const trip: TripPlan = existing ?? { tripId: randomUUID(), carId, reply: '', legs: [], status: 'planning' };
  trip.status = 'planning';
  twin.trips.set(trip.tripId, trip);
  void runTripAgent(text, {
    client,
    model: AGENT_MODEL,
    city,
    twin,
    trip,
    position,
    onTokens: (tokens) => addSpend(tokens * AGENT_USD_PER_TOKEN),
  });
  return { tripId: trip.tripId };
});

app.post<{ Params: { id: string }; Body: TelemetryUpload }>('/v1/sessions/:id/telemetry', async (req, reply) => {
  const twin = getTwin(req.params.id);
  if (!twin) return reply.code(404).send({ error: 'Unknown session' });
  const now = Date.now() / 1000;
  for (const vehicle of req.body.vehicles) twin.tes.reportVehicle(vehicle, now);
  const signals: TelemetryReply['signals'] = {};
  if (twin.tesEnabled && twin.smartLights) {
    const nodes = twin.graph.city.nodes.map((n) => n.id).filter((id) => twin.graph.next(id).length >= 3);
    for (const [node, axis] of twin.tes.signalPlan(nodes, now)) signals[node] = axis;
  }
  return { signals } satisfies TelemetryReply;
});

app.post<{ Params: { id: string }; Body: RouteRequest }>('/v1/sessions/:id/route', async (req, reply) => {
  const twin = getTwin(req.params.id);
  if (!twin) return reply.code(404).send({ error: 'Unknown session' });
  if (!twin.tesEnabled) return { chain: null } satisfies RouteReply;
  const { carId, from, goal } = req.body;
  return { chain: twin.tes.planRoute(carId, from, goal, Date.now() / 1000) } satisfies RouteReply;
});

app.post<{ Params: { id: string }; Body: TesSettings }>('/v1/sessions/:id/tes', async (req, reply) => {
  const twin = getTwin(req.params.id);
  if (!twin) return reply.code(404).send({ error: 'Unknown session' });
  twin.tesEnabled = req.body.enabled;
  twin.smartLights = req.body.smartLights;
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: OperatorRequest }>('/v1/sessions/:id/operator', async (req, reply) => {
  const twin = getTwin(req.params.id);
  if (!twin) return reply.code(404).send({ error: 'Unknown session' });
  if (budgetExhausted()) return reply.code(429).send({ error: 'Daily budget reached' });
  const text = req.body.text?.trim();
  if (!text || text.length > 400) return reply.code(400).send({ error: 'Request must be 1 to 400 characters' });
  void runOperator(text, { client, model: AGENT_MODEL, city, twin, onTokens: (tokens) => addSpend(tokens * AGENT_USD_PER_TOKEN) });
  return { ok: true };
});

app.addHook('onClose', async () => sessions.clear());

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`platform on :${PORT} (${city.stalls.length} stalls, ${vision.model}, agent ${AGENT_MODEL}, ${distance(city.nodes[0], city.nodes[1]).toFixed(0)} m grid)`);
