# Adopt an existing database

1. Choose one final schema checkpoint for the old ORM. Bring each existing target
   database to it before adoption. Freeze its migrations/schema synchronization;
   Tenon's locks do not coordinate the old tool.
2. Capture one shared baseline from the reference database into an empty Tenon
   migration directory:

   ```sh
   npx tenon baseline capture --directory migrations --namespace public
   ```

   This writes `0001_baseline.up.sql` with no down file, using native `pg_dump
--schema-only --no-owner --no-privileges`. Default scope is the complete
   database schema. Repeat `--schema name` for native schema selection; own its
   dependencies and required extensions/roles. Capture excludes Tenon's history,
   preserves existing files, and changes no source history, data or sequence
   positions. Existing ORM metadata is left in the captured schema.

3. Review and commit that SQL. On each existing database at the checkpoint:

   ```sh
   npx tenon baseline adopt
   npx tenon generate --out src/generated-schema.ts
   ```

   Adoption records the baseline checksum without executing its SQL. It requires
   an existing namespace and the first `0001_baseline.up.sql` with no down file.
   Repeating matching adoption is a no-op, even after later Tenon migrations;
   conflicting history fails. Tenon does not compare the actual target schema.

4. Replace the old ORM's application behavior and deployment commands. Own its
   validation, IDs, timestamps, hooks, serialization, seeds, metadata cleanup and
   backups. Prefer a schema-preserving replacement release so application rollback
   can redeploy compatible code. Databases may transition at different times;
   instances sharing one database share its adoption.
5. Existing databases adopt once, then use ordinary `migrate` for later files.
   **Fresh databases run `migrate` directly** to execute the saved baseline and
   subsequent migrations. Do not run adoption unconditionally on fresh databases.
   Use one shared baseline, not a different capture for every environment.

Capture needs `pg_dump` on PATH with native client/server compatibility; prefer
the server's major. Other commands use pg and need no PostgreSQL client binary.
Tenon's adapter removes outer psql restrict directives and makes dump preamble
settings transaction-local. Captured object bodies remain PostgreSQL's concern.
The `0001_baseline.up.sql` filename and capture header bypass the authored-SQL
transaction scanner because it cannot parse every native dump construct. This
is a trust convention, not provenance verification. Review the captured SQL;
keep its header and do not use it to bypass validation on handwritten migrations.
Normal transactional execution and checksums still apply.
The omitted down file stops normal rollback through the baseline; it is not a
backup or a restore plan.
