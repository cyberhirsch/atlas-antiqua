// Hover check: moving the mouse over a site enlarges it and shows its name.
import puppeteer from "puppeteer-core";
const out = process.argv[2] ?? "hover.png";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });
await page.goto("http://localhost:5173/?quality=desktop#v=41.8925,12.4853,4000,0.2,-0.9");
await page.waitForFunction(() => window.atlas?.sites?.sites?.length > 0, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 8000));
// Screen position of a shown site near the centre.
const target = await page.evaluate(async () => {
  const a = window.atlas; const THREE = await import("/node_modules/.vite/deps/three.js");
  const cam = a.controls.update(performance.now());
  let best;
  for (const s of a.sites.sites) {
    if (!a.sites.shown(s, cam)) continue;
    const v = new THREE.Vector3(s.pos[0] - cam[0], s.pos[1] - cam[1], s.pos[2] - cam[2]).project(a.camera);
    const x = (v.x + 1) / 2 * innerWidth, y = (1 - v.y) / 2 * innerHeight;
    const d = Math.hypot(x - innerWidth / 2, y - innerHeight / 2);
    if (!best || d < best.d) best = { x, y, d, name: s.name };
  }
  return best;
});
await page.mouse.move(target.x, target.y);
await new Promise((r) => setTimeout(r, 1500));
const state = await page.evaluate(() => ({ label: document.querySelector(".hover-label")?.textContent, shown: !document.querySelector(".hover-label")?.hidden, cursor: window.atlas.renderer.domElement.style.cursor, clusters: document.querySelectorAll(".cluster").length }));
await page.screenshot({ path: out, clip: { x: target.x - 160, y: target.y - 110, width: 320, height: 220 } });
console.log(JSON.stringify({ target: target.name, ...state }));
await browser.close();
