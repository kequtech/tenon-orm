CREATE TABLE account (
  id uuid PRIMARY KEY, status varchar(24) NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE passwordless_challenge (
  id uuid PRIMARY KEY, normalized_email varchar(254) NOT NULL,
  canonical_email varchar(254) NOT NULL, account_id uuid REFERENCES account(id),
  purpose varchar(24) NOT NULL CHECK(purpose IN ('authenticate','link_email')),
  code_hash text NOT NULL, attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL, expires_at timestamptz NOT NULL,
  consumed_at timestamptz, created_at timestamptz NOT NULL
);
CREATE TABLE private_email (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES account(id),
  normalized_email varchar(254) NOT NULL, canonical_email varchar(254) UNIQUE NOT NULL,
  verified_at timestamptz NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE authentication_method (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES account(id),
  provider varchar(24) NOT NULL, provider_subject text NOT NULL,
  private_email_id uuid REFERENCES private_email(id),
  created_at timestamptz NOT NULL, revoked_at timestamptz,
  UNIQUE(provider,provider_subject)
);
INSERT INTO account VALUES
  ('60000000-0000-4000-8000-000000000001','active','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
