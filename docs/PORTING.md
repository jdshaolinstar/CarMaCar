# Running CarMaCar in another city or 3D world

CarMaCar doesn't depend on this demo town. Anything that provides the right entities and a camera can run it, which is also what a real deployment needs: a surveyed map, and real cameras in place of rendered ones.

There are two things to replace.

## 1. The city: a data file

Everything the platform and simulator know about a place is one plain `CityMap` object, defined in `packages/shared/src/city.ts`. It holds no occupancy. It's the surveyed layer only.

| Entity | What it describes |
|---|---|
| `nodes` | Intersections, with positions in metres |
| `segments` | Streets between nodes, with names for directions |
| `stalls` | Each parking space: center, direction, size, and garage and level if indoors |
| `garages` | Door, transporter pad, levels, and fixed cameras |
| `destinations` | Named places drivers can go |
| `sidewalks` | Walking loops for pedestrians |

Export the demo town as a starting point:

```bash
npx tsx scripts/export-city.ts my-city.json
```

Edit it or generate your own, then point both programs at the same file:

```bash
# Platform
CITY_FILE=my-city.json npx tsx --env-file=../../.env src/index.ts

# Simulator: serve the file, then open
http://127.0.0.1:5173/?city=/my-city.json
```

To build one from real map data, use the two scripts in `apps/metro/scripts/`:

```bash
python apps/metro/scripts/pbf-block.py <extract.osm.pbf> block.json <south> <west> <north> <east>
node --import tsx apps/metro/scripts/real-block.ts block.json apps/sim/public/cities/my-city.json 4 4
```

It needs a square street grid and a named theater in the area. Add the file to `PLACE_FILES` in `apps/platform/src/index.ts`, then open `?place=my-city`. One platform can serve many places, and sessions ask for one by name.

## 2. The world: a 3D layer

All rendering lives in `apps/sim/src/scene.ts`. Nothing else in the simulator touches Babylon.js, and `world.ts` is pure logic. To use higher-quality models, or another engine, replace that one file and keep this surface:

| Method | Job |
|---|---|
| `captureFrame(getPose)` | Render a real frame from a pose, and return a JPEG with the pose it used |
| `poseFor(car, side)` | Where a car's camera sits and looks |
| `setStallStates(states)` | Show the live map in the world |
| `setView`, `followWalker` | Move the viewer's camera |
| `pickCar`, `pickStall` | Turn a click into an entity |
| `setRoute`, `setLabelsVisible`, `setGarageView`, `setTimeOfDay` | Viewer options |

Swapping only the car or building models is smaller still: change `carTemplate` or `buildBuildings`. After any visual change, measure vision again, because models that look different read differently. The app shows **Camera readings correct** live for this reason.

## 3. Real cameras

The platform doesn't know it's talking to a simulator. A real camera can replace the simulator by calling the same API:

```
POST /v1/sessions/:id/frames
{ "scoutId": "...", "jpeg": "<base64>", "pose": { "position", "target", "fovY", "width", "height" }, "capturedAt": 0 }
```

The pose has to be accurate. Stall readings come from projecting vehicles onto the mapped ground, so real GPS and heading error will cost accuracy, and that's the first thing to measure on real streets.
