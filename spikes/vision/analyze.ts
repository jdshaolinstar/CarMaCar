// Vision spike analyzer. Inputs: frames + camera pose + static map. Never reads truth.json.
//   npx tsx --env-file=../../.env analyze.ts [frame-prefix]
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { decodeMaskToRaster, parseImageStream, recordsOfKind, type ResponsesEvent } from '@meta-sam/parser';
import OpenAI from 'openai';

type V3 = [number, number, number];
interface Pose { position: V3; target: V3; up: V3; fovY: number; width: number; height: number }
interface Stall { id: string; x1: number; x2: number; z1: number; z2: number }
type State = 'occupied' | 'free' | 'unknown';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

// Pinhole camera built only from the reported pose.
function camera(p: Pose) {
  const f = norm(sub(p.target, p.position));
  const r = norm(cross(p.up, f)); // Babylon is left-handed
  const u = cross(f, r);
  const focal = p.height / 2 / Math.tan(p.fovY / 2);
  return {
    project(w: V3): [number, number] | null {
      const d = sub(w, p.position);
      const zc = dot(d, f);
      if (zc < 0.5) return null;
      return [p.width / 2 + (focal * dot(d, r)) / zc, p.height / 2 - (focal * dot(d, u)) / zc];
    },
    // Ray through a pixel, intersected with the ground plane.
    toGround(px: number, py: number): [number, number] | null {
      const a = (px - p.width / 2) / focal;
      const b = (p.height / 2 - py) / focal;
      const dir: V3 = [
        r[0] * a + u[0] * b + f[0],
        r[1] * a + u[1] * b + f[1],
        r[2] * a + u[2] * b + f[2],
      ];
      if (dir[1] >= -1e-4) return null;
      const t = -p.position[1] / dir[1];
      return [p.position[0] + dir[0] * t, p.position[2] + dir[2] * t];
    },
  };
}

// The API omits output_text.done, which the parser needs. Same fix as Meta's cookbook.
async function* normalized(stream: AsyncIterable<any>): AsyncGenerator<ResponsesEvent> {
  const done = new Set<string>();
  for await (const e of stream) {
    const lane = `${e.item_id}:${e.output_index}:${e.content_index}`;
    if (e.type === 'response.output_text.done') {
      if (!done.has(lane)) { done.add(lane); yield e; }
      continue;
    }
    yield e;
    if (e.type === 'response.content_part.done' && !done.has(lane) && e.part?.type === 'output_text') {
      done.add(lane);
      yield { type: 'response.output_text.done', item_id: e.item_id, output_index: e.output_index, content_index: e.content_index, text: e.part.text } as ResponsesEvent;
    }
  }
}

const MAX_RANGE = 26;
const client = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY });

// Cache by frame + concept so tuning the geometry does not re-bill SAM.
async function segment(jpeg: Buffer, concept: string, frameId: string) {
  const cachePath = `cache/${frameId}__${concept.replace(/\W+/g, '_')}.json`;
  try {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  } catch {}
  const result = await callSam(jpeg, concept);
  await mkdir('cache', { recursive: true });
  await writeFile(cachePath, JSON.stringify(result));
  return result;
}

async function callSam(jpeg: Buffer, concept: string) {
  const stream = await client.responses.create({
    model: 'sam-3.1',
    stream: true,
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: concept },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
      ],
    }],
  } as any);
  return parseImageStream(normalized(stream as any)).finalResult;
}

interface Detection {
  id: string;
  box: [number, number, number, number];
  area: number;
  ground: [number, number][]; // where the car touches the road, in world metres
  covered: (x: number, y: number) => boolean;
}

function detections(result: any, cam: ReturnType<typeof camera>): Detection[] {
  const boxes = new Map(recordsOfKind(result.records, 'box').map((b: any) => [b.objectId, b]));
  return recordsOfKind(result.records, 'mask').map((m: any) => {
    const b: any = boxes.get(m.objectId);
    const raster = decodeMaskToRaster(m.mask);
    const { width: W, height: H } = m.mask;
    const sx = (b.right - b.left) / W;
    const sy = (b.bottom - b.top) / H;
    const ground: [number, number][] = [];
    let area = 0;
    for (let col = 0; col < W; col++) {
      let lowest = -1;
      for (let row = 0; row < H; row++) {
        if (raster[row * W + col]) { lowest = row; area++; }
      }
      if (lowest >= 0) {
        const g = cam.toGround(b.left + (col + 0.5) * sx, b.top + (lowest + 1) * sy);
        if (g) ground.push(g);
      }
    }
    return {
      id: m.objectId,
      box: [b.left, b.top, b.right, b.bottom] as [number, number, number, number],
      area,
      ground,
      covered(x: number, y: number) {
        if (x < b.left || x >= b.right || y < b.top || y >= b.bottom) return false;
        const col = Math.floor((x - b.left) / sx);
        const row = Math.floor((y - b.top) / sy);
        return raster[row * W + col] === 1;
      },
    };
  });
}

function bestStall(d: Detection, list: Stall[]): Stall | undefined {
  let best: Stall | undefined;
  let bestSpan = 0;
  for (const s of list) {
    const xs = d.ground
      .filter(([x, z]) => z > s.z1 - 1.2 && z < s.z2 + 0.6 && x > s.x1 && x < s.x2)
      .map(([x]) => x);
    const span = xs.length > 1 ? Math.max(...xs) - Math.min(...xs) : 0;
    if (span > bestSpan) { bestSpan = span; best = s; }
  }
  return best;
}

// Decide per stall from one frame.
function judge(stall: Stall, dets: Detection[], cam: ReturnType<typeof camera>, pose: Pose, allStalls: Stall[]) {
  // Trust only nearby stalls: far away, one pixel of error is metres on the ground.
  const cx = (stall.x1 + stall.x2) / 2;
  const cz = (stall.z1 + stall.z2) / 2;
  const dist = Math.hypot(cx - pose.position[0], cz - pose.position[2]);
  if (dist > MAX_RANGE) return { state: 'unknown' as State, contact: 0, inFrame: 0, visible: 0, dist, weight: 0 };

  // A: does any car's road-contact line sit inside this stall?
  const len = stall.x2 - stall.x1;
  let contact = 0;
  // One car, one stall: a detection only counts for the stall it overlaps most.
  for (const d of dets.filter((x) => bestStall(x, allStalls)?.id === stall.id)) {
    const xs = d.ground
      .filter(([x, z]) => z > stall.z1 - 1.2 && z < stall.z2 + 0.6 && x > stall.x1 && x < stall.x2)
      .map(([x]) => x);
    if (xs.length > 1) contact = Math.max(contact, (Math.max(...xs) - Math.min(...xs)) / len);
  }

  // B: can we actually see this stall's ground, or is it hidden or off camera?
  let inFrame = 0, visible = 0, samples = 0;
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 3; j++) {
      const x = stall.x1 + ((i + 0.5) / 7) * (stall.x2 - stall.x1);
      const z = stall.z1 + ((j + 0.5) / 3) * (stall.z2 - stall.z1);
      samples++;
      const px = cam.project([x, 0, z]);
      if (!px || px[0] < 0 || px[0] >= pose.width || px[1] < 0 || px[1] >= pose.height) continue;
      inFrame++;
      if (!dets.some((d) => d.covered(px[0], px[1]))) visible++;
    }
  }
  const inFrameRatio = inFrame / samples;
  const visibleRatio = visible / samples;

  // "Free" sends a driver somewhere, so it needs the whole stall in view.
  // A stall cut off by the frame edge can hide a car SAM failed to see.
  let state: State = 'unknown';
  if (contact >= 0.3) state = 'occupied';
  else if (inFrameRatio >= 0.95 && visibleRatio >= 0.6) state = 'free';
  return {
    state,
    contact: +contact.toFixed(2),
    inFrame: +inFrameRatio.toFixed(2),
    visible: +visibleRatio.toFixed(2),
    dist: +dist.toFixed(1),
    weight: 1 / Math.max(dist, 8), // closer frames count for more
  };
}

const prefix = process.argv[2] ?? '';
const concept = process.argv[3] ?? 'car';
const map = JSON.parse(await readFile('map.json', 'utf8'));
const stalls: Stall[] = map.stalls;
const files = (await readdir('frames')).filter((f) => f.endsWith('.jpg') && f.startsWith(prefix)).sort();

const perFrame: Record<string, any> = {};
const votes: Record<string, { occupied: number; free: number }> = Object.fromEntries(stalls.map((s) => [s.id, { occupied: 0, free: 0 }]));

for (const file of files) {
  const id = file.replace('.jpg', '');
  const pose: Pose = JSON.parse(await readFile(`frames/${id}.json`, 'utf8'));
  const cam = camera(pose);
  const t0 = Date.now();
  const result = await segment(await readFile(`frames/${file}`), concept, id);
  const ms = Date.now() - t0;
  const dets = detections(result, cam);
  const row: Record<string, any> = {};
  for (const s of stalls) {
    const v = judge(s, dets, cam, pose, stalls);
    row[s.id] = v;
    if (v.state === 'occupied') votes[s.id].occupied += v.weight;
    if (v.state === 'free') votes[s.id].free += v.weight;
  }
  perFrame[id] = { ms, outcome: result.outcome.status, boxes: dets.map((d) => ({ id: d.id, box: d.box, area: d.area })), stalls: row };
  const line = stalls.map((s) => `${s.id}:${row[s.id].state[0]}`).join(' ');
  console.log(`${id.padEnd(9)} ${String(ms).padStart(6)}ms objs=${String(dets.length).padStart(2)}  ${line}`);
}

const twin = Object.fromEntries(
  stalls.map((s) => {
    const v = votes[s.id];
    const state: State = v.occupied === 0 && v.free === 0 ? 'unknown' : v.occupied >= v.free ? 'occupied' : 'free';
    return [s.id, { state, ...v }];
  }),
);
await writeFile(`result-${prefix || 'all'}.json`, JSON.stringify({ concept, twin, perFrame }, null, 1));
console.log('\nTWIN', Object.entries(twin).map(([k, v]) => `${k}=${v.state}(${v.occupied.toFixed(2)}/${v.free.toFixed(2)})`).join(' '));
