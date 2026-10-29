ALTER TABLE notaryd.settings
    ADD COLUMN auto_seal_enabled BOOLEAN NOT NULL DEFAULT FALSE;
