# OrbitWatch — live satellite tracker

A real-time 3D globe showing every active satellite in orbit (~16,000 objects), computed in the browser from live orbital data,
presented as a 1980s amber-phosphor orbital surveillance terminal.

- **Terminal interface**: a dense modular cockpit grid (status bar, systems column, bezelled viewport, target dossier, event log, chrono
  control) in a strict amber palette with CRT scanlines, segmented block gauges and block sparklines. Every gauge is measured, not
  simulated: frame rate and CPU time, SGP4 solutions per second, JS heap, orbit-regime census, share of satellites in sunlight, objects
  in view, API round-trip times, and NASA imagery and model streaming. The event log records real events: data fetches, target locks,
  model loads, eclipse entry and exit
- **Phosphor / true-colour display**: a post-processing pass renders the 3D scene as monochrome amber with a 15° grid on the Earth,
  keeping the target's orbit in warning red. Satellites are drawn as category glyphs (□ · ◆ ✚ ▲ ○) so they stay distinguishable
  without colour. Switch to true colour for the full NASA imagery

- **Live data** from [CelesTrak](https://celestrak.org) (two-line element sets), cached for 2 hours to respect their rate limits
- **Real orbital mechanics**: positions from the SGP4 propagation model via [satellite.js](https://github.com/shashwatak/satellite-js)
- **High-resolution Earth**: NASA Blue Marble imagery by day and VIIRS city lights by night, streamed as tiles from NASA GIBS down to ~600 m per pixel. It rotates with Greenwich sidereal time, has a day/night terminator from the real sun position, and shows sun glint on the oceans
- **Target dossier**: click any satellite for an intel-style panel with owner country and flag, launch date and site, operational status, radar size, a photo and briefing from Wikipedia, and live telemetry (including whether it's in sunlight or Earth's shadow)
- **Close-up tracking**: the camera flies to the selected satellite and orbits around it. Zoom in and nearby spacecraft turn from dots into 3D models: NASA models for the ISS, Hubble, Aqua, Aura, Landsat, GOES, TDRS and ~20 more missions; NASA's SSL-1300 bus for geostationary comsats and a NASA CubeSat for small sats; procedural models for Starlink, Tiangong and the rest. The dossier says which model is shown and whether it is exact or representative
- **An image for every satellite**: its own Wikipedia photo, otherwise its programme's (e.g. Starlink), otherwise one for its type of spacecraft, labelled as representative
- Search by name or NORAD ID, filter by constellation, and fast-forward time up to 1000×

## Running locally

```bash
npm install
npm run dev
```

## How it works

| File | Responsibility |
|---|---|
| `src/tle.ts` | Fetches and caches TLE data, parses it into SGP4 records, and categorises satellites |
| `src/intel.ts` | Dossier data: CelesTrak SATCAT, Wikidata (NORAD ID → article) and Wikipedia summaries |
| `src/codes.ts` | Owner-country and launch-site lookup tables (generated from CelesTrak) |
| `src/models.ts` | Chooses and places a model for every satellite near the camera; procedural fallbacks |
| `src/scene.ts` | Three.js scene: base globe, atmosphere glow, starfield, sun light, environment reflections |
| `src/earthShader.ts` | Day/night Earth shading with city lights, ocean glint and limb haze |
| `src/earthTiles.ts` | Quadtree level-of-detail streaming of NASA GIBS imagery tiles |
| `src/nasaModels.ts` | Satellite → NASA model mapping, lazy glTF loading and instancing |
| `src/satellites.ts` | Satellite point cloud, propagation, screen-space picking, orbit paths |
| `src/main.ts` | Simulated clock, gauges, search, dossier, camera flights and tracking |
| `src/terminal.ts` | Text-mode widgets: block bars, sparklines, event log, radar sweep |
| `src/telemetry.ts` | Event log bus and timed fetches for link latency |

**Coordinate frame.** The scene is Earth-centred inertial (ECI), the frame SGP4 outputs. Instead of converting
every satellite to Earth-fixed coordinates each frame, the Earth mesh is rotated by sidereal time.
Orbits drawn this way are closed ellipses, as they are in reality.

**Performance.** Running SGP4 for 16k satellites every frame is too slow for 60 fps. Each frame
re-propagates a 4 ms time-boxed slice of satellites (round robin). Every other satellite moves with a
second-order Taylor step from its last exact fix: position, velocity and two-body gravitational
acceleration. The error stays below a kilometre at real-time speed, and frames take ~6 ms.

**Tracking camera.** While tracking, the orbit controls pivot around the satellite, and the camera's
offset is stored in the satellite's own frame (along-track, radial, cross-track). The view of the
Earth below therefore stays fixed as the satellite orbits, while you can still drag and zoom freely.

**Model scale.** Real spacecraft would be sub-pixel at planetary scale, so models are drawn at a
fixed exaggerated size (~37 km) that never shrinks below 14 px on screen.

**Earth tiles.** Each update walks a Web-Mercator quadtree from zoom 2 to 8 and splits a tile while
one of its texels would cover more than ~1.3 screen pixels. Tiles over the horizon or outside the view
frustum are skipped, and a tile that is still downloading is replaced by its nearest loaded ancestor. A
low-resolution globe sits 6 km underneath to cover the poles and any gaps.

## Credits

- Orbital elements and satellite catalogue: [CelesTrak](https://celestrak.org)
- Earth imagery: NASA [GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) (Blue Marble Next Generation, VIIRS Black Marble)
- Spacecraft models: [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources), compressed with glTF-Transform
- Photos and briefings: Wikipedia / Wikimedia Commons via the Wikipedia REST API and Wikidata
- Flags: [flagcdn.com](https://flagcdn.com)

## Roadmap ideas

- Pass predictions: "when is the ISS next visible from my location?"
- Ground track and sensor footprint for the selected satellite
- Debris layer and conjunction (close-approach) detection
- Deep-link URLs to a selected satellite
