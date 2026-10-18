# AGENTS.md — Permanent project instructions (ApnaShift)

## PERMANENT RULE — ApnaShift is MSSQL ONLY

From now on, use Microsoft SQL Server and SSMS
(`LAPTOP-0KTPRBS3\SQLEXPRESS01`, database `ApnaShiftDB`) for all future
database development, testing, migrations, and verification.

- Never connect to, query, or use Railway PostgreSQL again.
- Use only verified local PostgreSQL backup files (in `backups/`) as the
  migration source when needed.
- Never delete or modify Railway resources.
- Do not modify files, databases, or configuration without the user's
  explicit approval.
- If any task requires Railway PostgreSQL access, STOP and ask first.

This rule applies to every future session — read at session start.
