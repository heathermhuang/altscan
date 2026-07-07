-- Copy to seed.local.sql (gitignored) and replace ALL_CAPS placeholders.
-- Render service/DB IDs: Render dashboard (or local CLAUDE.md ops notes).
INSERT INTO tenants (id, name, slug) VALUES ('altscan', 'Altscan', 'altscan');

INSERT INTO members (tenant_id, email, role)
VALUES ('altscan', 'OWNER_EMAIL', 'owner');

INSERT INTO explorers (id, tenant_id, key, brand, public_url, origin_url,
                       render_web_id, render_indexer_id, render_db_id,
                       admin_secret_binding, status)
VALUES
  ('bnb', 'altscan', 'bnb', 'BNBScan', 'https://bnbscan.com',
   'https://bnbscan-web.onrender.com',
   'SRV_WEB_BNB', 'SRV_INDEXER_BNB', 'DPG_DB_BNB', 'ADMIN_SECRET_BNB', 'live'),
  ('eth', 'altscan', 'eth', 'EthScan', 'https://ethscan.io',
   'https://ethscan-web.onrender.com',
   'SRV_WEB_ETH', 'SRV_INDEXER_ETH', 'DPG_DB_ETH', 'ADMIN_SECRET_ETH', 'live');
