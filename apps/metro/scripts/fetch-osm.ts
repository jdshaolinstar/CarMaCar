// Downloads a city's major roads from OpenStreetMap, through the Overpass API.
// Run: npx tsx apps/metro/scripts/fetch-osm.ts <city>
// Road data is (c) OpenStreetMap contributors, under the Open Database License. Raw downloads stay out of git.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { CITIES } from '../src/cities';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const MAX_ROUNDS = 5;
const ROAD_CLASSES = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link';

const id = process.argv[2] ?? 'la';
const city = CITIES[id];
if (!city) throw new Error(`Unknown city ${id}. Known: ${Object.keys(CITIES).join(', ')}`);

const [south, west, north, east] = city.bbox;
const query = `[out:json][timeout:600][maxsize:1073741824];
way["highway"~"^(${ROAD_CLASSES})$"](${south},${west},${north},${east});
(._;>;);
out body;`;

const dir = new URL('../data/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`${id}-osm.json`, dir);
if (existsSync(file) && statSync(file).size > 1000) {
  console.log(`Already have ${file.pathname}. Delete it to download again.`);
  process.exit(0);
}

console.log(`Requesting ${city.name} roads from Overpass...`);
const started = Date.now();

/** Tries each server in turn, waiting longer each round, as Overpass asks clients to. */
async function download() {
  for (let round = 0, wait = 20; round < MAX_ROUNDS; round++, wait *= 2) {
    for (const endpoint of ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'carmacar-metro-study/0.1' },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (response.ok) return await response.text();
        console.log(`${endpoint} replied ${response.status}`);
      } catch (err) {
        console.log(`${endpoint} failed: ${(err as Error).message}`);
      }
    }
    console.log(`Waiting ${wait} s before trying again`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
  throw new Error('Every Overpass server was busy');
}

const text = await download();
writeFileSync(file, text);
console.log(`Saved ${(text.length / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s`);
