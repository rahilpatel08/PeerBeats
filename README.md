# PeerBeats

A peer-to-peer music streaming system. Listeners fund the network, and contributors lend storage and bandwidth to deliver the music. **Contributors are the only source of music: with none online, nothing plays.** The project is built in five stages, listed in [docs/STAGES.md](docs/STAGES.md), then launched.

**Current state: all 5 stages are built.** Music is delivered peer to peer over WebRTC, survives contributors failing, and rebuilds lost copies. Listeners need a plan, and contributors earn a share for verified deliveries. People can keep a library, admins can add music, and it can be installed as an app. All money is test mode or simulated, and no real money moves. It runs on one laptop until it's launched: see [docs/LIMITS_AND_LAUNCH.md](docs/LIMITS_AND_LAUNCH.md).

| File | What it's for |
|---|---|
| `PeerBeats.app` | The Mac app: double-click it. Starts the server and shows the QR code for phones |
| `Start PeerBeats.command` | The same, in a Terminal window, if you prefer |
| `ios/PeerBeats.xcodeproj` | The iPhone app, if you install it with Xcode |
| `mac/PeerBeats.xcodeproj` | The Mac app's source, to rebuild it in Xcode |

| Document | What it's for |
|---|---|
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | The 8-minute lab demo, step by step |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | One-page architecture note for your project report |
| [docs/LIMITS_AND_LAUNCH.md](docs/LIMITS_AND_LAUNCH.md) | Known limits, future work and the launch checklist |
| [docs/STAGES.md](docs/STAGES.md) | The 5 build stages |

## Run it

Your Mac is the server, and only the Mac sees the Lab. Phones are the people: each one is a **Listener** or a **Contributor**.

### 1. Start it on the Mac

Double-click **PeerBeats** in this folder (or drag it into Applications first; it remembers where this folder is). It installs what's missing, starts the server and keeps the Mac awake. The first run takes about 2 minutes, because it generates the music. If macOS asks about your Desktop folder, click **Allow**. The Mac needs internet, because phones reach it through the phone link.

Its window shows a **QR code and link for phones**, and live lists of who is contributing and who is listening. **Open Lab** opens the Lab in your browser. Quitting the app stops everything. Keep the lid open: a sleeping Mac stops serving.

`Start PeerBeats.command` does the same in a Terminal window, if you prefer. It needs Node.js 20 or newer, from https://nodejs.org.

### 2. Join from each phone, anywhere

Phones can be anywhere: on any Wi-Fi, on mobile data, in another city. Nothing to install and no settings to change.

1. Scan the QR code in the Mac app with the phone's Camera, or send the link to a friend (**Copy Link**). It looks like `https://some-words.trycloudflare.com`.
2. PeerBeats opens on the phone, on the choice of **Listener** or **Contributor**.

The link changes each time PeerBeats starts, so send the new one after a restart. Phones then pick their role again.

When two phones can connect directly, the music goes straight between them. When they can't, as on most mobile data and many college networks, the contributor's phone sends it through PeerBeats' relay instead. Either way the music comes from the contributor's phone, encrypted, and the listener checks every piece. The listener's debug panel marks relayed pieces **(relayed)**, and the Monitor shows the total.

### 3. Choose a role

| Choice | What happens | Menu |
|---|---|---|
| **Listener** | Asked for a plan first. Type `admin` under **Have a code?** for a free monthly plan, and the songs appear. | Home, Search, Library, Plan, Account. Listening only. |
| **Contributor** | Lands on **Contribute**, and sharing starts by itself. That screen shows the music this phone holds, what it has delivered, and the **Money received**. A contributor can also browse and listen (playing needs a plan too). | Contribute, Home, Search, Library, Plan, Account |

Music only plays while at least one contributor is online with the app open. **Account** switches between listener and contributor, or signs out. A phone account has no password and lives on that phone, so signing out ends it.

### The Lab (your Mac only)

The Lab, its demo accounts and its data answer only on the Mac running PeerBeats. A phone that tries to open `/lab` is sent back to the music, and the server refuses its requests. On the Mac it has:

| On the Lab page | What it does |
|---|---|
| **Contributors A to E**, **Listeners 1 to 5**, **New Listener** | Test people in browser tabs, for trying things on one computer |
| **Monitor** | Contributors, listeners, bytes delivered between each pair, money, payouts, refused deliveries and events |
| **Phones, anywhere** | The phone link: the same QR code and link as the Mac app. **New link** replaces it if it was shared too widely, and **Turn off** shuts phones out |
| **Payments** | Razorpay test keys, if you have them |
| **Data** | Clears delivery records and payouts before the next demo |

### Demo accounts

All use the password `demo1234`. The Lab logs in for you. They only work on the Mac: through the phone link they're refused, so nobody outside can use the admin account.

| Role | Email |
|---|---|
| Listeners 1 to 5 | `listener@peerbeats.test`, then `listener2@` to `listener5@peerbeats.test` |
| Contributors A to E | `contributor.a@peerbeats.test` to `contributor.e@peerbeats.test` |
| New Listener, no plan | `new.listener@peerbeats.test` |
| Admin | `admin@peerbeats.test` |

## iPhone app with Xcode (optional)

Not needed: scanning the code works in Safari. The `ios` folder also holds an Xcode project that wraps PeerBeats in its own app and keeps the screen on while contributing. With a free Apple ID it lasts 7 days, then you press Run again.

1. Double-click `ios/PeerBeats.xcodeproj`.
2. Click **PeerBeats** at the top of the left sidebar, then **Signing & Capabilities**. Under **Team**, choose **Add an Account**, sign in with your Apple ID, and pick your **Personal Team**. If the bundle identifier is taken, change `com.yashv.peerbeats` to something unique.
3. Plug in the iPhone, unlock it and tap **Trust**. On the iPhone, turn on **Settings > Privacy & Security > Developer Mode**.
4. Choose your iPhone in Xcode's toolbar and press **Run**.
5. On the iPhone, trust your developer profile in **Settings > General > VPN & Device Management**.

In the app, tap **Scan QR code** and scan the code in the Mac app, or paste the link.

### What to know

- Phones need a secure address, because iOS only allows the hash checks and decryption on secure ones. The phone link is one, so there is nothing to set up.
- A phone stops sharing when its screen locks, because iOS suspends hidden pages. Keep contributor phones awake and plugged in.
- Listening needs iOS 17.1 or newer.

**Tested so far**, on simulated iPhones (iOS 27.2) with the server on this Mac, before the phone link replaced the Wi-Fi address:
- Phone A choosing **Contributor**: sharing started by itself, and Contribute showed the music held and the money received.
- Phone B choosing **Listener**: `admin` unlocked the plan and it played Glass Arcade, delivered entirely by phone A (674,283 bytes).
- Phone B opening `/lab` was sent back to the music, and the server refused the Lab to it.

**Tested in Chrome since:** two browsers with direct connections blocked, so the music could only go through the relay. It played, every segment came from the contributor and passed its hash check, and the contributor was credited.

**Not yet tried on a real iPhone:** the QR camera, the phone link on mobile data, and screen lock.

## Everyday features

- **Library:** press the heart on any song to like it, or the plus to add it to a playlist.
- **Adding music:** in the **Monitor** account, open **Catalog** and upload an MP3, WAV, FLAC, OGG or M4A of up to 50 MB. A license is required, and the file is checked from its contents, not its name. It goes to contributors straight away.
- **Sharing limits:** on **Share**, choose to share on Wi-Fi only, or to pause when the battery is low. Only some browsers report these, mainly Chrome on Android, and iPhones report neither. Where a browser can't, the option says so.

## Acceptance tests

**Earnings:** start two or more contributors, then a listener, and play 3 songs. On Monitor, press **Run payout now**. Each contributor's **Earned** rises, and together they match **Paid to contributors**.

**Paying:** open **New Listener** and try to play a song: you're told you need a plan. On **Plan**, enter the activation code `admin`, buy Monthly, and press **Pay**. The song now plays if a contributor is online.

**Failure:** close a contributor's tab, or lock the phone it's on. The music keeps playing. Close them all and it stops within about 30 seconds, then resumes by itself when one returns.

**Five and five:** open all 5 contributors and all 5 listeners. Everyone plays with no stalls.

## Payments

There are two ways to turn payments on. Neither moves real money.

**Activation code (no account needed).** On any account's **Plan** page, enter `admin`. This turns on a built-in test checkout for everyone, with no card details. Payments count towards revenue and are labelled as test payments on the Monitor. Change the code with `PORTAL_CODE` in `.env`. It only exists in demo mode, because the code is easy to guess.

**Razorpay test mode (a closer rehearsal).** Create a free account at https://dashboard.razorpay.com, switch to **Test Mode**, generate an API key, and paste it on the Lab page under **Payments**. It's saved only in `.env` on this laptop, and live keys are refused. Set payment capture to automatic in the Dashboard. Razorpay's window then replaces the built-in checkout.

| Razorpay test payment | Details |
|---|---|
| Card that succeeds | `4100 2800 0000 1007`, any future expiry, any CVV, any OTP of 4 to 10 digits |
| UPI that succeeds | `success@razorpay` |
| UPI that fails | `failure@razorpay` |

**Webhook, optional:** Razorpay's backup confirmation, for a buyer who closes the page mid-payment. Razorpay can't reach `localhost`, so it needs the phone link on. In the Dashboard, add `<phone link address>/api/payments/webhook` with the event `payment.captured`, and enter the same secret on the Lab page. The phone link's address changes each time. When Razorpay asks for an OTP in test mode, its docs give `754081`.

## How the money works

- **Plans:** Monthly costs ₹99 for 30 days. A credit pack costs ₹49 for 500 credits, and one credit plays one song. Replaying the same song within 10 minutes is free.
- **Receipts:** after a segment's hash matches, the listener sends a receipt. The server takes the size from the catalog, never from the claim.
- **Payouts:** contributors share 60% of net revenue, in proportion to verified bytes. Net means after Razorpay's fee, which is estimated at 2.36% because the real fee isn't known when a payment is verified.
- **Spreading:** each payment is paid out across 60 cycles of 60 seconds, so earnings rise steadily. A cycle only runs when there is both revenue and delivery. At launch, a cycle would become a month.
- **Whole paise only:** whatever can't be divided evenly carries into the next cycle. Each cycle is all-or-nothing, so every paisa is accounted for.
- **Refused receipts** are stored with their reason and shown on the Monitor, but never paid: paying yourself, a repeated report, a song the listener wasn't playing, a segment the contributor doesn't hold, a listener with no plan, the hourly limits (100 MB per pair, 150 MB per listener), and sharing a network with the listener.

Automated versions, with the server running:

```bash
npm run test:stage1
```

```bash
npm run test:stage2
```

```bash
npm run test:stage3
```

```bash
npm run test:stage4
```

```bash
npm run test:stage5
```

```bash
npm run test:five
```

```bash
npm run test:chrome
```

`test:stage3` needs no contributors online and takes about 90 seconds. `test:stage4` and `test:stage5` need no server or keys: each runs its own private copy on temporary data, and Stage 4 uses a fake Razorpay API. `test:five` runs 5 contributors and 5 listeners at once in real Chrome. `test:chrome` clicks through the whole product there, in about 5 minutes. Close every PeerBeats tab first: the tests that use your running server count everyone on the network.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Builds the web app |
| `npm run seed` | Creates demo users and any missing seed tracks |
| `npm start` | Starts the server |
| `npm run ingest -- ./song.mp3 --title "Name" --artist "Name" --license CC-BY` | Adds your own track. Stop the server first. Optional: `--album`, `--genre` |
| `npm run test:stage1`, `test:stage2`, `test:stage3`, `test:stage4`, `test:stage5`, `test:five`, `test:chrome` | Run the acceptance tests against the running server |

## Environment variables

Set in `.env`, which the launcher creates from `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4173` | Port for the server and web app |
| `JWT_SECRET` | random | Signs login tokens |
| `JWT_EXPIRES_IN` | `12h` | How long a login lasts |
| `DATABASE_URL` | empty | Empty uses built-in PGlite. Set it to use Postgres or Supabase. |
| `DEMO_MODE` | `true` | Enables the Lab page, demo accounts, phone link and the free-plan code. Set `false` outside a demo. |
| `PORTAL_CODE` | `admin` | The code that gives a listener a free monthly plan |
| `PHONE_LINK` | `on` | Starts the phone link with PeerBeats, in demo mode. `off` leaves it off until turned on in the Lab. |
| `PUBLIC_URL`, `TUNNEL_TOKEN` | empty | A permanent phone address on your own domain, served by a Cloudflare tunnel you set up |
| `HOST` | `127.0.0.1` in demo mode | What the server listens on. In a demo only this Mac and the phone link can reach it. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD` | empty | Optional TURN server, to carry relayed traffic instead of PeerBeats' own relay |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | empty | Razorpay test keys. The Lab page can set these for you. |
| `PAYOUT_CYCLE_SEC` | `60` | How often a payout runs |
| `REVENUE_CYCLES` | `60` | How many cycles each payment is spread across |
| `GATEWAY_FEE_PCT` | `2.36` | Razorpay's estimated fee |
| `PAIR_CAP_MB_PER_HOUR`, `LISTENER_CAP_MB_PER_HOUR` | `100`, `150` | Hourly limits on what can earn money |
| `REJECT_SHARED_IP` | off in demo mode, otherwise on | Refuses receipts when listener and contributor share an address |

## How delivery works

1. **Ingest:** ffmpeg splits audio into 5-second fragmented MP4 segments (AAC 128 kbps). Each is encrypted with AES-256-GCM and hashed.
2. **Contributors store:** the tracker keeps 5 online copies of every segment, or as many as there are contributors, assigning the least-replicated and most-played first and counting copies already on their way. When a contributor leaves, its copies are reassigned at once to anyone with space. Contributors download encrypted segments, verify each hash and keep them in IndexedDB. They never receive keys.
3. **Listeners connect:** the tracker says which peers hold which segments and relays WebRTC signaling. Browsers then talk directly. If a direct connection hasn't opened within about a second, as on most mobile networks, the listener also asks the tracker to relay, and uses whichever opens first. Relayed messages are the same encrypted pieces, sent by the contributor's phone, and the tracker only forwards them to the listener who asked.
4. **Fetch:** up to 3 segments download at once, keeping 20 seconds buffered. Each request goes to a connected contributor chosen at random, weighted by recent success, speed and how busy it is, and moves to the next if that contributor sends nothing for 2.5 seconds (4 through the relay). If under 5 seconds of audio remains, the next segment goes to two contributors at once and the first good answer wins.
5. **Verify:** each segment's SHA-256 must match the manifest. A bad copy is reported, and that contributor checks it and replaces it from the server.
6. **Play:** segments are decrypted in memory and appended through Media Source Extensions.
7. **Failure:** a contributor that closes is noticed at once. One that freezes without disconnecting is noticed within 4 seconds, because listeners ping it every 1.5 seconds. The tracker separately removes any contributor that misses its heartbeats for 45 seconds, and any that serves 5 damaged copies. Removed contributors check everything they hold and rejoin.
8. **No contributors:** the player keeps checking every few seconds, shows why it's silent, and continues by itself when one returns.

## Changes from the master prompt

- **Database:** uses PGlite, which is real Postgres compiled to WebAssembly, so nothing needs installing. Set `DATABASE_URL` to use a normal Postgres server.
- **Music:** the 20 seed tracks are generated by `server/scripts/synth.ts` from numbers alone, not downloaded. PeerBeats owns them and they are marked CC0.
- **No server fallback for listeners:** the prompt promises that "playback never fails" through a central fallback (sections 3, 5, 10.4 and 17). This was changed on purpose: the server refuses to send music to listeners, and only supplies sharing contributors with what they were assigned. The trade-off is listed under limits below.
- **Same-network rule:** the prompt says to reject receipts when listener and contributor share an IP. In a lab everyone shares one, so every delivery would be refused. The rule is off in demo mode, on otherwise, and its state is shown on the Monitor.
- **Razorpay's API is called directly** rather than through its Node SDK. Only one call is needed, and this lets the tests run against a stand-in.
- **Demo plans:** in demo mode, each of Listeners 1 to 5 buys a monthly plan on the test checkout when PeerBeats is set up. Every plan has a payment behind it, so revenue matches subscribers: 5 plans, ₹495. Test payments have no gateway fee, because no gateway was involved. Spread over 60 payouts, this keeps earnings rising for about an hour of playback.
- **Two storage copies:** the server keeps a `hot` copy, which can be damaged, and a protected `origin` copy, which contributors recover from.
- **Brought forward:** the Lab page, phone link and Monitor were planned for Stage 5, and arrived in Stage 2 to make the demo easy to run.

## Honest limits so far

- **Track keys are not DRM.** A listener's browser has to hold the key to play the music, so a determined listener could extract it. The prompt calls the key "short-lived", but in this design it is a fixed per-track key delivered only to logged-in users.
- **iPhones** need iOS 17.1 or newer, which added `ManagedMediaSource`. Older iPhones cannot use this player.
- **Phones need HTTPS.** Hash checks and decryption need a secure page. The phone link uses a Cloudflare quick tunnel for this. It needs internet, its address changes each time PeerBeats starts, and it is restarted by itself if it stops answering.
- **The phone link is public while on.** Anyone with its address can open PeerBeats, make an account and use the free-plan code. The demo accounts and the Lab are refused through it. Only the Mac can turn it off or replace it.
- **Music stops when contributors do.** With no fallback, a song plays only while someone holding it is online. Phones can't share in the background, because Android and iOS suspend background tabs, so a locked phone counts as offline. A real launch needs enough always-on contributors, or songs will often be unavailable.
- **The relay goes through the Mac.** When two phones can't connect directly, their pieces pass through the server and the tunnel. It is still peer delivery (the contributor sends, the listener checks), but it uses the Mac's internet, and it is slower than a direct connection.
- **Receipts are the listener's word.** A paying listener could confirm deliveries that never happened, to favour a friend. Plans, hourly limits and checks reduce this but don't stop it. Because contributors share one pool, fake deliveries would take money from honest contributors, so this must be addressed before real payouts.
- **Peer scores are also reported by listeners.** Each listener is limited to 6 failure reports per contributor per minute, and removing a contributor takes reports from 2 different listeners. Two accounts working together could still do it.
- **Earnings are simulated rupees.** Nothing is paid out. Real payouts need Razorpay Route or RazorpayX, and KYC checks on contributors.
- **Installing needs a permanent address.** An installed app stays tied to one address, and the phone link gets a new one each time PeerBeats starts. For a Home Screen app that lasts, set `PUBLIC_URL` and `TUNNEL_TOKEN` to a Cloudflare tunnel on your own domain.
- **A phone account lives on that phone.** Choosing listener or contributor on the start screen makes an account with no email or password. Signing out, or deleting the app's data, ends it.
- **Offline, the app opens but nothing plays.** Music isn't stored for offline listening, because a song's key is never written to storage.
- **The track key isn't revoked.** Someone whose plan expires keeps the keys for songs already loaded, until the page closes.
- **Webhooks don't work on `localhost`,** so on a laptop the browser's verification call is what activates a plan. If a buyer pays and closes the page at that exact moment, they'd be charged with no plan unless the webhook is set up.
- **Replication counts online copies only.** Three people holding a song doesn't help if all three are offline, so a song's real availability depends on who is online.

## Troubleshooting

| Problem | Fix |
|---|---|
| "The database is in use by process N" | Another PeerBeats process is running. Close its Terminal window, or run `kill N`. |
| No sound | Check the volume in the player and your Mac's output. Open the debug panel to confirm segments are arriving. |
| "Cannot reach the PeerBeats server" | The Terminal window was closed. Double-click **Start PeerBeats** again. |
| "You need a plan to listen" | On **Plan**, enter the activation code `admin`, then buy one. |
| A page looks out of date after an update | Close every PeerBeats tab and open it again. The new version takes effect then. |
| Earnings stopped rising | The test payments have been fully paid out. Buy a plan on the test checkout to add revenue. |
| "No contributors are online with this song" | Start a contributor and wait for it to finish storing. Phones that can't connect directly switch to the relay within a few seconds by themselves. |
| A role opens in the same tab | Your browser blocked the pop-up. Allow pop-ups for this site. |
| Start again from nothing | Stop the server, delete the `data` and `storage` folders, and double-click **Start PeerBeats**. |
| Logged out unexpectedly | Logins last 12 hours, and deleting `.env` also invalidates them. |
