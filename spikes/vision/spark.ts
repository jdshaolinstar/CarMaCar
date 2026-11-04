// Router test: Muse Spark vision instead of SAM, with schema-locked output.
// Stalls are drawn and labelled on the frame, so the model answers about known ids only.
//   npx tsx --env-file=../../.env spark.ts <prefix> <runName> [model]
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import OpenAI from 'openai';
import sharp from 'sharp';

type V3 = [number, number, number];
interface Pose { position: V3; target: V3; up: V3; fovY: number; width: number; height: number }
interface Stall { id: string; x1: number; x2: number; z1: number; z2: number }

const MAX_RANGE = 26;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

function projector(p: Pose) {
  const f = norm(sub(p.target, p.position));
  const r = norm(cross(p.up, f));
  const u = cross(f, r);
  const focal = p.height / 2 / Math.tan(p.fovY / 2);
  return (w: V3): [number, number] | null => {
    const d = sub(w, p.position);
    const zc = dot(d, f);
    if (zc < 0.5) return null;
    return [p.width / 2 + (focal * dot(d, r)) / zc, p.height / 2 - (focal * dot(d, u)) / zc];
  };
}

const prefix = process.argv[2];
const runName = process.argv[3];
const model = process.argv[4] ?? 'muse-spark-1.3';
const client = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY });
const { stalls } = JSON.parse(await readFile('map.json', 'utf8')) as { stalls: Stall[] };
const files = (await readdir('frames')).filter((f) => f.endsWith('.jpg') && f.startsWith(prefix)).sort();
await mkdir('annotated', { recursive: true });

async function analyzeFrame(file: string) {
  const id = file.replace('.jpg', '');
  const pose: Pose = JSON.parse(await readFile(`frames/${id}.json`, 'utf8'));
  const project = projector(pose);

  const visible: { stall: Stall; dist: number; pts: [number, number][] }[] = [];
  for (const s of stalls) {
    const dist = Math.hypot((s.x1 + s.x2) / 2 - pose.position[0], (s.z1 + s.z2) / 2 - pose.position[2]);
    if (dist > MAX_RANGE) continue;
    const pts = ([[s.x1, s.z1], [s.x2, s.z1], [s.x2, s.z2], [s.x1, s.z2]] as [number, number][]).map(([x, z]) => project([x, 0, z]));
    if (pts.some((q) => !q || q[0] < 0 || q[0] >= pose.width || q[1] < 0 || q[1] >= pose.height)) continue;
    visible.push({ stall: s, dist, pts: pts as [number, number][] });
  }
  if (visible.length === 0) return { id, ms: 0, tokens: 0, answers: [] as any[], visible };

  const shapes = visible.map(({ stall, pts }) => {
    const cx = pts.reduce((t, q) => t + q[0], 0) / 4;
    const bottom = Math.max(...pts.map((q) => q[1]));
    return `<polygon points="${pts.map((q) => q.join(',')).join(' ')}" fill="none" stroke="#ff00ff" stroke-width="3"/>
      <text x="${cx}" y="${Math.min(bottom + 24, pose.height - 6)}" font-family="Arial" font-size="22" font-weight="700" fill="#ff00ff" stroke="#000" stroke-width="0.8" text-anchor="middle">${stall.id}</text>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pose.width}" height="${pose.height}">${shapes.join('')}</svg>`;
  const annotated = await sharp(`frames/${file}`).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 85 }).toBuffer();
  await writeFile(`annotated/${id}.jpg`, annotated);

  const ids = visible.map((v) => v.stall.id);
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['stalls'],
    properties: {
      stalls: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'state'],
          properties: { id: { type: 'string', enum: ids }, state: { type: 'string', enum: ['occupied', 'free', 'unclear'] } },
        },
      },
    },
  };

  const t0 = Date.now();
  const res = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `Street-parking camera frame from a simulation. Magenta outlines mark parking stalls on the ground, labelled ${ids.join(', ')}. For each stall, report "occupied" if a vehicle is parked in that outline, "free" if the outline's ground is empty, or "unclear" if you cannot tell. A vehicle that only blocks the view of a stall behind it does not occupy that stall.` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${annotated.toString('base64')}` } },
      ],
    }],
    response_format: { type: 'json_schema', json_schema: { name: 'stall_states', strict: true, schema } },
  } as any);
  const ms = Date.now() - t0;
  const answers = JSON.parse(res.choices[0].message.content ?? '{"stalls":[]}').stalls;
  return { id, ms, tokens: res.usage?.total_tokens ?? 0, answers, visible };
}

const results: any[] = [];
for (let i = 0; i < files.length; i += 4) {
  results.push(...(await Promise.all(files.slice(i, i + 4).map(analyzeFrame))));
}

const votes: Record<string, { occupied: number; free: number }> = Object.fromEntries(stalls.map((s) => [s.id, { occupied: 0, free: 0 }]));
const perFrame: Record<string, any> = {};
for (const r of results) {
  const row: Record<string, any> = {};
  for (const a of r.answers) {
    row[a.id] = { state: a.state === 'unclear' ? 'unknown' : a.state };
    const v = r.visible.find((x: any) => x.stall.id === a.id);
    if (a.state !== 'unclear' && v) votes[a.id][a.state as 'occupied' | 'free'] += 1 / Math.max(v.dist, 8);
  }
  perFrame[r.id] = { ms: r.ms, tokens: r.tokens, stalls: row };
}
const twin = Object.fromEntries(stalls.map((s) => {
  const v = votes[s.id];
  const state = v.occupied === 0 && v.free === 0 ? 'unknown' : v.occupied >= v.free ? 'occupied' : 'free';
  return [s.id, { state, ...v }];
}));
await writeFile(`result-${runName}.json`, JSON.stringify({ model, twin, perFrame }, null, 1));
const tokens = results.reduce((t, r) => t + r.tokens, 0);
console.log(`${runName}: ${results.length} frames, ${tokens} tokens total`);
