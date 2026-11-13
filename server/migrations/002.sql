ALTER TABLE devices ADD COLUMN IF NOT EXISTS admission TEXT;
ALTER TABLE pairing_sessions ADD COLUMN IF NOT EXISTS approver_id UUID REFERENCES devices(id);
ALTER TABLE pairing_sessions ADD COLUMN IF NOT EXISTS messages JSONB NOT NULL DEFAULT '[]'::jsonb;
