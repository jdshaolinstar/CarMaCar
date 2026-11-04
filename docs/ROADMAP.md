# Roadmap

Planned work. None of this is built unless a section says so.

## Highway

The ring highway works as its own model. Next steps:

- Connect it to the town, so cars leaving a ramp become city traffic, and city trips can use the highway.
- Add exit coordination to the Spark Strategist and test whether it helps. It showed no measurable gain on city streets.
- Try a smart ramp light policy that accounts for exit choice. The current one did not reduce total delay.
- Test the idea on data from a real freeway corridor.

## Graphics levels

A slider, or one slider per layer, that raises the look of the city step by step. It starts at the blocky town and ends at
open-world game quality. It lets a demo show the idea working in the simplest form, then raise the look without
changing the simulation.

| Level | Adds |
|---|---|
| 1. Blocks | The original look: plain boxes for cars and buildings, flat color |
| 2. Vehicles | Detailed car models, with several body types and paint finishes |
| 3. Buildings | Detailed houses and storefronts, with real facades, windows and signage |
| 4. Streets | Road surface detail, street furniture, trees, and better pedestrians |
| 5. Lighting | Shadows, reflections, ambient occlusion and a real day and night cycle |
| 6. Weather and atmosphere | Rain, wet roads, fog, and headlights that light the scene |
| 7. Open-world quality | Full post-processing and high-detail assets, on a capable GPU |

Rules for the build:

- **Graphics never change the outcome.** Traffic and parking logic stay independent of the level, so the same seed
  gives the same city at every level.
- **The level changes what the cameras see.** Car cameras render the same scene, so SAM reads different pixels at
  each level. Vision accuracy has only been measured on the current look, so each level needs its own measurement
  before a number is quoted for it. Higher levels should also be a useful test, since they sit closer to real
  footage.
- **Cheap frames stay cheap.** Capture cameras can use a separate level from the main view if higher levels slow
  capture down.
- **It uses the swap points in [PORTING.md](PORTING.md).** Each level is a set of swappable assets and scene settings,
  not a separate code path.
- **Scale to the machine.** Default to the highest level that holds a smooth frame rate, and let the viewer override it.
