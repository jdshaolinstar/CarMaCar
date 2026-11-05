// Muse builds a city: one plain request becomes a playable 3D city from real map data.
// Run from the repo root: node --env-file=.env --import tsx apps/metro/scripts/muse-build-city.ts "<request>" <id> [columns] [rows]
//
// Muse decides where and how much: the study area and which regional map file covers it. Everything after
// that is ordinary code reading real data, so a wrong answer fails a check or finds no streets. It can't
// invent a road. Needs Python with osmium for the map extract.
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import OpenAI from 'openai';

const MODEL = process.env.AGENT_MODEL ?? 'muse-spark-1.3-contributor';
const REGION_HOST = 'https://download.geofabrik.de';
/** Enough to fill a screen with city, small enough to run in a browser. In degrees. */
const MAX_BOX = 0.08;
const MIN_BOX = 0.01;
const USER_AGENT = 'carmacar-metro-study/0.1';

const [request, id] = [process.argv[2], process.argv[3]];
const columns = process.argv[4] ?? '4';
const rows = process.argv[5] ?? '3';
if (!request || !/^[a-z0-9-]+$/.test(id ?? '')) throw new Error('Usage: muse-build-city.ts "<request>" <lowercase-id> [columns] [rows]');

const data = new URL('../data/', import.meta.url);
const path = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'south', 'west', 'north', 'east', 'region', 'reasoning'],
  properties: {
    name: { type: 'string', description: 'Short name of the area.' },
    south: { type: 'number' },
    west: { type: 'number' },
    north: { type: 'number' },
    east: { type: 'number' },
    region: { type: 'string', description: 'Geofabrik extract path, smallest that covers the area, such as north-america/us/illinois or europe/germany/berlin. No domain and no file extension.' },
    reasoning: { type: 'string', description: 'One sentence on why this area suits a traffic and parking demo.' },
  },
};

const client = new OpenAI({ apiKey: process.env.MODEL_API_KEY, baseURL: 'https://api.meta.ai/v1' });
const started = Date.now();
const response = await client.chat.completions.create({
  model: MODEL,
  messages: [
    {
      role: 'system',
      content:
        'You build real places for a 3D traffic simulator. Given a request, choose a central area of the city in decimal degrees, about 3 to 5 km across, centered on its busiest streets. Prefer an area with a regular street grid and a theater. Also give the Geofabrik extract path for the smallest region that covers it.',
    },
    { role: 'user', content: request },
  ],
  response_format: { type: 'json_schema', json_schema: { name: 'city_area', strict: true, schema: SCHEMA } },
} as never);
const area = JSON.parse((response as any).choices[0].message.content ?? '{}');
const tokens = (response as any).usage?.total_tokens ?? 0;
console.log(`Muse chose ${area.name}: ${area.reasoning}`);
console.log(`Box ${area.south}, ${area.west} to ${area.north}, ${area.east}. Region ${area.region}. ${tokens} tokens.`);

const height = area.north - area.south;
const width = area.east - area.west;
if (!(height >= MIN_BOX && height <= MAX_BOX && width >= MIN_BOX && width <= MAX_BOX)) throw new Error(`Rejected area of ${height} by ${width} degrees.`);
if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(area.region)) throw new Error(`Rejected region ${area.region}`);

// The regional file, downloaded once.
mkdirSync(new URL('regions/', data), { recursive: true });
const region = new URL(`regions/${area.region.replaceAll('/', '-')}.osm.pbf`, data);
if (!existsSync(region)) {
  const url = `${REGION_HOST}/${area.region}-latest.osm.pbf`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`No regional file at ${url} (${res.status})`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(region));
}

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`${command} failed`);
};
const block = new URL(`${id}-block.json`, data);
const script = (name: string) => path(new URL(name, import.meta.url));
run('python', [script('pbf-block.py'), path(region), path(block), ...[area.south, area.west, area.north, area.east].map(String)]);
const city = new URL(`../../sim/public/cities/${id}.json`, import.meta.url);
run(process.execPath, ['--import', 'tsx', script('real-block.ts'), path(block), path(city), columns, rows]);

writeFileSync(
  new URL(`../../sim/public/cities/${id}.place.json`, import.meta.url),
  JSON.stringify({ id, name: area.name, request, box: [area.south, area.west, area.north, area.east], region: area.region, reasoning: area.reasoning, model: MODEL, tokens, seconds: Math.round((Date.now() - started) / 1000) }, null, 1),
);
console.log(`Built ${area.name} in ${Math.round((Date.now() - started) / 1000)} s. Open ?place=${id}&gfx=5`);
