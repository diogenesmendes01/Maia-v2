-- Down da 114.
DROP INDEX IF EXISTS bootstrap_credentials_expiry_idx;
DROP INDEX IF EXISTS bootstrap_credentials_single_live_uq;
DROP TABLE IF EXISTS bootstrap_credentials;
