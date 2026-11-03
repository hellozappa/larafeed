CREATE INDEX jobs_recovery_lookup
    ON jobs(kind, state, last_error_class, updated_at);
