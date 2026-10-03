# Atlas Antiqua

A world map of archaeological sites in four dimensions: every site with a
position on the globe, an elevation, and a span in time.

Zoom in from orbit on a desktop, walk through a site in VR, or stand on it
with your phone in AR.

## Goal

A 4D coordinate for every archaeological site in the world:

| axis | meaning | example |
|---|---|---|
| longitude | WGS84, degrees | 31.1342 |
| latitude | WGS84, degrees | 29.9792 |
| elevation | metres, EGM2008 geoid | 60 |
| time | start and end of occupation, with uncertainty | 7401 … 7501 HE (±50) |

Years use the [Holocene calendar](https://en.wikipedia.org/wiki/Holocene_calendar)
(HE): `HE = astronomical year + 10000`, so 1 CE = 10001 HE and
2600 BCE = 7401 HE. There is no year zero problem, and almost all of human
settlement history has positive years.

Time is a range, not a point. Every bound carries an uncertainty, and every
period links to a [PeriodO](https://perio.do) definition, so "Late Bronze Age"
means the same thing in Greece and in Scandinavia only when the data says so.

## Features

- **Globe and map:** one view from planet scale down to a single trench.
- **Time slider:** filter and animate sites by date.
- **Geometry:** points, splines (roads, walls, aqueducts, trade routes) and
  polygons (site extents, excavation areas, settlement phases), each with its
  own time span.
- **3D content:** photogrammetry models and Gaussian splats placed at their
  true position and scale.
- **Three apps from one code base:** a WebXR web app, shipped as a website,
  a VR app for Meta Quest and an AR app for Android.

## Proposed stack

Not decided yet. Starting point for discussion:

| layer | candidate | why |
|---|---|---|
| renderer | three.js + 3DTilesRendererJS | one renderer for web, VR and AR; WGS84 terrain and 3D Tiles |
| 3D content | 3D Tiles 1.1 (glTF meshes, Gaussian splats) | streams large models; one format for scans and splats |
| XR | WebXR, packaged as a PWA (Meta Quest) and a Trusted Web Activity (Android) | VR and AR apps from the web code base |
| data | GeoJSON with a time extension, PostGIS for the master set | open, diffable, queryable |
| front end | TypeScript + Vite | |

## Data sources to evaluate

Licences and coverage still to be checked for each:

- [Pleiades](https://pleiades.stoa.org): ancient places, mostly Mediterranean
- [Wikidata](https://www.wikidata.org): archaeological sites with coordinates
- [OpenStreetMap](https://wiki.openstreetmap.org/wiki/Tag:historic%3Darchaeological_site): `historic=archaeological_site`
- [ARIADNE](https://ariadne-infrastructure.eu): European research data
- [PeriodO](https://perio.do): period definitions for the time axis
- National heritage registers (Historic England, BLfD Bayern, …)

## Status

Empty project. See [docs/PRD.md](docs/PRD.md) and [docs/ROADMAP.md](docs/ROADMAP.md).
