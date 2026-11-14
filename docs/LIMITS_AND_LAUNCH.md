# Known limits, future work and launch checklist

## Not yet proven

These haven't been tested, because they need something only a person can provide:

| What | Why it's untested | How to test it |
|---|---|---|
| Real Razorpay payments | Needs your test keys. The built-in checkout works without them, but is not Razorpay. | Add keys on the Lab page and buy a plan |
| The phone link with real phones | Tests use a stand-in address, so nothing is opened to the internet by a test | Start PeerBeats and open its link on a phone on mobile data |
| Real phones, iPhones and Safari | Chrome on a Mac, plus the Xcode app and the Home Screen app on two iOS 27.2 simulators | Try each role on a real phone |
| Your venue's network | Everything ran on one computer, at millisecond speeds | Run the demo there beforehand |
| How the music sounds | It's checked by measurement only | Listen to it |

## Known limits

**Delivery**
- Music stops when no contributor holding it is online. This was a deliberate choice over a server fallback.
- Phones can't share in the background, because Android and iOS suspend hidden tabs. A locked phone counts as offline.
- Phones that can't connect directly get music through the relay, which passes through the Mac and its internet connection. It is slower than direct.
- Someone sharing a song can't play their own stored copy, so a contributor alone on the network hears nothing.

**Money**
- Receipts are the listener's word. A paying listener could confirm deliveries that never happened. Plans, hourly limits and checks reduce this but don't stop it, and in a shared pool it takes money from honest contributors.
- Earnings are simulated rupees. Nothing is paid out.
- Contributors don't earn exactly evenly. Each request goes to a contributor chosen at random, weighted towards reliable, fast and less busy ones, so better contributors deliver and earn somewhat more.
- Razorpay's fee is an estimate of 2.36%. Test payments have no fee.
- A buyer who pays and closes the page at that exact moment gets no plan, unless the webhook is set up. Webhooks can't reach a laptop.

**Security**
- The track key isn't DRM. A determined listener can extract it from their own browser.
- A key isn't revoked when a plan ends, until the page closes.
- Peer scores are reported by listeners. Two accounts working together could force a contributor to rejoin.
- The free-plan code is open to anyone with the phone link, and `admin` is easy to guess. The demo accounts and the Lab only work on the Mac. Keep `DEMO_MODE` on only for demos.

**Catalog**
- A track can't be removed once added, which a real service needs for takedowns. Payment records refer to its segments, so this needs a careful design.
- Uploads aren't checked for copyright. The uploader's declaration and license field are the only safeguards.

## Future work

Native apps for background sharing, always-on desktop contributors, a TURN relay, real payouts, delivery proof from both sides of a transfer, per-listener revenue allocation, licensed catalog, offline listening with proper DRM, recommendations, playlist reordering and sharing, track takedowns, and account recovery.

## Launch checklist

Do these in order. Each needs your decision, an account or legal advice.

**1. Decide the model**
- [ ] **Fix fake deliveries first.** I recommend paying each contributor only from the money of the listeners they served, instead of one shared pool. Fake deliveries would then only spend the cheater's own money.
- [ ] **Plan for contributor supply.** With few contributors, most songs often show "Can't play now". Consider always-on desktop contributors or rewards for staying online, or revisit a limited server fallback.

**2. Host it**
- [ ] Choose a host, such as Render or Railway, and a permanent domain with HTTPS. Your own account is needed.
- [ ] Move to hosted Postgres by setting `DATABASE_URL`. PGlite is for one laptop only.
- [ ] Store master copies somewhere durable. Hosts often wipe local disks, and `storage/` holds them today.
- [ ] Set `DEMO_MODE=false`. This removes the Lab page, one-tap accounts, the free-plan code, the phone link and the built-in test checkout, and turns on the same-network rule. Start with a fresh database, so the demo accounts and their public password don't exist.
- [ ] Create your admin account: sign up normally, then set `is_admin` on it in the database. Demo mode's admin account won't exist.
- [ ] Set a new `JWT_SECRET`, and shorten `JWT_EXPIRES_IN`.
- [ ] Run exactly one server process, because payouts and the live tracker aren't built to run on several.
- [ ] Set up backups and monitoring, and check rate limits work behind the host's proxy.
- [ ] Set up a TURN relay.

**3. Accounts**
- [ ] Add email verification and password reset.
- [ ] Add terms of service and a privacy policy.

**4. Real money. Get legal and tax advice first.**
- [ ] Complete Razorpay KYC and move to live keys. The code refuses live keys today, and that guard must be deliberately removed.
- [ ] Measure Razorpay's real fee rather than estimating.
- [ ] Set up the webhook on the permanent domain.
- [ ] Set up contributor payouts with Razorpay Route or RazorpayX, with KYC for each contributor.
- [ ] Set payout cycles to monthly with `PAYOUT_CYCLE_SEC` and `REVENUE_CYCLES`.
- [ ] Check no seed or test payments are in the live database.
- [ ] Add refunds and cancellations.

**5. Music. Get legal advice first.**
- [ ] License any catalog you don't own. Streaming copyrighted music needs agreements with rights holders.
- [ ] Add a way to take down a track and handle copyright complaints.
- [ ] Be aware that contributors would store and send music. Get advice on what that means for them.
