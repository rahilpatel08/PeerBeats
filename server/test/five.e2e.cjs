/**
 * 5 contributors and 5 listeners at once, in real Chrome with a throwaway profile, all started
 * from the Lab page. Needs the server running, and no other PeerBeats tabs open.
 *   npm run test:five
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs'), os = require('os'), path = require('path');
const BASE = process.env.PEERBEATS_URL || 'http://localhost:4173';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  [${detail}]` : ''}`); };
setTimeout(() => { console.log('TIMED OUT'); process.exit(3); }, 280000);

const CONTRIBUTORS = ['A', 'B', 'C', 'D', 'E'].map((l) => `Contributor ${l}`);
const LISTENERS = [1, 2, 3, 4, 5].map((n) => `Listener ${n}`);
const SONGS = ['Moss and Mist', 'Slow Tide', 'Pale Altitude', 'Harbour at Dawn', 'Cartridge Dust'];

async function clickRow(lab, name) {
  await lab.bringToFront();
  const handle = await lab.evaluateHandle((name) => [...document.querySelectorAll('ul button')].find((b) => b.textContent.startsWith(name)), name);
  await handle.asElement().click();
}

(async () => {
  const before = await fetch(BASE + '/api/lab/status').then((r) => r.json());
  if (before.network.peers.length || before.network.listeners.length) {
    console.error('Close every PeerBeats tab first: this test counts everyone on the network.');
    process.exit(1);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-chrome-'));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: profile, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-audio-output'], defaultViewport: { width: 1280, height: 850 } });
  const errors = [];
  browser.on('targetcreated', async (t) => { const p = await t.page().catch(() => null); if (p) p.on('pageerror', (e) => errors.push(e.message)); });
  const lab = (await browser.pages())[0];
  await lab.goto(BASE + '/lab', { waitUntil: 'networkidle2' });

  console.log('\n5 contributors');
  const tabs = new Map();
  const newest = async (known) => {
    for (let i = 0; i < 40; i++) {
      for (const p of await browser.pages()) if (p !== lab && !known.has(p)) return p;
      await sleep(100);
    }
    throw new Error('No new tab opened');
  };
  const known = new Set();
  for (const name of CONTRIBUTORS) {
    await clickRow(lab, name);
    const page = await newest(known);
    known.add(page);
    tabs.set(name, page);
    await sleep(400);
  }
  const started = Date.now();
  const status = () => fetch(BASE + '/api/lab/status').then((r) => r.json());
  let full = false;
  while (!full && Date.now() - started < 60000) {
    const s = await status();
    full = s.network.peers.length === 5 && s.network.peers.every((p) => p.chunks === s.network.totalChunks);
    await sleep(500);
  }
  const s1 = await status();
  check('All 5 hold every song', full, s1.network.peers.map((p) => p.chunks).join(', '));

  const contributorEarned = async (name) => {
    const letter = name.slice(-1).toLowerCase();
    const res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `contributor.${letter}@peerbeats.test`, password: 'demo1234' }) });
    const { token } = await res.json();
    return (await (await fetch(BASE + '/api/contributor/stats', { headers: { Authorization: `Bearer ${token}` } })).json()).earnedPaise;
  };
  const earnedBefore = [];
  for (const name of CONTRIBUTORS) earnedBefore.push(await contributorEarned(name));

  console.log('\n5 listeners, each playing a different song');
  for (let i = 0; i < 5; i++) {
    await clickRow(lab, LISTENERS[i]);
    const page = await newest(known);
    known.add(page);
    tabs.set(LISTENERS[i], page);
    await page.bringToFront();
    await page.waitForSelector('main li button', { timeout: 10000 });
    const row = await page.evaluateHandle((song) => [...document.querySelectorAll('main li button')].find((b) => b.textContent.includes(song)), SONGS[i]);
    await row.asElement().click();
    await sleep(800);
    await page.evaluate(() => {
      const a = document.querySelector('audio');
      window.__gap = { waiting: 0 };
      a.addEventListener('waiting', () => { window.__gap.waiting++; });
    });
  }
  await sleep(3000);
  const startGap = async () => {
    for (const name of LISTENERS) {
      await tabs.get(name).evaluate(() => {
        const a = document.querySelector('audio');
        window.__gap.waiting = 0;
        window.__gap.t0 = a.currentTime;
        window.__gap.wall = performance.now();
      });
    }
  };
  const checkGap = async (label) => {
    for (const name of LISTENERS) {
      const g = await tabs.get(name).evaluate(() => {
        const a = document.querySelector('audio');
        return { waiting: window.__gap.waiting, advanced: a.currentTime - window.__gap.t0, wall: (performance.now() - window.__gap.wall) / 1000, paused: a.paused };
      });
      check(`${name} ${label}`, g.waiting === 0 && !g.paused && Math.abs(g.advanced - g.wall) < 1.5, `${g.waiting} stalls, ${g.advanced.toFixed(1)}s of music in ${g.wall.toFixed(1)}s`);
    }
  };
  await startGap();
  await sleep(30000);
  await checkGap('played 30 s with all 5 contributors');

  const labText = await lab.evaluate(() => document.body.innerText);
  check('Lab shows 5 contributors and 5 listening', labText.includes('5 contributors online, 5 listening'), (labText.match(/\d+ contributors? online, \d+ listening/) ?? [])[0]);

  console.log('\nWho did the work');
  const token = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@peerbeats.test', password: 'demo1234' }) })).json()).token;
  const admin = (url, init = {}) => fetch(BASE + url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }).then((r) => r.json());
  const net = await admin('/api/admin/network');
  check('Every contributor delivered music', net.peers.length === 5 && net.peers.every((p) => p.servedBytes > 0), net.peers.map((p) => `${p.name.slice(-1)}:${Math.round(p.servedBytes / 1024)}KB`).join(' '));
  for (const name of CONTRIBUTORS) {
    const alert = await tabs.get(name).evaluate(() => document.querySelector('[role=alert]')?.textContent ?? '');
    check(`${name}'s page shows no errors`, alert === '', alert);
  }
  const revenue = await admin('/api/admin/revenue');
  const refusedBefore = revenue.refused.filter((r) => r.reason !== 'same-user').reduce((sum, r) => sum + r.count, 0);
  // Payouts also run by themselves every minute, so check each contributor's own ledger.
  await admin('/api/admin/payout/run', { method: 'POST', body: '{}' });
  const earned = [];
  for (const name of CONTRIBUTORS) earned.push(await contributorEarned(name));
  check('Every contributor has been paid', earned.every((p, i) => p > earnedBefore[i]), earned.map((p, i) => `${CONTRIBUTORS[i].slice(-1)}:+${p - earnedBefore[i]}p`).join(' '));

  console.log('\nDown to 1 contributor, carrying all 5 listeners');
  for (const name of CONTRIBUTORS.slice(0, 4)) await tabs.get(name).close();
  await sleep(1000);
  await startGap();
  await sleep(30000);
  await checkGap('played 30 s with only 1 contributor');
  const netLast = await admin('/api/admin/network');
  check('The network shows 1 contributor', netLast.peers.length === 1, netLast.peers.length);
  const after = await admin('/api/admin/revenue');
  const refusedAfter = after.refused.filter((r) => r.reason !== 'same-user').reduce((sum, r) => sum + r.count, 0);
  check('No delivery was refused along the way', refusedAfter === refusedBefore && refusedAfter === 0, refusedAfter);
  check('No script errors in any tab', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(2); });
