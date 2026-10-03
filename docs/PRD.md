# Atlas Antiqua: Product Requirements

Status: draft · Owner: Seb Hirsch · Last updated: 2026-10-03

## 1. Summary

Atlas Antiqua is a web-based world map of archaeological sites in four
dimensions. Every site has a position, an elevation and a span of time. Users
move from orbit down to a single trench on a desktop, walk through a site in a
VR headset, or see it overlaid on the ground with a phone in AR. Sites can
carry splines, polygons, photogrammetry models and Gaussian splats, each placed
at its true position, scale and date.

## 2. Problem

Archaeological site data is scattered across national registers, research
databases, Wikidata, OpenStreetMap and individual publications. Each source
uses its own schema, its own period names and its own precision. Almost none
model time as a first-class axis, and 3D documentation (scans, splats) lives in
separate viewers with no geographic or temporal context.

Nobody can answer simple questions in one place:

- What was occupied in this valley around 1200 BCE?
- Which sites along this Roman road have a 3D scan?
- What did this hill look like in each of its phases?

## 3. Goals

1. **Coverage:** a 4D coordinate for every documented archaeological site in
   the world, merged from open sources with provenance per field.
2. **Time as an axis:** filter, animate and compare sites by date, with
   honest uncertainty.
3. **One continuous view:** planet to trench, map to 3D, screen to VR to AR,
   without switching tools.
4. **3D in context:** photogrammetry models and Gaussian splats georeferenced
   and dated like any other feature.
5. **Responsible publication:** never make looting easier.

## 4. Non-goals (for now)

- Not an excavation recording system (no context sheets, finds registers).
- Not a replacement for national registers; they remain the authority.
- No platforms beyond the three in §4.1 (no iOS, no other headsets) for now.
- No hosting of third-party 3D content without a licence that permits it.

### 4.1 Platforms

One WebXR web app, shipped three ways, on one shared data set:

| platform | packaging | role |
|---|---|---|
| Website | browser, desktop and mobile | globe and map, search, time slider, data and coverage views |
| Meta Quest | the web app as a PWA in the Meta Horizon Store; WebXR `immersive-vr` | stand inside a site at 1:1 scale, time travel through its phases |
| Android | the web app as a Trusted Web Activity in the Play Store; WebXR `immersive-ar` via ARCore | see sites and assets around you, on site |

All three run the same code and read the same site data and 3D Tiles, so a
site, its shapes and its scans look and date the same everywhere.

Constraints of this approach:

- The Android wrapper must be a Trusted Web Activity, which runs in Chrome.
  Android WebView (Capacitor, Cordova) has no WebXR.
- WebXR cannot use ARCore's Geospatial API. On-site AR is placed by GPS and
  compass, so expect metres of offset and heading drift. Exact overlay of a
  scan on real ruins may later need a native Android module or manual
  alignment.
- Quest Browser runs slower than a native engine. Large splats and dense
  3D Tiles must hold 72 fps there (§10); the M0 XR spike tests this.

## 5. Users

| user | needs |
|---|---|
| **Students** (e.g. TH Rosenheim courses) | explore sites by period and region; see scans in context; place their own photogrammetry and splats |
| **Researchers** | query by place, time and type; export with sources; see coverage gaps |
| **Heritage professionals** | contribute and correct data; control precision of sensitive sites |
| **Public and visitors** | browse visually; AR on site; VR at home |
| **Media producers** | reference for virtual sets and documentaries; accurate placement of scans |

## 6. Core concepts

### 6.1 Site

A place with archaeological evidence of past human activity. A site has one
identity and may have many phases, features and assets.

### 6.2 4D coordinate

| axis | definition |
|---|---|
| longitude, latitude | WGS84 decimal degrees, with a horizontal precision in metres |
| elevation | metres above the EGM2008 geoid, with a vertical precision; may be unknown |
| time | `start` and `end` year of an interval |

Time rules:

- Years are stored in the Holocene calendar: `HE = astronomical year + 10000`,
  so 1 CE = 10001 HE and 2600 BCE = 7401 HE. The UI can also show BCE/CE.
- Each bound is a single year, read by the viewer's time slider. "Founded
  7th century BCE" is `start = 9301`, the beginning of that century. How sure
  the dates are is carried by the time confidence (§6.7), not by ranges.
- An interval may reference a **PeriodO** period instead of, or in addition
  to, numeric dates. Numeric bounds are derived from the period when absent.
- Radiocarbon dates are stored as calibrated ranges, with the raw date and
  calibration curve kept as metadata.
- "Unknown" is a valid value, distinct from "not yet entered".

### 6.3 Phase

A time interval of a site with its own geometry and description, e.g. "Iron
Age hillfort" and "Roman watchtower" on the same hill.

### 6.4 Feature geometry

| type | examples |
|---|---|
| point | site centre, find spot |
| spline (polyline or curve) | road, wall, aqueduct, ditch, trade route |
| polygon | site extent, settlement area, excavation trench, phase footprint |

Every geometry has its own time interval and precision. Splines are stored as
polylines with optional curve control data for smooth display.

### 6.5 Asset

A 3D or media object attached to a site, phase or feature:

- photogrammetry or laser-scan mesh (glTF, via 3D Tiles for large models)
- Gaussian splat (3D Tiles with splat content, or SPZ/PLY converted on import)
- point cloud (LAS/LAZ, converted to 3D Tiles)
- images, plans, documents

Each asset has a georeference (position, orientation, scale), a capture date,
a creator, a licence and a precision.

### 6.6 Provenance

Every field records its source, the source's identifier and licence, and the
date of import. Merged sites keep all source records; conflicts are kept, not
silently overwritten.

### 6.7 Confidence

Every site, geometry and asset carries a confidence rating per axis, because
a precise position with a guessed date is a different thing from a vague
position with a radiocarbon date.

| axis | question it answers |
|---|---|
| `identity` | Is this really an archaeological site, and is its identification (e.g. ancient name ↔ place) right? |
| `position` | How sure is the horizontal location? |
| `elevation` | How sure is the height, and does it describe the ancient surface or today's? |
| `time` | How sure are the dates? |

Each axis gets a level from 0 to 5:

| level | label | position | time | identity |
|---|---|---|---|---|
| 5 | verified | surveyed or GNSS, ≤ 10 m | scientific dating (¹⁴C, dendro, TL) | excavated, published |
| 4 | high | authoritative register, ≤ 100 m | dated from excavated material | authoritative register |
| 3 | medium | gazetteer point, ≤ 1 km | period attribution from finds or style | scholarly consensus |
| 2 | low | approximate, ≤ 10 km | inferred from context or neighbours | probable, some dispute |
| 1 | speculative | from ancient texts or itineraries only | traditional or legendary date | disputed or conjectural |
| 0 | unknown | | | |

Rules:

- Levels are derived at import from the source's own precision and certainty
  fields (e.g. Pleiades `locationPrecision`, attestation certainty), the
  source tier, and the dating method. The rule that set each level is stored.
- Independent sources that agree within their precision raise the level by
  one, capped at 4; only direct evidence reaches 5.
- Manual overrides are allowed, with a reason and an author.
- The overall confidence shown on the map is the lowest axis (weakest link).
- **Elevation from a DEM** describes today's surface. On tells, buried or
  submerged sites, the ancient level can lie metres away. DEM-derived
  elevation is therefore capped at 3 and flagged `surface: modern` until a
  source gives the ancient level.

### 6.8 Confidence in the UI

- Marker style encodes overall confidence (e.g. solid → hollow → dashed).
- A minimum-confidence filter per axis.
- Site panel shows each axis with its level, the rule behind it and the
  sources.

## 7. Requirements

Priorities: **P0** first release, **P1** soon after, **P2** later.

### 7.1 Globe and map

| id | requirement | prio |
|---|---|---|
| G1 | 3D globe with terrain and satellite or map imagery | P0 |
| G2 | 2D map mode for low-end devices | P1 |
| G3 | Smooth zoom from planet scale to under 1 m | P0 |
| G4 | Clustering of points at low zoom; individual sites at high zoom | P0 |
| G5 | Level of detail: point → geometry → 3D asset as the camera approaches | P1 |
| G6 | Historical base layers (e.g. reconstructed coastlines) where licensed | P2 |

### 7.2 Time

| id | requirement | prio |
|---|---|---|
| T1 | Time slider selecting a year or a range | P0 |
| T2 | Sites and geometries shown only when their interval overlaps the selection | P0 |
| T3 | Uncertainty shown visually (e.g. fading at fuzzy edges) | P1 |
| T4 | Animation through time with adjustable speed | P1 |
| T5 | Period picker using PeriodO definitions, filtered by region | P1 |
| T6 | Non-linear time scale (deep prehistory compressed, recent periods expanded) | P1 |

### 7.3 Search and filter

| id | requirement | prio |
|---|---|---|
| S1 | Search by name, including alternative and historical names | P0 |
| S2 | Filter by site type, period, country, presence of 3D assets | P0 |
| S3 | Spatial query: draw an area, list its sites | P1 |
| S4 | Shareable URL encoding camera, time and filters | P0 |

### 7.4 Geometry editing

| id | requirement | prio |
|---|---|---|
| E1 | Draw and edit splines and polygons on the globe, snapped to terrain | P1 |
| E2 | Assign a time interval and precision to each geometry | P1 |
| E3 | Import GeoJSON, KML, Shapefile; export GeoJSON | P1 |
| E4 | Edit history per feature | P2 |

### 7.5 3D assets

| id | requirement | prio |
|---|---|---|
| A1 | Display photogrammetry meshes at true position and scale | P0 |
| A2 | Display Gaussian splats at true position and scale | P0 |
| A3 | Upload pipeline: mesh/splat/point cloud → 3D Tiles, with georeferencing | P1 |
| A4 | Georeferencing tool: place an asset with ground control points or by hand | P1 |
| A5 | Compare phases: toggle or slide between assets of different dates | P2 |

### 7.6 XR

| id | requirement | prio |
|---|---|---|
| X1 | Meta Quest app (WebXR PWA): stand inside a site at 1:1 scale | P1 |
| X2 | VR "table" mode: site as a miniature in front of the user | P2 |
| X3 | Android app (WebXR TWA): show sites and assets around the user's location in AR, placed by GPS and compass | P1 |
| X4 | AR tabletop mode: place a site as a model on a table, away from the site | P2 |
| X5 | Comfort: teleport locomotion, snap turning, no forced camera motion | P1 |
| X6 | Manual AR alignment: nudge and rotate an on-site overlay to match the ruins | P2 |

### 7.7 Data pipeline

| id | requirement | prio |
|---|---|---|
| D1 | Importers for the first sources (see §8) into the common schema | P0 |
| D2 | Deduplication across sources by distance, name and type, with manual review | P1 |
| D3 | Provenance and licence per field (§6.6) | P0 |
| D4 | Scheduled re-import; changes shown as diffs | P2 |
| D5 | Coverage report per country and per period | P1 |
| D6 | Public export of the open subset with attribution | P1 |
| D7 | Confidence levels per axis derived at import, with the rule stored (§6.7) | P0 |
| D8 | Confidence filter and marker styling in the UI (§6.8) | P1 |

### 7.8 Sensitive sites

Precise coordinates of unprotected sites help looters and metal detectorists.

| id | requirement | prio |
|---|---|---|
| P1 | Each site has a publication precision; public views degrade coordinates to it | P0 |
| P2 | Inherit restrictions from the source (e.g. registers that publish only to grid squares) | P0 |
| P3 | Trusted roles see full precision; access is logged | P2 |
| P4 | AR never reveals a hidden site's location more precisely than the map does | P1 |

## 8. Data sources

To be evaluated for coverage, precision, time data and licence before import.
Order is a proposal.

| source | scope | notes |
|---|---|---|
| Wikidata | global | broad, uneven precision; CC0 |
| Pleiades | ancient Mediterranean and Near East | good names and periods |
| OpenStreetMap | global | `historic=archaeological_site`; ODbL, share-alike affects the merged set |
| PeriodO | global | period definitions for the time axis |
| ARIADNE | Europe | research metadata, links to national data |
| National registers | per country | authoritative; licences vary widely |

### 8.1 Further sources

Candidates that add value with little integration work, because they are
open downloads keyed by coordinates, Wikidata IDs or Pleiades IDs. Licences
and current availability still need checking for each.

| kind | source | adds |
|---|---|---|
| **identity and links** | Wikidata | names in many languages, images (Wikimedia Commons), Wikipedia articles, heritage designations, inception dates |
| | UNESCO World Heritage List | status, criteria, inscription year, official boundaries for many sites |
| | Pelagios / Linked Places format | links between places, texts and maps |
| **time** | PeriodO | regional period definitions with date ranges |
| | Radiocarbon databases (e.g. p3k14c, XRONOS, RADON) | dated samples with coordinates: direct level-5 time evidence |
| | Allen Ancient DNA Resource (AADR) | dated, located human remains with genetic ancestry |
| **geometry** | OpenStreetMap | site outlines as polygons, walls and ditches as lines |
| | Itiner-e, DARE | Roman road network as splines; Roman sites |
| | ORBIS | travel times and costs between Roman places |
| **elevation and landscape** | Copernicus GLO-30 DEM | global elevation (already used by `scripts/pleiades.py`) |
| | National open LiDAR (e.g. Bavaria, England, Netherlands) | 1 m terrain where earthworks become visible |
| | Sea-level and palaeo-coastline reconstructions | which coastal sites were inland, which are now submerged |
| **3D and media** | Sketchfab (CC-licensed cultural heritage models), Smithsonian Open Access 3D, CyArk, Zamani Project | photogrammetry and scans to place on the map |
| | Wikimedia Commons, Europeana | photographs and plans, often geotagged |
| **context** | Epigraphic databases (e.g. EDH, Trismegistos Places) | inscriptions found at a place |
| | Nomisma / coin find databases | coin finds with dates, linked to mints |
| | Shipwreck databases | dated underwater sites |
| | Georeferenced historical maps (e.g. David Rumsey) | old surveys showing features since destroyed |

Licence compatibility is a release blocker: an ODbL source may force the
merged database under ODbL. Decide the target licence in M0.

## 9. Technical direction

Proposal, to be confirmed in M0.

| layer | choice | reason |
|---|---|---|
| renderer | three.js | one renderer for website, Quest and Android, with solid WebXR support |
| globe and 3D Tiles | 3DTilesRendererJS (with its globe/ellipsoid support) | WGS84 terrain and 3D Tiles in three.js |
| splats | a three.js Gaussian splat renderer (to pick in the spike) | splats in the same scene as meshes |
| terrain | Copernicus GLO-30 (GLO-90 where GLO-30 has no tile), replaced by open national LiDAR (e.g. Bavarian DGM1, 1 m) at every LOD where it exists; tiled as a LOD pyramid | open, global, 30 m; LiDAR is bare ground and far better than GLO-30 even at 30 m, so it is not mixed in only at the near LODs |
| imagery | Sentinel-2 (10 m) as the global base; open national orthophotos (10–40 cm) where they exist; Esri or Bing as an optional web layer under their terms | open base everywhere, better data where it is free, vendor layers only as an option |
| sea floor | ETOPO 2022 (NOAA), optional layer on the website only | shows shipwrecks and submerged sites in place; not used in AR; in VR only as a far LOD |
| 3D content | 3D Tiles 1.1 with glTF meshes and Gaussian splats for delivery; GLB for single scans; OpenUSD for collaborative site scenes (§9.2) | one streaming format for scans and splats; source formats that tools and people can edit |
| XR | WebXR (`immersive-vr` on Quest, `immersive-ar` on Android) | one code base for VR, AR and the website |
| packaging | PWA for the Meta Horizon Store; Trusted Web Activity (Bubblewrap) for Google Play | store apps without a native engine |
| front end | TypeScript, Vite | |
| data store | PostgreSQL + PostGIS | spatial and temporal queries |
| delivery | vector tiles or 3D Tiles for sites; static hosting for the open subset | scales without a heavy server |

CesiumJS was the first candidate for the globe. Its WebXR support is thin,
so it stays a fallback for the website only, if three.js's globe proves
too weak.

### 9.1 Terrain and scan delivery

Designed for the weakest target, the Quest browser (WebGL 2, limited GPU
memory), so the same data runs everywhere.

**Terrain: heights as images, mesh built on the GPU.**

- A quadtree of height tiles (e.g. 256 × 256 samples), losslessly
  compressed (WebP or LERC). Optionally each tile stores only its difference
  from the upsampled parent tile: most values are near zero and compress
  well. This keeps the useful part of wavelet compression without a decoder
  that browsers lack.
- The viewer draws one fixed grid mesh and displaces its vertices from the
  height tile, with smooth blending between LODs (CDLOD / clipmap style).
  Height images are far smaller than finished meshes.
- Imagery as GPU-compressed textures (KTX2 / Basis Universal), so GPU memory
  holds the compressed form. This matters more on the Quest than download
  size.
- LiDAR regions are blended into GLO-30 over a band of a few hundred metres
  at their edge, at every LOD, after conversion to WGS84 and EGM2008.

**Scans: Nanite's ideas, built offline, delivered as 3D Tiles.**

- Unreal's Nanite splits meshes into clusters of about 128 triangles, builds
  a crack-free LOD tree of simplified cluster groups and picks clusters per
  frame on the GPU so each triangle covers about one pixel. That needs GPU
  features (e.g. 64-bit atomics) that WebGL lacks and WebGPU has only in
  part, so it is not usable on the Quest browser.
- Instead, the cluster LOD tree is built offline (meshoptimizer), stored as
  3D Tiles 1.1 with meshopt compression and KTX2 textures, and the viewer
  chooses detail per tile by screen-space error.
- Gaussian splats need their own LOD (coarse splat levels for distance);
  the chosen splat renderer must support it.

### 9.2 3D formats: authoring, exchange, delivery

| stage | format | why |
|---|---|---|
| collaborate on a site scene | OpenUSD | layers per source or contributor, stronger layers override weaker ones without overwriting, so provenance stays visible (§6.6); variants for phases (§6.3); payloads load heavy scans only when needed; read and written by Blender, Houdini, Maya, Unreal, Unity and Omniverse |
| upload and exchange a single scan or object | GLB (binary glTF 2.0) | one compact file; meshopt or Draco geometry, KTX2 textures; splats via the draft `KHR_gaussian_splatting` extension |
| deliver to website, Quest and Android | 3D Tiles 1.1 (tiles are GLB) | streaming and LOD by screen-space error (§9.1) |

Rules:

- 3D Tiles are build output, like compiled code. Nobody edits a tile: its
  neighbours, parents and children would no longer match, and the next build
  would overwrite it. Users check out the source (the GLB, or the site's USD
  layer), change it, submit it for review, and the build rebuilds only that
  site's tiles.
- USD and GLB carry local metres only. The position on Earth (WGS84,
  EGM2008, orientation, scale) lives in the site record and in the 3D Tiles
  root transform, not in the files.
- USD is for 3D scenes, not for site records: the 29,000+ sites stay in
  PostGIS / GeoJSON.
- USD is needed from M3 (scans) on, and only where several people work on
  one site scene. Before that, GLB files and git are enough.
- Single tiles can still be inspected: each is a GLB, and `3d-tiles-tools`
  unpacks whole tilesets for debugging.

**XR spike (M0).** Before anything is built on this stack:

1. One photogrammetry scan as 3D Tiles and one Gaussian splat, both at a real
   site's position, in a three.js scene with 3DTilesRendererJS.
2. On a Meta Quest (Quest Browser, then packaged as a PWA): frame rate in
   `immersive-vr` at 1:1 scale; splat size at which it drops below 72 fps.
3. On an Android phone (Chrome, then packaged as a TWA): `immersive-ar`
   session, the scan placed by GPS and compass; measured offset and heading
   drift on site.
4. Terrain: height tiles with GPU displacement against ready-made terrain
   meshes as 3D Tiles; frame rate and GPU memory on the Quest. Test area:
   Traunstein–Ruhpolding (Bavarian DGM1 blended into GLO-30).
5. Scans: a meshoptimizer cluster LOD tree against simple per-tile LOD.
6. Pick the splat renderer; record results and a go / no-go for the WebXR
   approach. No-go fallback: a native engine (e.g. Cesium for Unity) for the
   Quest and Android apps.

## 10. Performance targets

Targets, not measurements.

| metric | target |
|---|---|
| first globe render, desktop broadband | < 3 s |
| frame rate, desktop | 60 fps |
| frame rate, VR | ≥ 72 fps (headset native) |
| frame rate, phone AR | ≥ 30 fps |
| time-slider update | < 100 ms visible response |
| sites rendered without stutter | 1 million (clustered) |

## 11. Success metrics

- Number of sites with a complete 4D coordinate (position + elevation + dated
  interval), per country.
- Share of sites with a time interval narrower than 500 years.
- Number of georeferenced 3D assets.
- Coverage gaps closed per release.
- Use in teaching: student projects placed on the map per semester.

## 12. Risks

| risk | mitigation |
|---|---|
| Looting through precise coordinates | precision degradation (§7.8), source restrictions honoured |
| Licence conflicts between sources | licence per field; decide target licence early |
| Inconsistent dating across sources | PeriodO links; keep raw values; show uncertainty |
| Large 3D assets and hosting cost | 3D Tiles streaming; external hosting links where possible |
| Three apps drifting apart | one WebXR code base, one data set and one 3D Tiles stream for all |
| WebXR too slow on Quest, or AR placement too coarse | XR spike in M0 before building on it; native engine as fallback |
| Scope: "every site in the world" | ship per region; coverage report makes progress visible |

## 13. Milestones

See [ROADMAP.md](ROADMAP.md). In short:

- **M0** decisions: stack, schema, target licence; XR spike
- **M1** globe with points and time slider (one source)
- **M2** splines and polygons
- **M3** photogrammetry and splats
- **M4** VR and AR
- **M5** multi-source merge and coverage

## 14. Open questions

1. Target licence of the merged dataset (CC BY, ODbL, CC0)?
2. Who may contribute data, and who reviews it?
3. Static site with periodic builds, or a live back end from the start?
4. Which region first: Bavaria (BLfD), the Mediterranean (Pleiades), or global
   from Wikidata?
5. Should students' coursework scans be publishable by default, opt-in, or
   kept private?
6. Elevation: take it from terrain models at import, or only from sources
   that state it?
