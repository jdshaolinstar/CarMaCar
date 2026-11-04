// Builds the city's cached network and commute files, so later runs start quickly.
// Run: npx tsx apps/metro/scripts/build-cache.ts [city]
import { loadCity } from '../src/load';

const started = Date.now();
const { network, grid, matrix } = await loadCity(process.argv[2] ?? 'la');
console.log(`built in ${Math.round((Date.now() - started) / 1000)} s: ${network.edgeCount} roads, ${grid.count} zones, ${matrix.total} workers`);
