-- 013_credit_reservations: credits held for in-flight model calls.
--
-- The LLM proxy used to compare the balance with the estimated cost and charge only after the response, so concurrent requests
-- could all pass the check and overspend. A call now reserves its estimated cost first; the balance check counts the live
-- reservations of the subject. A reservation is deleted when the call is charged (commit) or fails (release); one that was
-- orphaned (crashed process, lost connection) stops counting at `expires_at` and is swept lazily.
--
-- Only the Hub itself (system transactions) touches this table, so it has no RLS and, per migrate.ts, no grant for the app role.

CREATE TABLE credit_reservations (
	id text PRIMARY KEY,
	subject_type text NOT NULL CHECK (subject_type IN ('user', 'org')),
	subject_id text NOT NULL,
	amount bigint NOT NULL CHECK (amount > 0),
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_reservations_subject_idx ON credit_reservations (subject_type, subject_id, expires_at);
