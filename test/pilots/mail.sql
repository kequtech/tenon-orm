CREATE TABLE address (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, label text,
  prefer_text boolean NOT NULL DEFAULT false,
  load_remote_images boolean NOT NULL DEFAULT false, deleted_at timestamptz
);
CREATE TABLE envelope (
  id uuid PRIMARY KEY, address_id uuid REFERENCES address(id),
  address_name text, address_local text NOT NULL, address_domain text NOT NULL
);
CREATE TABLE message (
  id uuid PRIMARY KEY, envelope_id uuid NOT NULL REFERENCES envelope(id),
  subject text, text text NOT NULL, html text, created_at timestamptz NOT NULL
);
CREATE TABLE address_message (
  id uuid PRIMARY KEY, address_id uuid NOT NULL REFERENCES address(id),
  message_id uuid NOT NULL REFERENCES message(id),
  is_important boolean NOT NULL DEFAULT false, is_read boolean NOT NULL DEFAULT false,
  deleted_at timestamptz
);

-- Both users have matching messages. The deleted mailbox is also owned by the
-- first user: neither matching search text nor an exact id may bypass ownership.
INSERT INTO address VALUES
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Inbox',false,false,NULL),
  ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','Other',false,false,NULL),
  ('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','Deleted',false,false,'2026-10-01T00:00:00Z');
INSERT INTO envelope VALUES
  ('30000000-0000-4000-8000-000000000001',NULL,'External','sender','example.invalid'),
  ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Internal','internal','myaddress.cc');
INSERT INTO message VALUES
  ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','Match one','body 100%_ literal',NULL,'2026-10-01T12:00:00Z'),
  ('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','Match two','body two','<p>two</p>','2026-10-01T12:00:00Z'),
  ('40000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000001','Trash','body three',NULL,'2026-09-30T12:00:00Z');
INSERT INTO address_message VALUES
  ('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',false,false,NULL),
  ('50000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002',true,true,NULL),
  ('50000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003',false,false,'2026-10-01T00:00:00Z'),
  ('50000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001',true,false,NULL),
  ('50000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000001',true,false,NULL);
