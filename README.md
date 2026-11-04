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
6. Press **Trash hunt** for a three-minute round on foot against three rivals. Arrows or WASD to walk, Shift to run, E to pick up, V for first person.
7. Run **Stadium exit, with TES** to see the ring highway. SAM counts each ramp from real frames, and the panel compares the run to the same drivers without TES.

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

**Muse Spark, as a vision model.** Spark looks for trash on sidewalks and names what it finds, and it can read parking too. SAM is faster and repeatable, so it reads parking by default. The Systems panel lets you switch models for either job.

**Traffic Efficiency System (TES).** Code plots a route and a stall for each connected car, weighing traffic, the plans of other cars, and the walk. That loop has to be fast and repeatable. Above it sits the **Spark Strategist**: every 30 seconds, Muse Spark reads a digest of the whole city and steers TES through tools, avoiding streets, holding lights and moving demand between parking areas. That is the split real traffic centers use: strategy on top, controllers underneath. In two rounds of movie surge tests its decisions were sensible but made no measurable difference to results, so treat it as a working, explainable supervisor rather than a proven gain.

**Why cameras, when cars have GPS?** GPS only covers people who share their location, and it knows nothing about parking. Cameras see every vehicle and every stall.

**Highway.** Off-ramps jam partly because nobody knows who is getting off where, so drivers cut across lanes late and exit queues reach the mainline. TES knows connected drivers' exits in advance. It moves them over early, keeps through traffic out of the right lane near busy exits, and sends some drivers to a quieter exit before a queue forms. Ramp cameras count every car with SAM, and comparing those counts with GPS tells TES how much traffic it can't see.

Three kinds of driver show the difference:

- **Own route:** plots its own path, with no knowledge of traffic or parking.
- **TES guided:** gets a route and a stall, but a person can ignore them.
- **TES autopilot:** follows TES exactly, obeying traffic rules.

## Results

Every result below is from this simulation, not a real city. Real streets, weather and camera placement will differ.

**Vision, on rendered frames.**

- Street parking: 303 of 305 stall readings correct across two live daytime runs, in moving traffic. 96.8% at night.
- Garage parking: 152 of 152 readings correct, reading 90% of garage stalls in one sweep of the cameras.
- Trash: Muse Spark found 15 items in 6 test frames, 14 of them real. SAM with the prompt "garbage bag" found 7, all real. Both are selectable in the app.

These frames come from a simple 3D city. Real photos will be harder, so treat this as proof the pipeline works, not as real-world accuracy.

**Traffic, simulated.** Same city, same drivers, several seeds. Only how cars navigate changes.

| Everyday traffic, 60 drivers | Drivers parked | Time to park | Walk |
|---|---:|---:|---:|
| TES off | 46 | 173 s | 66 m |
| TES on, 60% of cars guided | 52 | 147 s | 48 m |
| TES on, 30% guided, 30% autopilot | 57 | 126 s | 50 m |
| TES on, 100% autopilot | 59 | 107 s | 45 m |
| 100% autopilot with smart lights | 60 | 92 s | 46 m |

| Movie theater surge, 110 drivers | Drivers parked | Time to park | Walk |
|---|---:|---:|---:|
| TES off | 26 | 479 s | 60 m |
| TES on, 60% of cars guided | 38 | 422 s | 63 m |
| TES on, 30% guided, 30% autopilot | 42 | 405 s | 65 m |
| TES on, 100% autopilot | 64 | 296 s | 72 m |
| 100% autopilot with smart lights | 63 | 285 s | 71 m |

Four seeds each. In a surge, 110 drivers head for one cinema within two minutes, so many are still searching at the end of every run, and average times include them. Self-routed drivers use garages too, once they give up on the street.

How much these numbers can be trusted depends on the simulated human drivers, whose search behavior is an assumption. Results and more detail are in the app under **Results**, and `apps/sim/scripts/tes-study.ts` reproduces them.

**Highway, simulated.** A separate model of a 2.2 km, three-lane ring with five interchanges. Each car follows a standard car-following model and changes lanes by accepting gaps, so congestion emerges rather than being scripted. TES cars keep the same following distance as people, so any gain comes from information, not from packing cars closer. Four seeds not used for tuning, at 65 mph.

| Stadium event, half the traffic to one exit | Trip time | Below 30 mph | Missed exits | Total delay* |
|---|---:|---:|---:|---:|
| TES off | 166 s | 42% | 143 | 58 h |
| 30% guided, GPS only | 168 s | 43% | 143 | 58 h |
| 30% guided, plus ramp cameras | 155 s | 35% | 111 | 55 h |
| 60% guided, plus ramp cameras | 149 s | 31% | 82 | 53 h |
| 100% autopilot | 142 s | 23% | 44 | 51 h |

| Rush hour, even traffic | Trip time | Below 30 mph | Missed exits | Total delay* |
|---|---:|---:|---:|---:|
| TES off | 132 s | 21% | 74 | 61 h |
| 30% guided, plus ramp cameras | 129 s | 19% | 47 | 60 h |
| 100% autopilot | 126 s | 14% | 13 | 58 h |

*Highway trip time plus cross-street waiting, in vehicle-hours, so green time for a ramp isn't treated as free.

What the study found:

- **Knowing destinations helps most when demand is uneven.** Choosing a quieter exit was the strongest single feature at the stadium. In even rush hour the gain is small, though missed exits fall by 82%.
- **Cameras matter when few cars share GPS.** At 30% participation in the stadium event, GPS alone made no difference. Adding ramp cameras cut trip time by 7%.
- **A higher limit alone does little.** In the stadium event, going from 55 to 75 mph took trips from 172 s to 163 s without TES, and to 142 s with it, with mainline speed up from 31 to 44 mph. Hard braking rose 82% without TES and 71% with it, so TES did not offset that.
- **Early lane moves can backfire.** Alone, they made the stadium event worse, because exit traffic filled the right lane past other exits and blocked them. A warning of 800 m was far worse than 380 m. They help in even traffic, and at the stadium only when combined with exit choice.
- **Smart ramp lights did not reduce total delay.** They moved delay onto cross streets, and at the stadium they made results worse, so they are off by default.
- **Baseline timing matters.** A well-tuned fixed signal explained nearly all of an early apparent gain from smart lights, so every number here compares against the best fixed timing.

With human drivers set to move over 60% earlier, the stadium gain held at 17% and the rush hour gain fell to 4%, so the rush hour result depends more on driver assumptions. The ring is a small, stylized model. It shows the mechanism, not what would happen on a real highway such as those in Los Angeles. Highway cars leave the model at the edge of town and don't yet enter its streets. `apps/sim/scripts/highway-study.ts` reproduces these numbers.

**Ramp counts, on rendered frames.** SAM counted 319 of 342 cars across 74 ramp frames, about 0.75 s per frame, with 66 frames within one car of the true count. Modeled ramp cameras in the study use that 93% rate.

## Which parts are real

| Part | Status |
|---|---|
| Camera vision, parking map | Production. Runs on Meta SAM 3.1 with geometry code. |
| Trip agent, city operator, Spark Strategist | Production. Run on Meta Muse Spark with real tool calls. |
| Trash detection | Production. Runs on Meta Muse Spark or SAM 3.1, your choice. |
| Traffic Efficiency System routing, smart lights | Production. Deterministic code, steered by the Strategist. |
| City, cars, drivers, pedestrians, survey cars | Simulation. Scripted, with no AI. |
| AI residents | Simulation. Muse Spark plays people who choose their own trips. |
| Self-driving | Simulation. A stand-in for a real autopilot. |
| Highway routing | Production logic. Sees only GPS reports and ramp camera counts. |
| Ramp camera counts | Production in the live demo, on Meta SAM 3.1. Modeled at the measured rate in the offline study. |
| Highway, its drivers and demand | Simulation. A driver model, with no AI. |
| Trash hunt game | Simulation. Game rules, with no AI. Tested not to change traffic. |

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

## Using another city

The town is plain data and the 3D layer is one file, so this runs in other environments. See [docs/PORTING.md](docs/PORTING.md).

Planned work, including graphics levels from blocks up to open-world quality, is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Built during the hackathon

Everything in this repo was built during the event, between November 3 and 4, 2026. The commit history shows the order. It uses no earlier code.

Meta models and tools used in the product: SAM 3.1 and Muse Spark 1.3, through the Meta Model API. The code was written with Claude Code.

## Assets and licenses

All 3D content is generated in code. There are no third-party models or textures.

- [Babylon.js](https://www.babylonjs.com/), Apache-2.0
- [Overpass](https://fonts.google.com/specimen/Overpass) typeface, SIL Open Font License
- `@meta-sam/parser` and the OpenAI SDK, as listed in `package.json`
