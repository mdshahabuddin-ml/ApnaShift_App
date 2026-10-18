-- 004_unique_nullable.sql
-- PG aur MSSQL ka UNIQUE semantics alag hai:
--   PG      : UNIQUE column me bahut saare NULL allowed (NULL != NULL).
--   MSSQL   : plain UNIQUE constraint sirf EK NULL allow karta hai.
-- Iska matlab tha ki do drivers bina license/email ke register hi nahi ho
-- paate the (error 2627 duplicate key value (NULL)) — PG par chalta tha.
--
-- Fix:
--   1) inline UQ constraints (nullable columns par) drop karo — naam har DB
--      me auto-generated hash hota hai, isliye dynamic SQL;
--   2) filtered unique index banao (naam = PG constraint names, taaki
--      src/mssql/db.js ka 23505 -> err.constraint mapping bhi sahi rahe).
--
-- Idempotent: purana constraint milne par hi drop; index name guard ke saath.
-- Run: node scripts/migrate-mssql.js (db/mssql/*.sql in order).

DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql = @sql + N'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name)
  + N' DROP CONSTRAINT ' + QUOTENAME(kc.name) + N';'
FROM sys.key_constraints kc
  JOIN sys.tables t ON t.object_id = kc.parent_object_id
  JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id
    AND ic.index_id = kc.unique_index_id AND ic.is_included_column = 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE kc.type = 'UQ' AND c.is_nullable = 1;
IF @sql <> N'' EXEC sys.sp_executesql @sql;
GO
IF OBJECT_ID('drivers', 'U') IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'drivers_email_unique' AND object_id = OBJECT_ID('drivers'))
  CREATE UNIQUE INDEX drivers_email_unique ON drivers (email) WHERE email IS NOT NULL;
GO
IF OBJECT_ID('drivers', 'U') IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'drivers_license_unique' AND object_id = OBJECT_ID('drivers'))
  CREATE UNIQUE INDEX drivers_license_unique ON drivers (license_number) WHERE license_number IS NOT NULL;
GO
IF OBJECT_ID('settlements', 'U') IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'settlements_reference_no_key' AND object_id = OBJECT_ID('settlements'))
  CREATE UNIQUE INDEX settlements_reference_no_key ON settlements (reference_no) WHERE reference_no IS NOT NULL;
GO
