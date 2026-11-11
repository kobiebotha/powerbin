CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  public_key TEXT NOT NULL,
  shared_key_envelope TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pairing_sessions (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  device_id UUID NOT NULL UNIQUE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('transfer', 'saved', 'link')),
  sender_id UUID NOT NULL REFERENCES devices(id),
  recipient_id UUID REFERENCES devices(id),
  payload TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  burned_at TIMESTAMPTZ,
  burn_reason TEXT CHECK (burn_reason IN ('consumed', 'expired', 'deleted')),
  CHECK ((kind = 'transfer') = (recipient_id IS NOT NULL)),
  CHECK ((kind = 'saved') = (expires_at IS NULL)),
  CHECK (
    (burned_at IS NULL AND burn_reason IS NULL AND payload IS NOT NULL) OR
    (burned_at IS NOT NULL AND burn_reason IS NOT NULL AND payload IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS items_recipient ON items(recipient_id);
CREATE INDEX IF NOT EXISTS items_sender ON items(sender_id);
CREATE INDEX IF NOT EXISTS items_expiry ON items(expires_at) WHERE burned_at IS NULL;
