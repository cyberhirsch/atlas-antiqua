# Roadmap

Status as of 2026-10-04. Live test viewer: https://cyberhirsch.github.io/atlas-antiqua/

## M0: Decisions

- [ ] Confirm the stack (globe engine, data format, back end or static)
- [ ] XR spike (PRD §9): measure on a real Meta Quest and Android phone.
      Everything to measure is built: scan and splat in three.js + WebXR,
      GPS/compass AR placement, terrain as GPU-displaced height tiles
      (`?terrain=gpu`) vs CPU meshes, quality profiles. Cluster LOD for scans
      (meshoptimizer) is not built yet. Go / no-go for WebXR apps.
- [x] Site schema: 4D coordinate, single start/end year (HE), confidence per
      axis with rules, provenance and licence per field
- [ ] Check licences of the first data sources (Pleiades, Wikidata, Copernicus,
      ETOPO, EOX, Bavarian open data are recorded; review before a release)
- [x] Target licence of the merged data set: ODbL 1.0 (PRD §14.1); the code is MIT

## M1: Globe with points

- [x] Globe with terrain (ETOPO global, GLO-30 and Bavarian LiDAR test areas)
- [x] Import Pleiades into the schema; Wikidata linked and merged (D2)
- [x] Time slider: year or range, non-linear scale, fading by date certainty,
      animation, period picker
- [x] Search, shareable links, filters, clusters, confidence styling
- [x] Publication precision applied to all public data (P1)

## M2: Geometry

- [x] Pleiades outline shapes (LOD 0) with their own time spans
- [x] Draw and edit lines and areas on the terrain, with history; import
      GeoJSON/KML/Shapefile; export GeoJSON (kept in the browser for now)

## M3: 3D content

- [x] Place a photogrammetry model at its true position and scale (test scan
      of Skaptopara, CC BY 4.0)
- [x] Place a Gaussian splat the same way (test splat generated from the scan;
      a real splat capture is still wanted)
- [x] Asset pipeline (`scripts/add_asset.py`): meshopt, KTX2, splats, LAS/LAZ
- [x] Placement tool, phase switching by time and by hand
- [ ] 3D Tiles for very large scans (tiling) and cluster LOD

## M4: XR

- [x] WebXR VR at 1:1 with teleport and snap turning; VR table mode
- [x] WebXR AR on site (GPS and compass, manual alignment); AR tabletop
- [ ] Test on devices; package as Quest PWA and Android TWA (docs/PACKAGING.md)

## M5: Coverage

- [x] Merge sources, deduplicate sites, keep provenance per field (Pleiades +
      Wikidata; uncertain pairs in `data/sites/merge-review.csv` for review)
- [x] Coverage per country and per period (coverage.html)
- [x] Weekly re-import with a change report (GitHub Actions)
- [x] Open export with attribution (downloads/)
- [ ] Trusted roles with full-precision access (P3): needs a back end (§14.3)
