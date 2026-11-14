/**
 * Full demo walkthrough in real Chrome, using a throwaway profile. It clicks through the
 * Lab page as a person would and checks real WebRTC transfers between tabs.
 *   npm run test:chrome     (with the server running)
 */
const puppeteer = require('puppeteer-core');
const os = require('os'), fs = require('fs'), path = require('path');
const BASE = process.env.PEERBEATS_URL || 'http://localhost:4173';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  [${detail}]` : ''}`); };
async function realClick(page, selector, text) {
  await page.bringToFront();
  const handle = await page.evaluateHandle((selector, text) => [...document.querySelectorAll(selector)].find((e) => e.textContent.includes(text)), selector, text);
  await handle.asElement().click();
}
setTimeout(() => { console.log('E2E TIMED OUT'); process.exit(3); }, 330000);
if (!fs.existsSync(CHROME)) {
  console.error('This test needs Google Chrome in /Applications.');
  process.exit(1);
}
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-chrome-'));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: profile, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-audio-output'], defaultViewport: { width: 1280, height: 850 } });
  const errors = [];
  browser.on('targetcreated', async (t) => { const p = await t.page().catch(() => null); if (p) { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); } });
  const already = await fetch(BASE + '/api/lab/status').then((r) => r.json());
  if (already.network.peers.length || already.network.listeners.length) {
    console.error('Close every PeerBeats tab first: this test counts everyone on the network.');
    process.exit(1);
  }
  // If a tab ever dies, say which one and why, rather than only failing at the next click.
  const logPage = (p) => {
    p.on('error', (e) => console.log(`  TAB CRASHED: ${p.url()} ${e.message}`));
    p.on('close', () => { if (!finishing) console.log(`  TAB CLOSED: ${p.url()}`); });
  };
  let finishing = false;
  browser.on('targetcreated', async (t) => { const p = await t.page().catch(() => null); if (p) logPage(p); });
  browser.on('disconnected', () => { if (!finishing) console.log('  BROWSER EXITED'); });
  const lab = (await browser.pages())[0];
  logPage(lab);
  lab.on('pageerror', (e) => errors.push(e.message));
  await lab.goto(BASE + '/lab', { waitUntil: 'networkidle2' });
  await lab.evaluate(() => { window.__labMarker = 'still-here'; });
  const pageFor = async (pathPart) => { for (let i = 0; i < 40; i++) { for (const p of await browser.pages()) if (p.url().includes(pathPart)) return p; await sleep(250); } throw new Error('no page ' + pathPart); };
  const count = async () => (await browser.pages()).length;

  console.log('\nOpening roles from the Lab');
  const start = await count();
  await realClick(lab, 'main button, ul button', 'Contributor A');
  const a = await pageFor('/share');
  check('Clicking Contributor A opens a new tab', (await count()) === start + 1);
  await a.waitForFunction(() => document.querySelector('[data-testid="share-status"]')?.textContent.startsWith('Sharing active'), { timeout: 10000, polling: 300 });
  check('It starts sharing with no further clicks', true);
  await a.evaluate(() => { window.__marker = 'A'; });

  console.log('\nReturning without losing anything');
  await sleep(600);
  await realClick(lab, 'ul button', 'Contributor A');
  await sleep(800);
  check('Clicking it again opens no extra tab', (await count()) === start + 1, await count());
  check('...and does not reload it, so sharing continues', (await a.evaluate(() => window.__marker)) === 'A');
  await realClick(a, 'button', 'Back to Lab');
  await sleep(800);
  check('Back to Lab opens no extra tab', (await count()) === start + 1, await count());
  check('...and returns to the same Lab page, not a reload', (await lab.evaluate(() => window.__labMarker)) === 'still-here');
  check('Sharing still on after going back', (await a.evaluate(() => document.querySelector('[data-testid="share-status"]').textContent)).startsWith('Sharing active'));

  console.log('\nThe whole demo');
  await realClick(lab, 'ul button', 'Contributor B');
  await sleep(1500);
  const pages = await browser.pages();
  const b = (await Promise.all(pages.map(async (p) => ((await p.evaluate(() => window.__marker).catch(() => null)) !== 'A' && p.url().includes('/share') ? p : null)))).find(Boolean);
  check('Contributor B opens separately', Boolean(b));
  await b.waitForFunction(() => document.querySelector('[data-testid="share-status"]')?.textContent.startsWith('Sharing active'), { timeout: 10000, polling: 300 });
  const stored = async (p) => Number(await p.evaluate(() => document.querySelector('[data-testid="share-Segments stored"]').textContent));
  for (let i = 0; i < 80 && ((await stored(a)) < 366 || (await stored(b)) < 366); i++) await sleep(250);
  check('Both contributors stored the catalog separately', (await stored(a)) === 366 && (await stored(b)) === 366, `${await stored(a)}, ${await stored(b)}`);
  const idb = await a.evaluate(async () => (await indexedDB.databases()).filter((d) => d.name.startsWith('peerbeats-chunks')).length);
  check('Each account has its own browser store', idb === 2, idb);

  await realClick(lab, 'ul button', 'Listener');
  await sleep(1500);
  const listener = (await Promise.all((await browser.pages()).map(async (p) => (new URL(p.url()).pathname === '/' ? p : null)))).find(Boolean);
  check('Listener opens separately', Boolean(listener));
  await listener.waitForSelector('main li button');
  await realClick(listener, 'main li button', 'Moss and Mist');
  await sleep(7000);
  const audio = await listener.evaluate(() => { const a = document.querySelector('audio'); return { t: a.currentTime, paused: a.paused }; });
  check('Music is playing', audio.t > 3 && !audio.paused, `t=${audio.t.toFixed(1)}`);
  await realClick(listener, 'button[aria-label="Toggle debug panel"]', '');
  await sleep(300);
  const rows = await listener.evaluate(() => [...document.querySelectorAll('[data-testid=chunk-row]')].map((r) => r.children[1].textContent));
  check('Segments came from both peers', rows.includes('Contributor A') && rows.includes('Contributor B'), [...new Set(rows)].join(', '));

  const allPeers = await listener.evaluate(() => [...document.querySelectorAll('[data-testid=chunk-row]')].every((r) => r.children[1].textContent.startsWith('Contributor')));
  check('Every segment came from a contributor', allPeers);
  const refused = await listener.evaluate(async () => {
    const { token } = JSON.parse(sessionStorage.getItem('peerbeats.session'));
    const { tracks } = await (await fetch('/api/tracks?query=moss', { headers: { Authorization: 'Bearer ' + token } })).json();
    const { chunks } = await (await fetch('/api/tracks/' + tracks[0].id + '/manifest?prefetch=1', { headers: { Authorization: 'Bearer ' + token } })).json();
    return (await fetch('/seeder/chunks/' + chunks[1].id, { headers: { Authorization: 'Bearer ' + token } })).status;
  });
  check('This listener really cannot download from the server', refused === 403, refused);

  const labText = await lab.evaluate(() => document.body.innerText);
  check('Lab shows 2 contributors online', labText.includes('2 contributors online'));
  check('Lab shows what is playing', labText.includes('Playing Moss and Mist'));

  await realClick(lab, 'ul button', 'Monitor');
  const mon = await pageFor('/monitor');
  await mon.waitForSelector('[data-testid="monitor-Contributors online"]', { timeout: 8000 });
  await sleep(1500);
  const online = await mon.evaluate(() => document.querySelector('[data-testid="monitor-Contributors online"]').textContent);
  check('Monitor shows 2 contributors online', online === '2', online);
  const delivered = await mon.evaluate(() => document.querySelector('[data-testid="monitor-Delivered by contributors"]').textContent);
  check('Monitor shows data delivered by contributors', !delivered.startsWith('0 '), delivered);


  console.log('\nStage 4 acceptance: earnings after playing 3 songs');
  const asUser = (page, url, method = 'GET') => page.evaluate(async (url, method) => {
    const { token } = JSON.parse(sessionStorage.getItem('peerbeats.session'));
    const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    return res.json();
  }, url, method);
  const earnings = async () => ({ a: await asUser(a, '/api/contributor/stats'), b: await asUser(b, '/api/contributor/stats') });
  // Settle anything left from before, so this payout covers only these two contributors.
  await asUser(mon, '/api/admin/payout/run', 'POST');
  await sleep(300);
  const before4 = await earnings();
  const revenueBefore = await asUser(mon, '/api/admin/revenue');
  const servedBefore = await asUser(mon, '/api/admin/network');
  await listener.bringToFront();
  await listener.evaluate(() => document.querySelector('aside button[aria-label="Close debug panel"]')?.click());
  // Moss and Mist is already playing. These make three songs, with Moss and Mist picked again after.
  for (const title of ['Bonus Stage', 'Glass Arcade']) {
    await realClick(listener, 'main li button', title);
    await sleep(5000);
  }
  await sleep(600);
  const after4 = await earnings();
  const deliveredBytes = (after4.a.bytesTotal - before4.a.bytesTotal) + (after4.b.bytesTotal - before4.b.bytesTotal);
  check('Contributors\' delivered bytes rose', deliveredBytes > 0, deliveredBytes);
  const servedAfter = await asUser(mon, '/api/admin/network');
  const networkDelta = servedAfter.totals.peerBytes - servedBefore.totals.peerBytes;
  check('They match the server\'s record of verified deliveries', deliveredBytes === networkDelta, `${deliveredBytes} = ${networkDelta}`);
  check('Nothing was refused in normal use', after4.a.bytesRefused === before4.a.bytesRefused && after4.b.bytesRefused === before4.b.bytesRefused);
  await mon.bringToFront();
  await realClick(mon, 'button', 'Run payout now');
  await mon.waitForFunction(() => document.querySelector('[data-testid="payout-message"]')?.textContent.startsWith('Paid '), { timeout: 8000, polling: 200 });
  const payoutText = await mon.evaluate(() => document.querySelector('[data-testid="payout-message"]').textContent);
  await sleep(300);
  const paid4 = await earnings();
  const revenueAfter = await asUser(mon, '/api/admin/revenue');
  const earnedDelta = (paid4.a.earnedPaise - before4.a.earnedPaise) + (paid4.b.earnedPaise - before4.b.earnedPaise);
  check('Earnings rose after a payout', earnedDelta > 0, payoutText);
  check('Contributors\' earnings match the server\'s total paid', earnedDelta === revenueAfter.paidPaise - revenueBefore.paidPaise, `${earnedDelta} = ${revenueAfter.paidPaise - revenueBefore.paidPaise}`);
  check('The books balance', revenueAfter.netPaise === revenueAfter.recognizedPaise + revenueAfter.waitingPaise && revenueAfter.contributorSharePaise === revenueAfter.paidPaise + revenueAfter.carryPaise);
  await a.bringToFront();
  // The money received is on the same Contribute screen as sharing.
  await a.waitForFunction((value) => document.querySelector('[data-testid="earn-Earned"]')?.textContent === value, { timeout: 8000, polling: 200 }, `\u20b9${(paid4.a.earnedPaise / 100).toFixed(2)}`);
  check('The contributor\'s screen shows the same amount', true, `\u20b9${(paid4.a.earnedPaise / 100).toFixed(2)}`);
  check('Sharing is still running beside it', (await a.$eval('[data-testid="share-status"]', (e) => e.textContent)).startsWith('Sharing active'));
  await listener.bringToFront();
  await realClick(listener, 'main li button', 'Moss and Mist');
  await sleep(3000);
  await realClick(listener, 'button[aria-label="Toggle debug panel"]', '');
  await sleep(300);

  console.log('\nSomeone who has not paid');
  await realClick(lab, 'ul button', 'New Listener');
  const unpaid = await pageFor('/subscribe');
  await unpaid.waitForSelector('[data-testid="plan-status"]', { timeout: 8000 });
  check('They are told they have no plan', (await unpaid.$eval('[data-testid="plan-status"]', (e) => e.textContent)).includes('don\u2019t have a plan'));
  const refusedKey = await asUser(unpaid, `/api/tracks/${await listener.evaluate(async () => { const { token } = JSON.parse(sessionStorage.getItem('peerbeats.session')); return (await (await fetch('/api/tracks?query=moss', { headers: { Authorization: 'Bearer ' + token } })).json()).tracks[0].id; })}/manifest`);
  check('They are refused the song and its key', refusedKey.error === 'You need a plan to listen.' && refusedKey.key === undefined, refusedKey.error);
  await unpaid.close();
  await listener.bringToFront();

  // Real stalls are what the audio element itself reports, and 30 s outlasts the whole buffer.
  const startGapWatch = () => listener.evaluate(() => {
    const a = document.querySelector('audio');
    window.__gap = { waiting: 0, t0: a.currentTime, wall: performance.now() };
    if (!window.__gapHooked) {
      window.__gapHooked = true;
      a.addEventListener('waiting', () => { window.__gap.waiting++; });
    }
  });
  const readGap = () => listener.evaluate(() => {
    const a = document.querySelector('audio');
    return { waiting: window.__gap.waiting, advanced: a.currentTime - window.__gap.t0, wall: (performance.now() - window.__gap.wall) / 1000, paused: a.paused };
  });
  const chipNow = () => listener.evaluate(() => document.querySelector('[data-testid="delivered-by"]')?.textContent);
  const seekFraction = async (fraction) => {
    const box = await (await listener.$('input[aria-label="Seek"]')).boundingBox();
    await listener.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
  };
  // Names can appear in either order, so compare them as a set. Times count from the action.
  const sameNames = (chip, expected) => (chip ?? '').split(' + ').sort().join() === expected.split(' + ').sort().join();
  const waitForChip = async (expected, ms, since = Date.now()) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (sameNames(await chipNow(), expected)) return Date.now() - since;
      await sleep(50);
    }
    return null;
  };
  const expectNoGap = async (name, seconds) => {
    await sleep(seconds * 1000);
    const gap = await readGap();
    check(name, gap.waiting === 0 && !gap.paused && Math.abs(gap.advanced - gap.wall) < 1, `${gap.waiting} stalls, ${gap.advanced.toFixed(1)}s of music in ${gap.wall.toFixed(1)}s`);
  };

  console.log('\nDamaged copies caught');
  await listener.bringToFront();
  // Really damage both contributors' stored copies of one segment that hasn't loaded yet.
  const damageTarget = await listener.evaluate(async () => {
    const { token } = JSON.parse(sessionStorage.getItem('peerbeats.session'));
    const headers = { Authorization: 'Bearer ' + token };
    const { tracks } = await (await fetch('/api/tracks?query=moss', { headers })).json();
    const { chunks } = await (await fetch('/api/tracks/' + tracks[0].id + '/manifest?prefetch=1', { headers })).json();
    const duration = tracks[0].durationSec;
    const media = chunks.filter((c) => c.idx > 0);
    return media.filter((c) => c.start <= duration * 0.6).at(-1);
  });
  const damage = (page, chunkId) => page.evaluate(async (chunkId) => {
    const { user } = JSON.parse(sessionStorage.getItem('peerbeats.session'));
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('peerbeats-chunks-' + user.id);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const store = db.transaction('chunks', 'readwrite').objectStore('chunks');
    const row = await new Promise((resolve) => { const get = store.get(chunkId); get.onsuccess = () => resolve(get.result); });
    const bytes = new Uint8Array(row.bytes);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    row.bytes = bytes.buffer;
    await new Promise((resolve) => { const put = store.put(row); put.onsuccess = resolve; });
    db.close();
  }, chunkId);
  await damage(a, damageTarget.id);
  await damage(b, damageTarget.id);
  await seekFraction(0.6);
  let afterDamage = { repaired: '0' };
  for (let i = 0; i < 80 && afterDamage.repaired === '0'; i++) {
    await sleep(100);
    afterDamage = await listener.evaluate(() => ({
      repaired: document.querySelector('[data-testid="stat-Repaired"]')?.textContent ?? '0',
      bad: [...document.querySelectorAll('[data-testid=chunk-row]')].filter((r) => r.children[4].textContent === 'HASH MISMATCH').map((r) => r.children[1].textContent),
    }));
  }
  check('Both damaged copies are caught by the hash check', new Set(afterDamage.bad).size === 2, (afterDamage.bad ?? []).join(', '));
  check('A contributor repairs itself and a good copy arrives', afterDamage.repaired === '1', `repaired ${afterDamage.repaired}`);
  const damageTime = await listener.evaluate(() => document.querySelector('audio').currentTime);
  await sleep(1500);
  check('The music plays on', (await listener.evaluate(() => document.querySelector('audio').currentTime)) - damageTime > 1);
  await realClick(listener, 'aside button[aria-label="Close debug panel"]', '');

  console.log('\nA contributor freezes without disconnecting, as a locked phone does');
  await seekFraction(0.03);
  await sleep(2500);
  await startGapWatch();
  const frozenAt = Date.now();
  const freezer = await a.createCDPSession();
  await freezer.send('Page.setWebLifecycleState', { state: 'frozen' });
  const frozenSeen = await waitForChip('Contributor B', 8000, frozenAt);
  check('The frozen contributor is detected from its silence', frozenSeen !== null, frozenSeen === null ? await chipNow() : `${frozenSeen} ms`);
  await expectNoGap('No gap across 30 s, longer than the whole buffer', 30);
  const froze = await listener.evaluate(() => [...document.querySelectorAll('[data-testid=chunk-row]')].slice(0, 6).map((r) => r.children[1].textContent));
  check('New segments now come from the other contributor', froze.slice(0, 3).every((n) => n === 'Contributor B'), froze.slice(0, 3).join(', '));

  console.log('\nJumping ahead while a contributor is frozen');
  const duration = await listener.evaluate(() => document.querySelector('audio').duration);
  const seekGoal = duration * 0.75;
  const beforeJump = await listener.evaluate(() => document.querySelector('audio').currentTime);
  check('The jump target has not been loaded yet', seekGoal > beforeJump + 25, `from ${beforeJump.toFixed(0)}s to ${seekGoal.toFixed(0)}s`);
  const seekStarted = Date.now();
  await seekFraction(0.75);
  let resumedAfter = null;
  let landedAt = null;
  while (Date.now() - seekStarted < 6000) {
    const { t, rs } = await listener.evaluate(() => ({ t: document.querySelector('audio').currentTime, rs: document.querySelector('audio').readyState }));
    if (landedAt === null && Math.abs(t - seekGoal) < 3) landedAt = t;
    if (landedAt !== null && rs >= 3 && t > landedAt + 0.2) { resumedAfter = Date.now() - seekStarted; break; }
    await sleep(25);
  }
  check('Music is really playing at the new position soon after', resumedAfter !== null && resumedAfter < 2000, `${resumedAfter} ms`);
  const unfrozenAt = Date.now();
  await freezer.send('Page.setWebLifecycleState', { state: 'active' });
  const backBoth = await waitForChip('Contributor A + Contributor B', 25000, unfrozenAt);
  check('When it wakes up, it rejoins by itself', backBoth !== null, backBoth === null ? await chipNow() : `${backBoth} ms`);

  console.log('\nA contributor turning off and on');
  await seekFraction(0.03);
  await sleep(2500);
  await startGapWatch();
  await a.bringToFront();
  const offAt = Date.now();
  await a.click('button[role=switch]');
  await listener.bringToFront();
  const offSeen = await waitForChip('Contributor B', 3000, offAt);
  check('It is noticed within seconds', offSeen !== null && offSeen < 3000, `${offSeen} ms`);
  await expectNoGap('No gap', 5);
  await a.bringToFront();
  const rejoinAt = Date.now();
  await a.click('button[role=switch]');
  await listener.bringToFront();
  const rejoined = await waitForChip('Contributor A + Contributor B', 10000, rejoinAt);
  check('It rejoins with its music intact', rejoined !== null, rejoined === null ? await chipNow() : `${rejoined} ms`);
  check('It did not have to download everything again', (await stored(a)) === 366, await stored(a));

  console.log('\nStage 3 acceptance: closing a contributor tab mid-song');
  await seekFraction(0.03);
  await sleep(2500);
  await startGapWatch();
  await a.close();
  await expectNoGap('No gap across 30 s after the tab closes', 30);

  console.log('\nEvery contributor gone');
  const audioState = () => listener.evaluate(() => ({ t: document.querySelector('audio').currentTime, paused: document.querySelector('audio').paused }));
  const chip = () => listener.evaluate(() => document.querySelector('[data-testid="delivered-by"]')?.textContent);
  const notice = () => listener.evaluate(() => document.querySelector('[data-testid="peer-notice"]')?.textContent ?? '');
  await listener.bringToFront();
  await seekFraction(0.03);
  await sleep(1500);
  await listener.evaluate(() => { document.querySelector('a[href="/now"]').click(); });
  await sleep(300);
  await b.bringToFront();
  await b.click('button[role=switch]');
  await sleep(500);
  await listener.bringToFront();
  await sleep(500);
  check('The screen shows no contributors at once', (await chip()) === 'no contributors', await chip());
  check('A notice explains what will happen', (await notice()).includes('All contributors have left'), await notice());
  let stoppedAt = null;
  let previous = (await audioState()).t;
  for (let i = 0; i < 25 && stoppedAt === null; i++) {
    await sleep(2000);
    const now = (await audioState()).t;
    if (now - previous < 0.2) stoppedAt = now;
    previous = now;
  }
  check('The music really stops when its buffer runs out', stoppedAt !== null, stoppedAt === null ? 'never stopped' : `stopped at ${stoppedAt.toFixed(1)}s`);
  check('The notice says it is waiting for a contributor', (await notice()).includes('No contributors are online'), await notice());
  await sleep(3000);
  check('It stays stopped', (await audioState()).t - stoppedAt < 0.2);
  const stateLabel = await lab.evaluate(() => document.body.innerText);
  check('Lab says the listener is waiting, not playing', /Waiting for a contributor|0 peers online/.test(stateLabel));

  console.log('\nA contributor comes back');
  await b.bringToFront();
  await b.click('button[role=switch]');
  await b.waitForFunction(() => document.querySelector('[data-testid="share-status"]')?.textContent.startsWith('Sharing active'), { timeout: 10000, polling: 300 });
  await listener.bringToFront();
  let resumed = false;
  for (let i = 0; i < 24 && !resumed; i++) {
    await sleep(500);
    resumed = (await audioState()).t - stoppedAt > 1;
  }
  check('The music resumes by itself', resumed, `now at ${(await audioState()).t.toFixed(1)}s`);
  check('The screen names the contributor again', (await chip()) === 'Contributor B', await chip());
  check('The notice is gone', (await notice()) === '', await notice());

  console.log('\nStarting a song with no one online');
  await b.bringToFront();
  await b.click('button[role=switch]');
  await sleep(500);
  await listener.bringToFront();
  await listener.goto(BASE + '/search');
  await listener.waitForSelector('main li button');
  await realClick(listener, 'main li button', 'Slow Tide');
  await sleep(3500);
  const cold = await audioState();
  check('It does not play from the server', cold.t < 0.1, `t=${cold.t}`);
  check('It explains why', (await notice()).includes('No contributors are online'), await notice());
  await b.bringToFront();
  await b.click('button[role=switch]');
  await listener.bringToFront();
  let started = false;
  for (let i = 0; i < 24 && !started; i++) {
    await sleep(500);
    started = (await audioState()).t > 0.5;
  }
  check('It starts by itself when a contributor joins', started);

  console.log('\nMoving to the next song');
  await sleep(4000);
  const box = await (await listener.$('input[aria-label="Seek"]')).boundingBox();
  await listener.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  await sleep(6000);
  const nextTrack = await listener.evaluate(() => ({ title: document.querySelector('a[href="/now"] span span')?.textContent, t: document.querySelector('audio').currentTime, paused: document.querySelector('audio').paused }));
  check('The next song starts by itself', nextTrack.title !== 'Slow Tide' && nextTrack.t > 0.5 && !nextTrack.paused, `${nextTrack.title} at ${nextTrack.t.toFixed(1)}s`);

  console.log('\nBrowser errors');
  // Chrome notes this when the test navigates away from a page, which closes that page's socket.
  const real = errors.filter((e) => !/Failed to load resource|Page entered Back-Forward Cache/.test(e));
  check('No script errors in any tab', real.length === 0, real.slice(0, 3).join(' | '));
  finishing = true;
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
