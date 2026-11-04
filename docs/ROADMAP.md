# Roadmap

Planned work. None of this is built unless a section says so.

## Highway

The ring highway works as its own model. Next steps:

- Connect it to the town, so cars leaving a ramp become city traffic, and city trips can use the highway.
- Add exit coordination to the Spark Strategist and test whether it helps. It showed no measurable gain on city streets.
- Try a smart ramp light policy that accounts for exit choice. The current one did not reduce total delay.
- Test the idea on data from a real freeway corridor.

## Graphics levels

Levels 1 to 6 are built: open **Systems**, then **Graphics level**, or add `?gfx=6&time=night&weather=rain` to the URL. Levels 6 and 7 are planned.
The slider raises the look of the city step by step, from the blocky town toward open-world game quality, without
changing the simulation.

| Level | Adds |
|---|---|
| 1. Blocks | The original look: plain boxes for cars and buildings, flat color |
| 2. Vehicles | Detailed car models |
| 3. Buildings | Facades and windows. This is the look vision accuracy was measured on, and the default |
| 4. Street detail | Roof machinery, parapets, awnings, street furniture, and a sky with clouds |
| 5. Lighting | Bloom, tone mapping and a vignette, on top of the existing shadows |
| 6. Weather and atmosphere | Planned: rain, wet roads, fog, and headlights that light the scene |
| 7. Open-world quality | Planned: reflections, full post-processing and high-detail assets, on a capable GPU |

Rules for the build:

- **Graphics never change the outcome.** Traffic and parking logic stay independent of the level, so the same seed
  gives the same city at every level.
- **The level never changes what the cameras see.** Display detail sits on layers capture cameras skip, and post
  effects attach only to viewing cameras. A pixel comparison of capture frames across levels 1 to 5 stayed within 0.08
  out of 255, so vision numbers hold at every level. Measuring SAM on higher-detail frames is a separate, later test.
- **It uses the swap points in [PORTING.md](PORTING.md).** Each level is a set of swappable assets and scene settings,
  not a separate code path.
- **Scale to the machine.** Default to the highest level that holds a smooth frame rate, and let the viewer override it.

## Muse Lab

The Lab lets Muse do traffic R&D: it writes routing algorithms or tunes settings, tests them in SimTest on a smaller
Los Angeles, learns from the scores, and has to repeat its best result on commuters it never saw.
Muse works between rounds, never per car, so a session costs about a cent.

Built:
- Algorithm mode: Muse writes the road cost function. Code must pass an allowlist and runs without the API key.
- Settings mode: Muse starts from rough settings, never sees the hand-tuned ones, and tries to reach or beat them.
- Parallel Muse calls, a token budget, and a session record with every candidate.

Next:
- Understand why the winning algorithm gained far more at full size than in SimTest, and make SimTest predict full size better.
- Run the Lab during the day: rewrite the plan from the morning's real conditions, then apply it in minutes.
- Let Muse tune parking, trash pickup and signal timing the same way.
- Train real models: Muse writes a PyTorch training script for short-term travel time prediction, the Lab tests the result.
  This needs no more than a CPU for a small model. Until it runs, it is a plan and not a claim.
- Distributed SimTest: phones and cars run one small test each and earn karma. Some tests are run twice, so a device
  cannot report a fake result.
- More compute: larger cities and more candidates per round should find more, and that is untested until someone runs it.
- Real isolation: production would run generated code in a locked-down container, not only an allowlist.

## Real places in 3D

Goal: pick a location, such as downtown Los Angeles, and run the 3D sim on it.

- OpenStreetMap is free under its ODbL license and has building footprints, with heights in many dense areas. It has
  shapes, not looks, so buildings arrive plain. Colors and windows would come from our own materials, chosen by building type.
- Paid or restricted photorealistic tiles are a different choice. Check their license before using any, because
  storing or republishing them is often limited.
- Buildings are the easy part. Lanes, stalls, garages and camera positions are the hard part, and they need testing
  against SAM before any parking number carries over.
- Hand-build one real block first. It then becomes the worked example for a Muse function that fills in a checked town
  format from a plain request, with ordinary code building the roads.

## Toward a GTA look

In order of effect for the effort:

1. Lighting, weather, night with headlights, reflections, and sound. These are code, and they change the feel the most.
   Level 6 has headlights, taillights, rain and generated city sound. Reflections and wet roads are next. Sound has only
   been checked for errors, so it still needs listening to.
2. Free CC0 assets for cars, street props, textures and skies. Every asset must stay listed in the README.
3. Blender run from scripts, for families of cars and buildings in our own style. We own the output.
4. Paid assets last. Most licenses don't allow redistribution in a public repo, so check first.

GTA itself is the work of very large teams for years. The realistic goal is a convincing street-level look in the
places a demo goes, not a whole city at that level.

