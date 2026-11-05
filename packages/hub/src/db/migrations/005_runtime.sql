-- 005_runtime: tenant runtimes and executor nodes (sub-project 3, block 3A).
-- One tenant instance per user; nodes are platform infrastructure (operator managed), so they carry no org_id.

CREATE TABLE executor_nodes (
	id text PRIMARY KEY,
	name text NOT NULL UNIQUE,
	-- Docker Engine endpoint: tcp://host:2376, unix:///var/run/docker.sock or npipe:////./pipe/docker_engine.
	docker_url text NOT NULL,
	-- Directory holding ca.pem / cert.pem / key.pem for a TLS endpoint.
	tls_dir text,
	cpu_capacity numeric NOT NULL DEFAULT 4 CHECK (cpu_capacity > 0),
	mem_capacity_mb integer NOT NULL DEFAULT 8192 CHECK (mem_capacity_mb > 0),
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draining', 'offline')),
	last_ping_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_runtimes (
	user_id text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	org_id text REFERENCES organizations (id) ON DELETE SET NULL,
	-- Null until the first start (an admin may set limits before then).
	driver text CHECK (driver IS NULL OR driver IN ('docker', 'sandbox', 'restricted')),
	node_id text REFERENCES executor_nodes (id) ON DELETE SET NULL,
	status text NOT NULL DEFAULT 'stopped' CHECK (status IN ('stopped', 'starting', 'running', 'stopping', 'failed')),
	port integer,
	container_id text,
	pid integer,
	started_at timestamptz,
	last_seen_at timestamptz,
	-- Admin overrides; null means the HUB_TENANT_CPU / HUB_TENANT_MEM_MB defaults apply.
	cpu_limit numeric CHECK (cpu_limit IS NULL OR cpu_limit > 0),
	mem_limit_mb integer CHECK (mem_limit_mb IS NULL OR mem_limit_mb > 0),
	last_error text,
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_runtimes_node_idx ON tenant_runtimes (node_id);
CREATE INDEX tenant_runtimes_org_idx ON tenant_runtimes (org_id);

ALTER TABLE tenant_runtimes ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenant_runtimes
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));
