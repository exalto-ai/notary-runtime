ALTER TABLE notaryd.trace_shares
    DROP CONSTRAINT trace_shares_progress_check;

UPDATE notaryd.trace_shares
SET progress = 'verifying'
WHERE progress IN ('preparing', 'uploading');

ALTER TABLE notaryd.trace_shares
    ADD CONSTRAINT trace_shares_progress_check CHECK (
        progress IN ('verifying', 'shared', 'stopped', 'rejected', 'failed')
    );
