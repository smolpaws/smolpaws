/**
 * capture.mjs — drive a browser through a storyboard and record it to webm.
 *
 * A launch clip is scripted, not hand-recorded: Playwright opens the target
 * URL, injects a visible fake cursor, and moves/clicks/scrolls through a
 * storyboard with eased motion so the capture is smooth and repeatable.
 * Playwright records the page to a .webm; polish.sh turns that into the mp4/gif.
 *
 * Usage:
 *   node capture.mjs --url <url> --out <dir> [--width 1280] [--height 800]
 *                    [--storyboard <file.mjs>]
 *
 * The storyboard is an ESM module exporting `default async (s) => { ... }`,
 * where `s` is a small helper API (see below). If omitted, a generic
 * "scroll the page slowly" storyboard runs.
 *
 * Requires the globally-installed playwright (resolve via `npm root -g`).
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const globalRoot = execSync("npm root -g").toString().trim();
const { chromium } = require(join(globalRoot, "playwright"));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const URL = arg("url", "http://127.0.0.1:12000/");
const OUT = resolve(arg("out", "/tmp/launch-capture"));
const WIDTH = Number(arg("width", 1280));
const HEIGHT = Number(arg("height", 800));
const STORYBOARD = arg("storyboard", null);

mkdirSync(OUT, { recursive: true });

// A visible cursor + smooth-move helpers injected into the page. Playwright's
// real mouse doesn't render a pointer in headless capture, so we draw our own
// and animate it; clicks pulse a ripple so the viewer sees the action.
const CURSOR_JS = `
window.__lv = (() => {
  const dot = document.createElement('div');
  dot.style.cssText = 'position:fixed;z-index:2147483647;width:22px;height:22px;left:0;top:0;'
    + 'margin:-4px 0 0 -4px;pointer-events:none;transition:transform .05s linear;'
    + 'background:no-repeat center/contain url("data:image/svg+xml;utf8,'
    + encodeURIComponent('<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 24 24\\'>'
      + '<path d=\\'M5 3l14 8-6 1.5L9.5 19z\\' fill=\\'white\\' stroke=\\'black\\' stroke-width=\\'1.2\\'/></svg>')
    + '");';
  document.body.appendChild(dot);
  let x = ${Math.round(WIDTH / 2)}, y = ${Math.round(HEIGHT / 2)};
  const put = () => { dot.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
  put();
  const ease = t => t < .5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function moveTo(tx, ty, dur=650){
    const sx=x, sy=y, steps=Math.max(12, Math.round(dur/16));
    for(let i=1;i<=steps;i++){ const t=ease(i/steps); x=sx+(tx-sx)*t; y=sy+(ty-sy)*t; put(); await sleep(dur/steps); }
  }
  function ripple(){
    const r=document.createElement('div');
    r.style.cssText='position:fixed;z-index:2147483646;left:'+x+'px;top:'+y+'px;width:8px;height:8px;'
      +'margin:-4px 0 0 -4px;border-radius:50%;pointer-events:none;border:2px solid #4ea1ff;'
      +'transition:all .45s ease-out;opacity:.9';
    document.body.appendChild(r);
    requestAnimationFrame(()=>{ r.style.width='46px';r.style.height='46px';r.style.margin='-23px 0 0 -23px';r.style.opacity='0'; });
    setTimeout(()=>r.remove(),500);
  }
  return {
    pos:()=>({x,y}),
    moveTo,
    async moveToSel(sel, dur){ const el=document.querySelector(sel); if(!el) return; const b=el.getBoundingClientRect(); await moveTo(b.left+b.width/2, b.top+b.height/2, dur); },
    async click(){ ripple(); await sleep(120); const el=document.elementFromPoint(x,y); if(el) el.click(); await sleep(120); },
    ripple, sleep,
  };
})();
`;

// The storyboard helper API handed to storyboard modules.
function makeApi(page) {
  const runInPage = (fn, ...a) => page.evaluate(fn, ...a);
  return {
    page,
    sleep: (ms) => page.waitForTimeout(ms),
    moveTo: (x, y, dur) => runInPage(([x, y, d]) => window.__lv.moveTo(x, y, d), [x, y, dur]),
    moveToSel: (sel, dur) => runInPage(([s, d]) => window.__lv.moveToSel(s, d), [sel, dur]),
    click: () => runInPage(() => window.__lv.click()),
    hoverSel: async (sel, dur) => { await runInPage(([s, d]) => window.__lv.moveToSel(s, d), [sel, dur]); },
    scrollBy: (dy, dur = 700) =>
      runInPage(([dy, dur]) => new Promise((res) => {
        const start = window.scrollY, steps = Math.round(dur / 16); let i = 0;
        const ease = (t) => (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
        const tick = () => { i++; const t = ease(i / steps); window.scrollTo(0, start + dy * t); if (i < steps) setTimeout(tick, 16); else res(); };
        tick();
      }), [dy, dur]),
    evaluate: (fn, ...a) => page.evaluate(fn, ...a),
  };
}

async function defaultStoryboard(s) {
  await s.sleep(900);
  await s.scrollBy(340, 1400);
  await s.sleep(700);
  await s.scrollBy(340, 1400);
  await s.sleep(900);
}

// Full chromium (headless). Video recording needs the full build, not the
// headless_shell — run `npx playwright install chromium` if it's missing.
const browser = await chromium.launch({
  headless: true,
  args: ["--force-color-profile=srgb"],
});
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  recordVideo: { dir: OUT, size: { width: WIDTH, height: HEIGHT } },
});
const page = await context.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
// Wait for real content to render (a card, or any settled body) rather than
// networkidle, which never fires on pages that poll/refresh.
await page.waitForSelector(".card, main", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1200);
await page.addStyleTag({ content: "*{cursor:none !important}" }); // hide native cursor
await page.evaluate(CURSOR_JS);

const s = makeApi(page);
let storyboard = defaultStoryboard;
if (STORYBOARD) {
  const mod = await import(pathToFileURL(resolve(STORYBOARD)).href);
  storyboard = mod.default;
}
await storyboard(s);
await page.waitForTimeout(500);

const video = page.video();
await context.close(); // finalizes the webm
await browser.close();
const savedPath = await video.path();
console.log(savedPath);
