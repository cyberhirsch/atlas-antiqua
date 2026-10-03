# Roadmap

## M0: Decisions

- [ ] Confirm the stack (globe engine, data format, back end or static)
- [ ] XR spike (PRD §9): one scan and one splat in three.js + WebXR;
      frame rate on Meta Quest, GPS/compass AR placement on Android;
      go / no-go for WebXR packaged as Quest and Android apps
- [ ] Define the site schema: 4D coordinate, time uncertainty, sources, licence
- [ ] Check licences of the first data sources

## M1: Globe with points

- [ ] Globe with terrain
- [ ] Import one source (Wikidata or Pleiades) into the schema
- [ ] Time slider filtering sites by date

## M2: Geometry

- [ ] Splines and polygons with their own time spans
- [ ] Editing tools for both

## M3: 3D content

- [ ] Place a photogrammetry model at its true position and scale
- [ ] Place a Gaussian splat the same way
- [ ] Level of detail: switch from point to model as the camera approaches

## M4: XR

- [ ] Meta Quest app: WebXR VR walk-through at 1:1 scale, packaged as a PWA
- [ ] Android app: WebXR AR, show a site where you stand, packaged as a TWA

## M5: Coverage

- [ ] Merge sources, deduplicate sites, keep provenance per field
- [ ] Track coverage per country and per period
