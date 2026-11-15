-- Existing and new deployments use the same low-resource defaults.
INSERT INTO settings(key,value) VALUES('reconcile_interval','300'),('reconcile_offset','0'),('billing_interval','21600'),('notify_tg_proxy','')
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
ALTER TABLE shift_runs ADD COLUMN settled_event_id INTEGER NOT NULL DEFAULT 0;
UPDATE shift_runs SET settled_event_id=event_id WHERE event_id>0 AND
 (phase IN ('settled','failover','manual') OR event_id IN
  (SELECT id FROM events WHERE status='done' AND kind IN ('shift_done','shift_failover','group_new','manual','recovery')));
