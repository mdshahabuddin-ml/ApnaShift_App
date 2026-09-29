-- Migration 008: driver total_trips bookings delivered par sync.
-- Pehle total_trips sirf ratings-trigger (003) se update hota tha,
-- isliye bina rating ke delivered bookings ka count stale rehta tha.
-- Ye trigger bookings ke driver_id/status change par total_trips recount karta hai.
-- avg_rating/needs_review abhi bhi sirf ratings-trigger ke paas hain.
-- Chalao: npm run db:migrate (migrations folder order me chalta hai).

CREATE OR REPLACE FUNCTION sync_driver_trips()
RETURNS TRIGGER AS $$
DECLARE
  did UUID;
  old_did UUID;
  trips INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    did := OLD.driver_id;
    IF did IS NOT NULL THEN
      SELECT COUNT(*) INTO trips
      FROM bookings WHERE driver_id = did AND status = 'delivered';
      UPDATE drivers SET total_trips = trips WHERE id = did;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    did := NEW.driver_id;
    IF did IS NOT NULL THEN
      SELECT COUNT(*) INTO trips
      FROM bookings WHERE driver_id = did AND status = 'delivered';
      UPDATE drivers SET total_trips = trips WHERE id = did;
    END IF;
    RETURN NEW;
  ELSE
    -- UPDATE: driver ya status badla tabhi recount (faltu writes nahi).
    IF NEW.driver_id IS DISTINCT FROM OLD.driver_id
      OR NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.driver_id IS NOT NULL THEN
        SELECT COUNT(*) INTO trips
        FROM bookings WHERE driver_id = NEW.driver_id AND status = 'delivered';
        UPDATE drivers SET total_trips = trips WHERE id = NEW.driver_id;
      END IF;
      old_did := OLD.driver_id;
      IF old_did IS NOT NULL AND old_did IS DISTINCT FROM NEW.driver_id THEN
        SELECT COUNT(*) INTO trips
        FROM bookings WHERE driver_id = old_did AND status = 'delivered';
        UPDATE drivers SET total_trips = trips WHERE id = old_did;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bookings_trips ON bookings;
CREATE TRIGGER trg_bookings_trips
  AFTER INSERT OR UPDATE OF driver_id, status OR DELETE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION sync_driver_trips();

-- Backfill: pehle se delivered bookings ka count lagao (bina rating wale samet).
UPDATE drivers d
SET total_trips = (SELECT COUNT(*) FROM bookings WHERE driver_id = d.id AND status = 'delivered');
