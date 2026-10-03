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
- No native apps. Everything runs in the browser.
- No hosting of third-party 3D content without a licence that permits it.

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
| time | `start` and `end` of an interval, each with its own uncertainty |

Time rules:

- Years are stored as astronomical years (1 BCE = 0, 2 BCE = −1) and shown as
  BCE/CE.
- Each bound is `{earliest, latest}`, so "founded 7th century BCE" is
  `start = {−699, −600}`.
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
| X1 | VR mode via WebXR: stand inside a site at 1:1 scale | P1 |
| X2 | VR "table" mode: site as a miniature in front of the user | P2 |
| X3 | AR on phones via WebXR: show sites and assets around the user's location | P1 |
| X4 | AR placement fallback on devices without WebXR (tabletop model via the browser's AR viewer) | P2 |
| X5 | Comfort: teleport locomotion, snap turning, no forced camera motion | P1 |

### 7.7 Data pipeline

| id | requirement | prio |
|---|---|---|
| D1 | Importers for the first sources (see §8) into the common schema | P0 |
| D2 | Deduplication across sources by distance, name and type, with manual review | P1 |
| D3 | Provenance and licence per field (§6.6) | P0 |
| D4 | Scheduled re-import; changes shown as diffs | P2 |
| D5 | Coverage report per country and per period | P1 |
| D6 | Public export of the open subset with attribution | P1 |

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

Licence compatibility is a release blocker: an ODbL source may force the
merged database under ODbL. Decide the target licence in M0.

## 9. Technical direction

Proposal, to be confirmed in M0.

| layer | choice | reason |
|---|---|---|
| globe | CesiumJS | WGS84 globe, terrain, time-dynamic data, 3D Tiles |
| 3D content | 3D Tiles 1.1 with glTF meshes and Gaussian splats | one streaming format for scans and splats |
| XR | WebXR | VR and AR in one web app |
| front end | TypeScript, Vite | |
| data store | PostgreSQL + PostGIS | spatial and temporal queries |
| delivery | vector tiles or 3D Tiles for sites; static hosting for the open subset | scales without a heavy server |

Open check: whether CesiumJS's WebXR support and splat rendering are mature
enough, or whether XR needs a separate renderer (e.g. three.js) fed from the
same data.

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
| XR fragmentation across devices | WebXR first; graceful fallback to screen view |
| Scope: "every site in the world" | ship per region; coverage report makes progress visible |

## 13. Milestones

See [ROADMAP.md](ROADMAP.md). In short:

- **M0** decisions: stack, schema, target licence
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
