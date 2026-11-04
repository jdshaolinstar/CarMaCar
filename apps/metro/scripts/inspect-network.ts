// Builds a city's network and prints what is in it. Run: npx tsx apps/metro/scripts/inspect-network.ts la
import { readFileSync } from 'node:fs';
import { buildNetwork, describeNetwork, type OsmFile } from '../src/network';

const id = process.argv[2] ?? 'la';
const started = Date.now();
const osm = JSON.parse(readFileSync(new URL(`../data/${id}-osm.json`, import.meta.url), 'utf8')) as OsmFile;
const network = buildNetwork(osm);
console.log(`Built in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(JSON.stringify(describeNetwork(network), null, 1));
