# OrbitWatch — live satellite tracker

**▶ Live: [zachary-malcolm.github.io/orbitwatch](https://zachary-malcolm.github.io/orbitwatch/)**

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

- **Live data** from [CelesTrak](https://celestrak.org) (two-line element sets). The deployed site serves a copy that the GitHub Pages workflow refreshes every 3 hours, so visitors never run into CelesTrak's per-IP download limit
- **Real orbital mechanics**: positions from the SGP4 propagation model via [satellite.js](https://github.com/shashwatak/satellite-js)
- **High-resolution Earth**: NASA Blue Marble imagery by day and VIIRS city lights by night, streamed as tiles from NASA GIBS down to ~600 m per pixel. It rotates with Greenwich sidereal time, has a day/night terminator from the real sun position, and shows sun glint on the oceans
- **Target dossier**: click any satellite for an intel-style panel with owner country and flag, launch date and site, operational status, radar size, a photo and briefing from Wikipedia, and live telemetry (including whether it's in sunlight or Earth's shadow)
- **Close-up tracking**: the camera flies to the selected satellite and orbits around it. Zoom in and nearby spacecraft turn from dots into 3D models: NASA models for the ISS, Hubble, Aqua, Aura, Landsat, GOES, TDRS and ~20 more missions; NASA's SSL-1300 bus for geostationary comsats and a NASA CubeSat for small sats; procedural models for Starlink, Tiangong and the rest. The dossier says which model is shown and whether it is exact or representative
- **An image for every satellite**: its own Wikipedia photo, otherwise its programme's (e.g. Starlink), otherwise one for its type of spacecraft, labelled as representative
- **Conjunction watch**: every tracked object (~16,000 satellites plus ~2,700 debris fragments from the four largest
  break-ups) is screened against every other for passes closer than 5 km over the next 6–24 hours, in parallel Web
  Workers (~6 s for 24 h on an 8-core machine). Pick an encounter to rewind the clock to just before it, watch both
  objects close in with a live range readout, and hold at the exact moment of closest approach
- **Ground track and coverage footprint**: the path traced on the ground beneath the locked target (half an orbit behind,
  one and a half ahead) and the region that can see it, above the horizon and 10° up, with footprint radius and share of
  the Earth covered. Other satellites dim while a target is locked so the overlays stay readable
- **Shareable links**: `#norad=25544` opens a satellite; `#norad=A&with=B&t=<ISO time>` opens a specific close approach
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
| `src/groundTrack.ts` | Ground track and coverage footprint, drawn in the Earth-fixed frame |
| `src/conjunctions.ts` | Splits close-approach screening across parallel workers and merges the results |
| `src/conjunctionWorker.ts` | The screening itself: grid sieve, linear closest-approach test, SGP4 refinement |
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

**Ground track and footprint.** Track points are the satellite's inertial positions rotated back by Greenwich
sidereal time at each instant and projected onto the surface, which is why successive orbits land further west.
The footprint ring's angular radius from the Earth's centre is λ = acos(cos ε / r) − ε for minimum elevation ε
and orbit radius r (in Earth radii): about 20° for the ISS and 81° from geostationary orbit.

**Close-approach screening.** Every 60 s of the window, each object is propagated with SGP4 and dropped into
a 3D grid whose cells are the furthest two objects could close in half a step (5 km + 16 km/s × 30 s). Only
pairs in neighbouring cells are compared, using their straight-line relative motion over the half-step (two
nearby objects feel almost the same gravity, so their relative motion is close to straight even though each
orbit curves). Candidates are refined with a golden-section search on the exact SGP4 separation. Pairs with
under 100 m/s relative speed (docked vehicles, formation flyers) are dropped, and pairs inside one operator's
constellation are skipped by default: Starlink members are kept in a separate list per cell and never compared
with each other, which removes most of the work. The window is split into time slices screened in parallel.
Public TLEs are accurate to roughly a kilometre, so miss distances are indicative rather than operational.

## Credits

- Orbital elements and satellite catalogue: [CelesTrak](https://celestrak.org)
- Earth imagery: NASA [GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) (Blue Marble Next Generation, VIIRS Black Marble)
- Spacecraft models: [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources), compressed with glTF-Transform
- Photos and briefings: Wikipedia / Wikimedia Commons via the Wikipedia REST API and Wikidata
- Flags: [flagcdn.com](https://flagcdn.com)

## Roadmap ideas

- Pass predictions: "when is the ISS next visible from my location?"
- Deep-link URLs to a selected satellite
