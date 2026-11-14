-- PeerBeats schema. Safe to run repeatedly.
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  display_name text not null,
  is_contributor boolean default false,
  is_admin boolean default false,
  created_at timestamptz default now()
);

create table if not exists tracks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  artist text not null,
  album text,
  genre text,
  duration_sec int not null,
  cover_url text,
  license text not null,            -- e.g. CC-BY, CC0
  segment_count int not null,
  init_segment_hash text not null,
  play_count int not null default 0,
  created_at timestamptz default now()
);

create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  track_id uuid references tracks(id) on delete cascade,
  idx int not null,                 -- 0 = init segment, 1..n = media segments
  sha256 text not null,             -- hash of the ENCRYPTED bytes
  size_bytes int not null,
  start_time_sec numeric,
  unique (track_id, idx)
);

create table if not exists track_keys (
  track_id uuid primary key references tracks(id) on delete cascade,
  aes_key bytea not null            -- never sent to contributors
);

create table if not exists peer_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  socket_id text,
  storage_quota_mb int,
  connected_at timestamptz default now(),
  last_seen timestamptz default now()
);

create table if not exists peer_chunks (
  peer_session_id uuid references peer_sessions(id) on delete cascade,
  chunk_id uuid references chunks(id) on delete cascade,
  primary key (peer_session_id, chunk_id)
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  plan text not null,               -- 'monthly' | 'credits'
  status text not null,             -- 'active' | 'expired'
  starts_at timestamptz,
  ends_at timestamptz
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  razorpay_order_id text,
  razorpay_payment_id text,
  amount_paise int not null,
  status text not null,
  created_at timestamptz default now()
);

create table if not exists transfer_receipts (
  id uuid primary key default gen_random_uuid(),
  contributor_id uuid references users(id),
  listener_id uuid references users(id),
  chunk_id uuid references chunks(id),
  bytes int not null,
  verified boolean default false,   -- listener confirmed hash OK
  created_at timestamptz default now(),
  unique (contributor_id, listener_id, chunk_id, created_at)
);

create table if not exists credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  delta numeric not null,           -- + earned, - spent
  reason text not null,             -- 'serve_bytes' | 'payout' | 'purchase'
  ref_id uuid,
  created_at timestamptz default now()
);

create table if not exists playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  name text not null
);

create table if not exists playlist_tracks (
  playlist_id uuid references playlists(id) on delete cascade,
  track_id uuid references tracks(id),
  position int not null,
  primary key (playlist_id, track_id)
);

create index if not exists peer_chunks_chunk_idx on peer_chunks (chunk_id);
create index if not exists receipts_contributor_idx on transfer_receipts (contributor_id, verified);

-- Stage 4: money. Amounts are whole paise, so nothing is lost to rounding.
create table if not exists payout_cycles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  revenue_paise int not null,       -- net revenue recognised this cycle
  pool_share_paise int not null,    -- contributors' share of that revenue
  platform_paise int not null,      -- the platform's share of that revenue
  carry_in_paise int not null,      -- rounding left over from the last cycle
  paid_paise int not null,
  carry_out_paise int not null,
  total_bytes bigint not null
);

alter table payments add column if not exists plan text;
alter table payments add column if not exists source text not null default 'razorpay';
alter table payments add column if not exists net_paise int not null default 0;
alter table payments add column if not exists recognized_paise int not null default 0;
alter table payments add column if not exists captured_at timestamptz;
create unique index if not exists payments_order_idx on payments (razorpay_order_id);

create table if not exists payment_events (
  event_id text primary key,
  received_at timestamptz default now()
);

alter table transfer_receipts add column if not exists payable boolean not null default true;
alter table transfer_receipts add column if not exists reject_reason text;
alter table transfer_receipts add column if not exists cycle_id uuid references payout_cycles(id);
create index if not exists receipts_pair_idx on transfer_receipts (contributor_id, listener_id, created_at);
create index if not exists receipts_listener_idx on transfer_receipts (listener_id, created_at);
create index if not exists receipts_unsettled_idx on transfer_receipts (cycle_id, payable);
create index if not exists ledger_user_idx on credit_ledger (user_id, reason);

-- Stage 5: library.
create table if not exists liked_tracks (
  user_id uuid references users(id) on delete cascade,
  track_id uuid references tracks(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, track_id)
);
create index if not exists playlists_user_idx on playlists (user_id);

-- Settings an admin can change while the app runs.
create table if not exists app_settings (
  key text primary key,
  value text not null
);
