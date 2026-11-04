// Cities the metro study can run on. Adding one takes a bounding box: everything else is derived.

export interface MetroCity {
  id: string;
  name: string;
  /** south, west, north, east */
  bbox: [number, number, number, number];
}

export const CITIES: Record<string, MetroCity> = {
  la: { id: 'la', name: 'Los Angeles basin', bbox: [33.7, -118.67, 34.32, -117.75] },
  sf: { id: 'sf', name: 'San Francisco', bbox: [37.7, -122.52, 37.83, -122.35] },
};
