// End-to-end test of the XR modes (PRD X1-X6) on an emulated Meta Quest 3
// (Meta's Immersive Web Emulation Runtime, IWER), in headless Chrome.
// Not a substitute for a real headset: it checks that sessions start, frames
// render, teleport and snap turning work, table modes scale the world and AR
// on site places the anchor from (simulated) GPS.
//
// Needs the dev server: npm run dev (http://localhost:5173).
// Usage: node tests/xr-emulation.mjs

import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.ATLAS_URL ?? "http://localhost:5173/?emulate=quest&quality=desktop#v=47.7570,12.6450,3000,0,-0.6";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1280,860"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });
const origin = new globalThis.URL(URL).origin;
await browser.defaultBrowserContext().overridePermissions(origin, ["geolocation"]);
await page.setGeolocation({ latitude: 47.7570, longitude: 12.6450, accuracy: 5 }); // Ruhpolding
page.on("pageerror", (e) => console.log("page error:", e.message));
const dialogs = [];
page.on("dialog", async (d) => {
  dialogs.push(d.message());
  await d.dismiss();
});

await page.goto(URL);
await page.waitForFunction(() => window.atlas?.sites?.sites?.length > 0, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));

const state = () => page.evaluate(() => {
  const a = window.atlas;
  return {
    mode: a.xr.mode,
    presenting: a.renderer.xr.isPresenting,
    frame: a.renderer.info.render.frame,
    anchor: { ...a.xr.anchor },
    worldScale: a.world.matrix.elements[0],
    terrainVisible: a.terrain.visible,
    tiles: a.terrain.stats.rendered,
  };
});

const buttons = await page.$$eval("#xr button", (bs) => bs.map((b) => b.textContent));
check("XR buttons offered on the emulated Quest", buttons.includes("Enter VR") && buttons.includes("VR table"), buttons.join(", "));

async function enter(label) {
  const [button] = await page.$$("xpath/.//div[@id='xr']//button[normalize-space()='" + label + "']");
  if (!button) return false;
  await button.click(); // a real click: XR sessions need a user gesture
  await page.waitForFunction(() => window.atlas.renderer.xr.isPresenting, { timeout: 20000 }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 4000));
  return true;
}

async function exit() {
  await page.evaluate(() => window.atlas.xr.exit());
  await page.waitForFunction(() => !window.atlas.xr.mode, { timeout: 10000 }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1000));
}

// --- VR at 1:1 (X1), teleport and snap turn (X5) ---------------------------
if (await enter("Enter VR")) {
  const s0 = await state();
  await new Promise((r) => setTimeout(r, 2000));
  const s1 = await state();
  check("VR session starts", s0.mode === "vr" && s0.presenting);
  check("VR frames render", s1.frame > s0.frame, `${s1.frame - s0.frame} frames in 2 s`);
  check("VR shows terrain at 1:1", s1.terrainVisible && s1.worldScale === 1 && s1.tiles > 0, `${s1.tiles} tiles`);

  // Snap turn: push the right thumbstick to the right.
  const h0 = s1.anchor.heading;
  await page.evaluate(() => {
    const c = window.atlas.xrDevice.controllers.right;
    c.updateAxis("thumbstick", "x-axis", 1);
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => window.atlas.xrDevice.controllers.right.updateAxis("thumbstick", "x-axis", 0));
  const s2 = await state();
  check("Snap turn changes the heading", Math.abs(s2.anchor.heading - h0) > 0.1, `${((s2.anchor.heading - h0) * 180 / Math.PI).toFixed(0)} degrees`);

  // Teleport: point the right controller at the ground ahead and pull the trigger.
  const before = s2.anchor;
  await page.evaluate(() => {
    const c = window.atlas.xrDevice.controllers.right;
    c.position.set(0.2, 1.2, -0.3);
    // Pitched 40 degrees down, pointing forward.
    const a = (-40 * Math.PI) / 180;
    c.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2));
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.atlas.xrDevice.controllers.right.updateButtonValue("trigger", 1));
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.atlas.xrDevice.controllers.right.updateButtonValue("trigger", 0));
  await new Promise((r) => setTimeout(r, 800));
  const s3 = await state();
  const moved = Math.hypot((s3.anchor.lon - before.lon) * 75000, (s3.anchor.lat - before.lat) * 111000);
  // Aimed 40 degrees down from 1.2 m: the target is about 1.4 m ahead.
  check("Teleport lands where the controller points", moved > 0.5 && moved < 10, `${moved.toFixed(1)} m`);
  await exit();
  check("VR session ends cleanly", !(await state()).mode);
} else {
  check("VR session starts", false, "no Enter VR button");
}

// --- VR table (X2) -----------------------------------------------------------
if (await enter("VR table")) {
  const s = await state();
  check("VR table: miniature world", s.mode === "vr-table" && s.worldScale > 0 && s.worldScale < 0.01, `scale ${s.worldScale.toExponential(2)}`);
  await exit();
}

// --- AR on site (X3) and alignment (X6) --------------------------------------
const arOffered = buttons.includes("AR on site");
check("AR offered (emulated Quest 3 supports immersive-ar)", arOffered, arOffered ? "" : "not offered by the emulator");
if (arOffered && (await enter("AR on site"))) {
  const s = await state();
  check("AR session starts", s.mode === "ar" && s.presenting);
  check("AR anchor from GPS", Math.abs(s.anchor.lat - 47.757) < 0.001 && Math.abs(s.anchor.lon - 12.645) < 0.001,
    `${s.anchor.lat.toFixed(5)}, ${s.anchor.lon.toFixed(5)}`);
  check("AR hides the terrain (camera image instead)", !s.terrainVisible);
  const lat0 = s.anchor.lat;
  const nudged = await page.evaluate(() => {
    const b = document.querySelector('#xr-overlay button[data-m="north"]');
    b?.click();
    return !!b;
  });
  const s2 = await state();
  check("AR alignment buttons nudge the overlay", nudged && Math.abs(s2.anchor.lat - lat0) > 0, `${((lat0 - s2.anchor.lat) * 111320).toFixed(2)} m`);
  await exit();
}

// --- AR tabletop (X4) --------------------------------------------------------
if (buttons.includes("AR tabletop")) {
  const ok = await enter("AR tabletop");
  const s = await state();
  check("AR tabletop session starts (needs hit testing)", ok && s.mode === "ar-table",
    s.mode ? "" : dialogs.at(-1) ?? "no session");
  if (s.mode) await exit();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
