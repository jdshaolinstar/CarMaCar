# Roadmap

Planned work. None of this is built unless a section says so.

## Highway

The ring highway works as its own model. Next steps:

- Connect it to the town, so cars leaving a ramp become city traffic, and city trips can use the highway.
- Add exit coordination to the Spark Strategist and test whether it helps. It showed no measurable gain on city streets.
- Try a smart ramp light policy that accounts for exit choice. The current one did not reduce total delay.
- Test the idea on data from a real freeway corridor.

## Graphics levels

Levels 1 to 5 are built: open **Systems**, then **Graphics level**, or add `?gfx=5` to the URL. Levels 6 and 7 are planned.
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
