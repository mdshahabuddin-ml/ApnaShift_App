-- Migration 003: driver ratings stats (trigger-maintained).
-- Note: file is db/migrations/003_ratings.sql (002 already covers bookings flow).
-- migrate.js runs db/migrations/*.sql in order — no runner change needed.
-- Run: npm run db:migrate
--
-- Columns (drivers):
--   avg_rating   — AVG of ratings (NULL when no ratings)
--   total_trips  — count of delivered bookings (not ratings)
--   needs_review — TRUE when ratings >= 5 AND avg < 3.0 (FALSE on recovery).
-- No auto-ban — flag is for admin review only.

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

  -- driver_id rarely changes (booking is fixed), but stay safe:
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

-- Backfill: apply stats to existing drivers/ratings.
-- (Correlated subqueries for compatibility across Postgres versions —
-- rewriting the target table in FROM/JOIN raises "invalid reference".)
UPDATE drivers d
SET avg_rating = (SELECT ROUND(AVG(stars), 2) FROM ratings WHERE driver_id = d.id),
    total_trips = (SELECT COUNT(*) FROM bookings WHERE driver_id = d.id AND status = 'delivered'),
    needs_review = (
      SELECT COALESCE(COUNT(*), 0) >= 5 AND COALESCE(ROUND(AVG(stars), 2), 5) < 3.0
      FROM ratings WHERE driver_id = d.id
    );
