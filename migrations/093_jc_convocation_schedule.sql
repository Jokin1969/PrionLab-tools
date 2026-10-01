-- Lets the "Convocar Journal Club" email be scheduled for a future send
-- time instead of only "send now" — mirrors prionvault_scheduled_email's
-- shape, but for the lab-wide JC convocation (no single recipient; the
-- send fans out to every active user at send time).
CREATE TABLE IF NOT EXISTS prionvault_jc_convocation_schedule (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id      UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    when_text       TEXT NOT NULL,
    location_text   TEXT NOT NULL DEFAULT '',
    notes           TEXT NOT NULL DEFAULT '',
    requester_name  TEXT NOT NULL DEFAULT '',
    scheduled_at    TIMESTAMPTZ NOT NULL,
    sent_at         TIMESTAMPTZ,
    error_msg       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jc_convocation_schedule_pending
    ON prionvault_jc_convocation_schedule (scheduled_at)
    WHERE sent_at IS NULL;
