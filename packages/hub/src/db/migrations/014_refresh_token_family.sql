-- 014_refresh_token_family: group refresh tokens into families (one per login) and mark rotations explicitly.
--
-- Replaying a rotated refresh token used to revoke every session of the account, so two browser tabs refreshing with the same stored
-- token logged the user out everywhere. Tokens now carry a family id: a login starts a family, every rotation stays in it, and reuse
-- revokes only that family. Existing rows each become a family of their own.
--
-- `rotated_at` is set only when a token is exchanged for its successor. Revocation by logout, password reset, disable or a reuse
-- detection sets `revoked_at` alone, so a revoked token can never be mistaken for a just-rotated one inside the reuse grace window.

ALTER TABLE refresh_tokens ADD COLUMN family_id text;
ALTER TABLE refresh_tokens ADD COLUMN rotated_at timestamptz;
UPDATE refresh_tokens SET family_id = id;
-- Before this migration a rotation left `expires_at` after `revoked_at`, while logout pinned them together.
UPDATE refresh_tokens SET rotated_at = revoked_at WHERE revoked_at IS NOT NULL AND expires_at > revoked_at;
ALTER TABLE refresh_tokens ALTER COLUMN family_id SET NOT NULL;
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
