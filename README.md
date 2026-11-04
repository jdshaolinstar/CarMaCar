# CarMaCar

**Live demo:** LIVE_URL_HERE

**Demo video:** VIDEO_URL_HERE

Finding parking is a guessing game, and every driver guessing alone makes traffic worse. CarMaCar turns ordinary car and garage cameras into a live map of a city's parking, then uses Meta's AI to send each driver straight to a space, on a route that accounts for everyone else.

This repo is a working prototype with a browser city as its test bed. Cars in the simulation have real cameras that render real frames. Those frames go to a separate platform, which reads them with Meta's SAM 3.1. **The simulator never tells the platform what is parked where.** The map can only come from pixels.

Entered in the Meta Global AI Developer Hackathon, Indie Developer track, under the Push the Frontier problem statement.

## Try this first

Open the live demo, then:

1. Watch the map on the left fill in as cameras pass each stall.
2. Open **Playbooks** and run **Someone takes your stall**. The trip agent reserves a stall, a car physically takes it, the map still says free, and then a camera sees it and the driver is moved.
3. Run **Movie theater surge, no TES**, then **Movie theater surge, with TES**, and compare.
4. Open **Systems** to switch any part off. Each system is marked production or simulation, with what powers it.
5. Click any car, press **Drive this car**, and use arrows or WASD. Open **Phone app** to see the driver's view.

## How it works

```
apps/sim (browser)                         apps/platform (Node service)
  city, cars, garages                      
  car and garage cameras  -- photo + pose -->  SAM 3.1 finds vehicles
                                               geometry places them in stalls
                                               live parking map per session
  connected cars          -- GPS ---------->   Traffic Efficiency System
                          <-- route, stall --  (routing, parking, smart lights)
  drivers                 -- requests ----->   Muse Spark trip agent, tools
  city operator           -- goals -------->   Muse Spark operator, tools

  ground truth stays here. It is only used in the browser to score the map.
```

**Vision.** SAM 3.1 finds vehicles in each frame. Geometry code then projects each vehicle's contact with the road into the world, using the camera's position, and decides which stall it occupies. Photos are never stored: each exists only while its request is being handled.

**Muse Spark, as agents.** The trip agent turns "Drive to the movie theater. Find parking. The movie ends at 3pm" into tool calls that find, reserve and schedule. The city operator turns "There's a parade on Market St tonight" into settings for the routing system.

**Traffic Efficiency System (TES).** Deterministic code plots a route and a stall for each connected car, weighing traffic, the plans of other cars, and the walk. Muse Spark sets goals and explains. It does not run the moment-to-moment loop, because that has to be fast and repeatable.

**Why cameras, when cars have GPS?** GPS only covers people who share their location, and it knows nothing about parking. Cameras see every vehicle and every stall.

Three kinds of driver show the difference:

- **Own route:** plots its own path, with no knowledge of traffic or parking.
- **TES guided:** gets a route and a stall, but a person can ignore them.
- **TES autopilot:** follows TES exactly, obeying traffic rules.

## Results

Every result below is from this simulation, not a real city. Real streets, weather and camera placement will differ.

**Vision, on live frames.** RESULTS_VISION_HERE

**Traffic, simulated.** Same city, same drivers, several seeds. Only how cars navigate changes.

RESULTS_TABLE_HERE

How much these numbers can be trusted depends on the simulated human drivers, whose search behavior is an assumption. Results and more detail are in the app under **Results**, and `apps/sim/scripts/tes-study.ts` reproduces them.

## Which parts are real

| Part | Status |
|---|---|
| Camera vision, parking map | Production. Runs on Meta SAM 3.1 with geometry code. |
| Trip agent, city operator | Production. Run on Meta Muse Spark with real tool calls. |
| Traffic Efficiency System, smart lights | Production. Deterministic code. |
| City, cars, drivers, survey cars | Simulation. Scripted, with no AI. |
| Self-driving | Simulation. A stand-in for a real autopilot. |

## Run it yourself

You need Node 22 and a Meta Model API key.

```bash
npm install
echo "MODEL_API_KEY=your-key" > .env

# Terminal 1
cd apps/platform && npx tsx --env-file=../../.env src/index.ts

# Terminal 2
cd apps/sim && npx vite --port 5173 --host 127.0.0.1
```

Open http://127.0.0.1:5173. It sends about one photo per second, which costs real API credits. Close the tab when you're done.

`npm test` runs the test suite, and it makes no paid API calls.

| Setting | Purpose |
|---|---|
| `DAILY_BUDGET_USD` | Daily ceiling on API spend. Default 15. |
| `FRAME_LIMIT_PER_SESSION` | Photos allowed per visitor. Default 1200. |
| `AGENT_MODEL` | Model for agents. Default `muse-spark-1.3-contributor`. |
| `VITE_API_URL` | Where the sim finds the platform, when hosted. |

## Built during the hackathon

Everything in this repo was built during the event, between November 3 and 4, 2026. The commit history shows the order. It uses no earlier code.

Meta models and tools used in the product: SAM 3.1 and Muse Spark 1.3, through the Meta Model API. The code was written with Claude Code.

## Assets and licenses

All 3D content is generated in code. There are no third-party models or textures.

- [Babylon.js](https://www.babylonjs.com/), Apache-2.0
- [Overpass](https://fonts.google.com/specimen/Overpass) typeface, SIL Open Font License
- `@meta-sam/parser` and the OpenAI SDK, as listed in `package.json`
