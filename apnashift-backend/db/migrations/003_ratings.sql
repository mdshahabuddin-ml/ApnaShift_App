-- Migration 003: driver ratings stats (trigger-maintained).
-- Note: file db/migrations/003_ratings.sql hai (002 bookings flow le chuka hai).
-- migrate.js db/migrations/*.sql ko order me chalata hai — runner me change nahi chahiye.
-- Chalao: npm run db:migrate
--
-- Columns (drivers):
--   avg_rating   — ratings ka AVG (koi rating nahi to NULL)
--   total_trips  — delivered bookings ki ginti (ratings ki nahi)
--   needs_review — TRUE jab ratings >= 5 AUR avg < 3.0 (recover ho to FALSE).
-- Auto-ban kahin nahi — flag sirf admins dekhte hain.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS avg_rating NUMERIC(3, 2);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS total_trips INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION refresh_driver_stats()
RETURNS TRIGGER AS $$
DECLARE
  did UUID;
  r_count INTEGER;
  r_avg NUMERIC;
  trips INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    did := OLD.driver_id;
  ELSE
    did := NEW.driver_id;
  END IF;

  SELECT COUNT(*), ROUND(AVG(stars), 2) INTO r_count, r_avg
  FROM ratings WHERE driver_id = did;

  SELECT COUNT(*) INTO trips
  FROM bookings WHERE driver_id = did AND status = 'delivered';

  UPDATE drivers
  SET avg_rating = r_avg,
      total_trips = trips,
      needs_review = (r_count >= 5 AND COALESCE(r_avg, 5) < 3.0)
  WHERE id = did;

  -- driver_id practically kabhi nahi badalta (booking fixed), par safe raho:
  IF TG_OP = 'UPDATE' AND OLD.driver_id IS DISTINCT FROM NEW.driver_id THEN
    SELECT COUNT(*), ROUND(AVG(stars), 2) INTO r_count, r_avg
    FROM ratings WHERE driver_id = OLD.driver_id;
    SELECT COUNT(*) INTO trips
    FROM bookings WHERE driver_id = OLD.driver_id AND status = 'delivered';
    UPDATE drivers
    SET avg_rating = r_avg,
        total_trips = trips,
        needs_review = (r_count >= 5 AND COALESCE(r_avg, 5) < 3.0)
    WHERE id = OLD.driver_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ratings_refresh ON ratings;
CREATE TRIGGER trg_ratings_refresh
  AFTER INSERT OR UPDATE OR DELETE ON ratings
  FOR EACH ROW
  EXECUTE FUNCTION refresh_driver_stats();

-- Backfill: pehle se maujood drivers/ratings par stats lagao.
-- (Correlated subqueries taaki har Postgres version par chale —
-- target table ko FROM/JOIN me dobara likhne par "invalid reference" aata hai.)
UPDATE drivers d
SET avg_rating = (SELECT ROUND(AVG(stars), 2) FROM ratings WHERE driver_id = d.id),
    total_trips = (SELECT COUNT(*) FROM bookings WHERE driver_id = d.id AND status = 'delivered'),
    needs_review = (
      SELECT COALESCE(COUNT(*), 0) >= 5 AND COALESCE(ROUND(AVG(stars), 2), 5) < 3.0
      FROM ratings WHERE driver_id = d.id
    );
