// Loads a city's network and commuter flows, caching the slow parts between runs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { buildZones, readCommutes, type OdMatrix, type ZoneGrid } from './demand';
import { buildNetwork, type Network, type OsmFile } from './network';

const data = (name: string) => new URL(`../data/${name}`, import.meta.url);
const path = (name: string) => decodeURIComponent(data(name).pathname).replace(/^\/([A-Za-z]:)/, '$1');

export function loadNetwork(id: string): Network {
  const cache = data(`${id}-network.bin`);
  if (existsSync(cache)) return deserialize(readFileSync(cache)) as Network;
  const network = buildNetwork(JSON.parse(readFileSync(data(`${id}-osm.json`), 'utf8')) as OsmFile);
  writeFileSync(cache, serialize(network));
  return network;
}

export async function loadCity(id: string): Promise<{ network: Network; grid: ZoneGrid; matrix: OdMatrix }> {
  const network = loadNetwork(id);
  const grid = buildZones(network);
  const cache = data(`${id}-od.bin`);
  if (existsSync(cache)) return { network, grid, matrix: deserialize(readFileSync(cache)) as OdMatrix };
  const matrix = await readCommutes(network, grid, path('ca_od_main_JT00_2023.csv.gz'), path('ca_xwalk.csv.gz'));
  writeFileSync(cache, serialize(matrix));
  return { network, grid, matrix };
}
