PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  whatsapp_phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  can_manage_bookings INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_owner_only ON admins(role) WHERE role='owner';
CREATE TABLE IF NOT EXISTS invitations (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  whatsapp_phone TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES admins(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  customer_token_hash TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL CHECK(language IN ('en','es')),
  tour_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  party_json TEXT NOT NULL,
  tour_name TEXT NOT NULL,
  addons_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  total_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  balance_due_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('requested','alternative_offered','declined','approved','deposit_paid','confirmed','completed','cancelled','operator_cancelled','refund_pending','refunded')),
  reschedule_used INTEGER NOT NULL DEFAULT 0,
  original_tour_date TEXT NOT NULL,
  reschedule_credit_until TEXT,
  stripe_deposit_session TEXT,
  stripe_balance_session TEXT,
  deposit_paid_at INTEGER,
  balance_paid_at INTEGER,
  balance_reminder_sent_at INTEGER,
  trip_reminder_sent_at INTEGER,
  customer_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_date_status ON reservations(tour_date,status);
CREATE INDEX IF NOT EXISTS reservations_due ON reservations(balance_due_at,status);
CREATE TABLE IF NOT EXISTS reserved_dates (
  tour_date TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reservation_events (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  actor_id TEXT,
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  reservation_id TEXT REFERENCES reservations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('email','whatsapp')),
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed','skipped')),
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_status_created ON notification_outbox(status,created_at);
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reservation_refunds (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  payment_kind TEXT NOT NULL CHECK(payment_kind IN ('deposit','balance')),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(reservation_id,payment_kind)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_date ON reserved_dates(tour_date);
