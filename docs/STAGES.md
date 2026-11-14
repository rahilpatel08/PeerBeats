# The 5 build stages

The master prompt lists 7 phases. They are grouped into 5 stages. There is one launcher for all of them: `Start PeerBeats.command`.

| Stage | Master prompt phases | What it adds | Acceptance test |
|---|---|---|---|
| 1 (done) | 1, 2 | Login, catalog, search, ingestion, encryption, fallback seeder, full player, debug panel | Search, play a whole track from the server, seek. A tampered segment is detected and replaced. |
| 2 (done) | 3 | Tracker, signaling, WebRTC, IndexedDB chunk store, Share page. Brought forward from Stage 5: Lab page, phone link, live Monitor | With 2 contributor tabs open, the debug panel shows chunks arriving from peers. |
| 3 (done) | 4 | Peer scoring, retries, racing two peers when low, replication rebuild, heartbeat cleanup, frozen-peer detection | Close a contributor tab mid-song. Playback continues with no audible gap. |
| 4 (done) | 5, 6 | Receipts, anti-cheat, payout job, earnings, Razorpay test mode, subscription gating, Lab page key setup | Contributor earnings match server records. An unsubscribed user is blocked until a test payment. |
| 5 (done) | 7 | Track upload, playlists and library, app install, share-on-Wi-Fi-only and battery limits, offline and outage messages, final documents | The full 8-minute demo script runs without errors. |

## Decisions that change the master prompt

- **Peers only.** The server never delivers music to listeners. With no contributors, music stops and resumes by itself when one returns. So in Stage 3, closing one contributor must not interrupt the music, and closing the last one stops it.
- **Up to 5 contributors and 5 listeners** on the Lab page, with 5 copies of each song, so every contributor delivers.
- **Payment portal:** the code `admin` turns on a built-in test checkout, in demo mode only.
- **Launch follows Stage 5.** Public hosting, removing demo accounts, live payments and music licensing come after all stages are finished.
- **Before real payouts:** receipts are the listener's word, and contributors share one pool. Decide how to stop fake deliveries, for example by paying each contributor only from the money of the listeners they served.
