-- 009_settings_mode_default: `allow_personal_teams` becomes "null means the mode default" (private: false, public: true).
-- 001_core seeded an explicit false for every mode, which would also pin public deployments. Mode independent: private mode
-- resolves null to false, so its behaviour does not change. An explicit true is kept.
UPDATE platform_settings SET value = 'null'::jsonb WHERE key = 'allow_personal_teams' AND value = 'false'::jsonb;
