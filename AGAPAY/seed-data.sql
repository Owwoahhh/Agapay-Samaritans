BEGIN;

CREATE TABLE IF NOT EXISTS agapay_app_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO agapay_app_state (id, state)
VALUES (
  1,
  jsonb_build_object(
    'version', 2,
    'currentUser', NULL,
    'settings', jsonb_build_object(
      'orgName', 'Agapay Samaritans',
      'currency', 'PHP',
      'notifications', true
    ),
    'donors', '[]'::jsonb,
    'donations', '[]'::jsonb,
    'receipts', '[]'::jsonb,
    'users', '[]'::jsonb,
    'audit', '[]'::jsonb
  )
)
ON CONFLICT (id) DO NOTHING;

WITH donor_seed (id, name, email, phone, type) AS (
  VALUES
    ('DNR-9001', 'Sample Donor 01', 'donor01@example.test', '+63 900 000 0001', 'Individual'),
    ('DNR-9002', 'Sample Donor 02', 'donor02@example.test', '+63 900 000 0002', 'Individual'),
    ('DNR-9003', 'Sample Donor 03', 'donor03@example.test', '+63 900 000 0003', 'Organization'),
    ('DNR-9004', 'Sample Donor 04', 'donor04@example.test', '+63 900 000 0004', 'Individual'),
    ('DNR-9005', 'Sample Donor 05', 'donor05@example.test', '+63 900 000 0005', 'Organization'),
    ('DNR-9006', 'Sample Donor 06', 'donor06@example.test', '+63 900 000 0006', 'Individual'),
    ('DNR-9007', 'Sample Donor 07', 'donor07@example.test', '+63 900 000 0007', 'Individual'),
    ('DNR-9008', 'Sample Donor 08', 'donor08@example.test', '+63 900 000 0008', 'Organization'),
    ('DNR-9009', 'Sample Donor 09', 'donor09@example.test', '+63 900 000 0009', 'Individual'),
    ('DNR-9010', 'Sample Donor 10', 'donor10@example.test', '+63 900 000 0010', 'Individual')
),
donor_payload AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'name', name,
      'email', email,
      'phone', phone,
      'type', type,
      'createdAt', current_date::text
    ) ORDER BY id
  ) AS items
  FROM donor_seed
),
donation_seed (id, donor_id, program, channel, status, reference, date, amount_cents) AS (
  SELECT
    'DNT-9' || right(donor_id, 4),
    donor_id,
    program,
    channel,
    status,
    'SAMPLE-TEST-' || right(donor_id, 4),
    current_date - floor(random() * 60)::integer,
    floor(random() * 490000 + 10000)::integer
  FROM (
    VALUES
      ('DNR-9001', 'Health', 'GCash', 'pending'),
      ('DNR-9002', 'Education', 'Bank transfer', 'verified'),
      ('DNR-9003', 'Disaster Preparedness', 'Cash', 'pending'),
      ('DNR-9004', 'Community Profiling', 'Check', 'rejected'),
      ('DNR-9005', 'Unrestricted', 'PayPal', 'verified'),
      ('DNR-9006', 'Health', 'Cash', 'pending'),
      ('DNR-9007', 'Education', 'GCash', 'verified'),
      ('DNR-9008', 'Disaster Preparedness', 'Bank transfer', 'pending'),
      ('DNR-9009', 'Community Profiling', 'PayPal', 'rejected'),
      ('DNR-9010', 'Unrestricted', 'Check', 'verified')
  ) AS seed(donor_id, program, channel, status)
),
donation_payload AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'donorId', donor_id,
      'amountCents', amount_cents,
      'date', date::text,
      'program', program,
      'channel', channel,
      'reference', reference,
      'evidence', 'Synthetic sample record for testing only.',
      'status', status,
      'eligible', true,
      'verifiedAt', CASE WHEN status = 'verified' THEN date::text ELSE '' END,
      'note', CASE WHEN status = 'rejected' THEN 'Synthetic sample rejection.' ELSE '' END
    ) ORDER BY id
  ) AS items
  FROM donation_seed
)
UPDATE agapay_app_state AS app
SET state = jsonb_set(
  jsonb_set(
    app.state,
    '{donors}',
    COALESCE(app.state->'donors', '[]'::jsonb) ||
      COALESCE((
        SELECT jsonb_agg(candidate.item ORDER BY candidate.item->>'id')
        FROM donor_payload
        CROSS JOIN LATERAL jsonb_array_elements(donor_payload.items) AS candidate(item)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(app.state->'donors', '[]'::jsonb)) AS existing(item)
          WHERE existing.item->>'id' = candidate.item->>'id'
        )
      ), '[]'::jsonb),
    true
  ),
  '{donations}',
  COALESCE(app.state->'donations', '[]'::jsonb) ||
    COALESCE((
      SELECT jsonb_agg(candidate.item ORDER BY candidate.item->>'id')
      FROM donation_payload
      CROSS JOIN LATERAL jsonb_array_elements(donation_payload.items) AS candidate(item)
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(app.state->'donations', '[]'::jsonb)) AS existing(item)
        WHERE existing.item->>'id' = candidate.item->>'id'
      )
    ), '[]'::jsonb),
  true
)
WHERE app.id = 1;

COMMIT;
