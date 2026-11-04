// Muse function: turns a plain description of a place into a study area the metro code can build.
// Run from the repo root: npx tsx --env-file=.env apps/metro/scripts/muse-city.ts "<place>" <id>
// Muse only picks the area. Reading the roads and building the network is ordinary code, so a wrong
// answer shows up here as a rejected box or a tiny network, never as an invented road.
import { mkdirSync, writeFileSync } from 'node:fs';
import OpenAI from 'openai';

const MODEL = process.env.AGENT_MODEL ?? 'muse-spark-1.3-contributor';
const place = process.argv[2];
const id = process.argv[3];
if (!place || !id) throw new Error('Usage: muse-city.ts "<place>" <id>');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'south', 'west', 'north', 'east', 'reasoning'],
  properties: {
    name: { type: 'string', description: 'Short name of the study area.' },
    south: { type: 'number' },
    west: { type: 'number' },
    north: { type: 'number' },
    east: { type: 'number' },
    reasoning: { type: 'string', description: 'One sentence on why these edges cover the commute area.' },
  },
};

const client = new OpenAI({ apiKey: process.env.MODEL_API_KEY, baseURL: 'https://api.meta.ai/v1' });
const response = await client.chat.completions.create({
  model: MODEL,
  messages: [
    { role: 'system', content: 'You prepare traffic studies. Given a place, return the bounding box in decimal degrees that covers its urban area and main commuter roads, without large empty regions.' },
    { role: 'user', content: place },
  ],
  response_format: { type: 'json_schema', json_schema: { name: 'study_area', strict: true, schema: SCHEMA } },
} as never);

const area = JSON.parse((response as any).choices[0].message.content ?? '{}');
const height = area.north - area.south;
const width = area.east - area.west;
if (!(height > 0.02 && height < 2 && width > 0.02 && width < 2)) throw new Error(`Rejected box: ${JSON.stringify(area)}`);

const out = new URL('../data/cities/', import.meta.url);
mkdirSync(out, { recursive: true });
const city = { id, name: area.name, bbox: [area.south, area.west, area.north, area.east], reasoning: area.reasoning };
writeFileSync(new URL(`${id}.json`, out), JSON.stringify(city, null, 1));
console.log(JSON.stringify(city));
console.log(`tokens ${(response as any).usage?.total_tokens ?? 0}`);
