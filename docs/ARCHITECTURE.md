# PeerBeats: architecture note

**PeerBeats is a music streaming system in which listeners' subscriptions fund the network and contributors' devices deliver the music.** Contributors lend browser storage and bandwidth and earn a share of revenue for what they verifiably deliver. The central server coordinates, and never sends music to a listener.

```
[Listener browser] <== WebRTC data channels ==> [Contributor browsers]
        |                                                |
        |  Socket.IO and HTTPS                           |  downloads what it's assigned
        +---------------------+--------------------------+
                              |
                       [Node.js server]
        tracker, signaling, catalog, ledger, payments
                 |                       |
           [PostgreSQL]        [Encrypted master copies]
                              |
                    [Razorpay, test mode]
```

## How a song reaches a listener

1. **Ingest.** ffmpeg splits audio into 5-second fragmented MP4 segments. Each is encrypted with AES-256-GCM using a per-track key, then hashed with SHA-256.
2. **Replication.** The tracker keeps 5 online copies of every segment, or as many as there are contributors, prioritising the least-replicated and most-played. When a contributor leaves, its copies are reassigned at once. Contributors receive encrypted bytes and hashes, and never a key.
3. **Permission.** A listener with an active plan gets the manifest: each segment's hash and size, and the track key. The key is held only in memory.
4. **Connection.** Phones reach the server through the phone link, a secure Cloudflare address that works from any network. The tracker passes on WebRTC signaling, then phones talk directly over data channels. When they can't, as on most mobile networks, the tracker relays their messages instead: the same encrypted pieces, sent by the contributor and checked by the listener.
5. **Delivery.** Up to 3 segments download at once, keeping 20 seconds buffered. Each request goes to the best contributor, judged by recent success, speed and load. If under 5 seconds remain, the segment goes to two contributors at once.
6. **Verification.** A segment is trusted only if its SHA-256 matches the manifest. A bad copy is reported and replaced.
7. **Playback.** Segments are decrypted in memory and played through Media Source Extensions.
8. **Payment.** After each verified segment, the listener sends the server a receipt.

## Design decisions

| Decision | Why | What it costs |
|---|---|---|
| **Peers only, with no server fallback** | Contributors have to genuinely matter, and delivery costs stay with the network | With no contributors online, music stops. It resumes by itself when one returns. |
| **Hash every segment and check it against the server's manifest** | Contributors aren't trusted, so a damaged or malicious copy must never reach the player | A small amount of processing per segment |
| **Encrypt before distributing** | Contributors can hold music without being able to play it | Listeners must still receive a key, so this isn't DRM |
| **Relay through the tracker when phones can't connect directly** | Most mobile networks block direct connections, and phones must work anywhere | Relayed music passes through the Mac's internet connection, and is slower |
| **Detect silence as well as disconnection** | A locked phone stays connected but stops answering. Listeners ping every 1.5 s | A little extra traffic |
| **Whole paise, all-or-nothing payout cycles** | Every paisa is accounted for, and a failure can't half-pay | Rounding leftovers wait for the next cycle |
| **Keep refused receipts with their reason** | Anti-cheat decisions can be audited | More stored data |

## Failure handling

| Failure | Detected | Response |
|---|---|---|
| Contributor closes | At once | Waiting requests move to another contributor, and copies are rebuilt |
| Contributor freezes, such as a locked phone | Within about 4 s by listeners, and within 60 s by the tracker | Same, and it rejoins when it returns |
| Damaged copy | At the hash check | Next contributor is tried, and the bad one repairs itself |
| Every contributor gone | At once | Plays what's buffered, explains why it stopped, and resumes by itself |
| Server unreachable | Within seconds | A banner explains, and it reconnects by itself |

## Technology

Vite, React and TypeScript with Tailwind and Zustand on the web. Node.js, Express and Socket.IO on the server. PostgreSQL, through PGlite on a laptop or any Postgres server when hosted. WebRTC data channels, IndexedDB and Media Source Extensions in the browser. ffmpeg for audio. Razorpay in test mode for payments.
