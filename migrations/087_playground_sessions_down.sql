-- 087 down — drop playground sandbox tables (issue #464).
-- Safe: playground data is ephemeral by design (TTL 24h); nothing references
-- these tables.

DROP TABLE IF EXISTS playground_turns;
DROP TABLE IF EXISTS playground_sessions;
