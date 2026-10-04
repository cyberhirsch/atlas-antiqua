# Packaging the apps

Atlas Antiqua is one WebXR web app (PRD §4.1). The website is the build in
`web/`; the Quest and Android apps wrap the same site. The web side is
ready: a web app manifest (`web/public/manifest.webmanifest`), icons and a
service worker (`web/public/sw.js`) make the site installable.

What still needs accounts and keys, and so stays a manual step:

## Meta Quest (PWA in the Meta Horizon Store)

1. Publish the site (`scripts/deploy_pages.sh`); the start URL is
   https://cyberhirsch.github.io/atlas-antiqua/.
2. Package it as a PWA APK with Meta's Platform Utility
   (`ovr-platform-util`, its `create-pwa` command). Check Meta's current
   PWA documentation for the exact flags; they have changed between releases.
3. Upload the APK to a Meta Horizon developer app (needs a Meta developer
   account) and test it on a headset before release.

Without a headset: `node web/tests/xr-emulation.mjs` (with `npm run dev`
running) drives every XR mode on Meta's emulated Quest 3 in headless Chrome.
Then test in the Quest Browser: open the site, press "Enter VR".

## Android (Trusted Web Activity in Google Play)

A Trusted Web Activity runs the site in Chrome, so WebXR AR works (Android
WebView would not; PRD §4.1).

1. Install Bubblewrap (`npm i -g @bubblewrap/cli`); it asks for a JDK and the
   Android SDK on first run.
2. `bubblewrap init --manifest https://cyberhirsch.github.io/atlas-antiqua/manifest.webmanifest`
3. `bubblewrap build` creates the APK/AAB and a signing key. Keep the key
   safe; Play needs the same key for every update.
4. Digital Asset Links: put the key's SHA-256 fingerprint into
   `web/public/.well-known/assetlinks.json` (Bubblewrap prints the file) and
   deploy. GitHub Pages serves a project site under `/atlas-antiqua/`, but
   Android looks for `/.well-known/assetlinks.json` at the domain root, so the
   TWA needs either a custom domain or the file in the user site
   (`cyberhirsch.github.io` repository).
5. Upload the AAB to the Google Play Console (needs a developer account).

Test first in Chrome on an ARCore phone: open the site, press "AR on site".
