CREATE TABLE IF NOT EXISTS agapay_app_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agapay_imported_datasets (
  dataset_name text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  imported_at timestamptz NOT NULL DEFAULT now()
);
