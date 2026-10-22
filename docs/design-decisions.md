# Design decisions

Updated 22 October 2026. These decisions describe the current PostgreSQL-only
implementation. Read [README.md](../README.md) for the API and
[roadmap.md](roadmap.md) for unfinished work.

Tenon is designed for coding agents writing application database code that humans
can inspect. Its foundations are explicit SQL migrations, committed generated row
types, inline SQL, and reusable named SQL operations. External demand and an
advantage over parameterized SQL plus type generation remain unproven.

Settled decisions:

- [x] **Readable source before publication — decided 22 October 2026.**
      Prefer ordinary functions and small modules that own concrete responsibilities.
      Separate runtime dispatch, connection ownership and callback lifecycle; separate
      migration files/history from execution and catalog reads from type rendering.
      Keep one shared pool-ownership policy and one checked runtime dispatch boundary.
      Preserve the public API, driver values and generated artifact. Use automated
      formatting and production unused-code checks. Group tests by behavior, share
      fixture lifecycle code, and verify observable effects instead of CLI prose.
      Resource cleanup preserves native errors and collects multiple failures in an
      AggregateError without nested bookkeeping state. Additional simulated fault
      tests cover that cleanup; production fault handling still needs real evidence.

- [x] **Prepare a clean repository before public distribution — decided
      22 October 2026.** Remove the preserved implementation and obsolete product
      brief. Keep current design decisions and unfinished work in docs, compiler
      variants in config, and example migrations with test fixtures. The README is
      an agent-oriented reference for implemented behavior. Disable repository-local
      conversation capture and exclude its artifacts from Git and npm packages.
      The owner retained the previous history in a private repository and created
      a separate public repository for a fresh baseline. Transfer only the audited
      current source, never the old Git history or conversation checkpoint refs.
      npm publication remains unapproved and blocked by private: true.
- [x] **ISC licensing and organization — decided 22 October 2026.** Use the
      standard ISC license, consistent with the owner's other open-source product.
      The root LICENSE and package metadata record the grant. Commercial use,
      modification, redistribution and proprietary forks are permitted with the
      copyright and permission notices retained. GitHub uses the existing
      kequtech/tenon-orm repository; npm uses @kequtech/tenon-orm. Keep the stable
      Kequtech editorial source tenon-orm. Organization scope does not change the
      license terms. Public source visibility is approved; npm publication remains
      a separate decision. Retain private: true until npm publication is approved.
- [x] **SQL-only execution core — decided 21 October 2026.** Use
      `db.sql<Row>(sql, inputs, options?)` for inline SQL and
      `db.run('operation_name', inputs)` for registered SQL. All queries, filters,
      joins, aggregates, pagination, conflict handling, batch writes, defaults, and
      RETURNING are authored explicitly in SQL. Both entry points execute one SQL
      statement, including zero-parameter calls. PostgreSQL receives SQL as written;
      Tenon does not add limits, ordering, joins, RETURNING, or mutation restrictions.
      No convenience CRUD, count/exists shortcuts, query builder, or relation DSL
      remains. This supersedes earlier decisions to retain automatic table queries.
- [x] **Named operations.** Keep SQL, input tuple, and row type
      together with `define<Row, Inputs>(sql, options?)`. Registry object keys name
      operations, and ordinary imports compose the registry. Calls infer both input
      and output contracts. Inputs are explicit arrays even when empty; tuple
      positions bind to `$1`, `$2`, and so on. No file discovery or mandatory directory
      structure. Application code transforms database results outside definitions.
      `createTenon`, `tenon`, and the default export share one constructor, accepting
      a connection and optional operation registry.
- [x] **Inline SQL.** Declare one SQL row type once at the call site.
      Inputs accept readonly arrays; PostgreSQL checks SQL parameter binding. Inline
      calls do not infer input types from SQL text. Use registered operations when a
      reusable checked input tuple is valuable. The old `query` alias is removed.
- [x] **Native-default result modes — decided 21 October 2026.** sql and define
      return the original pg.QueryResult<Row> by default, with optional explicit
      returns: 'native'. Preserve command, rowCount, rows, fields, oid and explicitly
      requested RETURNING data. many remains an explicit rows-only option; one returns
      a row or undefined and rejects multiple rows; requiredOne requires exactly one.
      These modes inspect the rows array on every statement, independent of affected
      rowCount. Without RETURNING, writes have no returned rows: one yields undefined
      and requiredOne rejects. Column arrays/JSON are left untouched. Native results
      use QueryResult<Row>, many uses Row[], and row modes use Row | undefined or Row.
      Only native mode may omit options. run inherits the definition's fixed mode.
      The former command mode is removed. Runtime behavior depends only on returns;
      TypeScript generics are erased.
- [x] **Row generics and defaults — decided 21 October 2026.** Both sql<Row>
      and define<Row, Inputs> describe a single SQL record. Ordinary overloads derive
      the result wrapper from returns, including when only the row generic is supplied.
      Do not repeat arrays, QueryResult or missing-row undefined in the row generic.
      Row defaults to never: commands can omit it and retain native metadata. This
      is a static contract, not runtime verification that no rows exist; actual rows
      are always preserved. For meaningful field access/extraction, declare Row.
      Without it, many is never[], one is undefined, and requiredOne is never.
      Named Input defaults to an empty tuple, not an unchecked parameter list; use
      define<never, [id: number]> for a parameterized command without returned rows.
      Assignment and registry context must not widen omitted generic defaults.
      Runtime input arrays remain mandatory, including [] for parameterless SQL;
      options do not replace the second argument. Both root and transaction clients
      share the same contracts. Compiler checks cover all modes and these defaults.
- [x] **Registered results remain fixed.** `run` uses its definition's result
      mode. It has no call-site result override or third argument in this pass.
      Future execution options must preserve the registry's promised return type.
- [x] **Measured consumer TypeScript floor — decided 22 October 2026.** Require
      TypeScript >=5.7.2 for the current public declarations and dependency versions;
      retain TypeScript 7 for repository development. Probes on 5.4.5, 5.5.4 and 5.6.3
      fail on generic Buffer declarations from pg-protocol with the selected Node
      typings. TypeScript 5.7.2 passes without compatibility shims or API changes.
      An exact development-only compiler alias supplies the minimum-version check;
      build/typecheck/test scripts explicitly invoke the normal TypeScript 7 package
      so npm alias binary links cannot change the development compiler. The optional
      TypeScript peer communicates the minimum without requiring a compiler for JS.
      Consumer declarations require application-owned pg typings as settled below;
      they must not rely on the repository's development-only packages to typecheck.
      test:consumer packs the built library and installs it offline in an isolated
      project, reusing the positive/negative API and committed generated-type fixtures
      through package exports. It checks minimum and development compilers with
      skipLibCheck false and verifies the installed runtime ESM import. npm test also
      runs it. This is a measured current floor, not a feature constraint: when newer
      TypeScript or dependencies are useful, raise the minimum/test version instead
      of adding backports, downgrading dependencies or weakening the API.
- [x] **Application-owned PostgreSQL driver and typings — decided 22 October 2026.**
      pg is a required peer (^8.23.1), not a regular dependency. Applications declare
      and update compatible driver versions independently; new major versions need
      compatibility checks before extending the range. TypeScript applications install
      @types/pg as a development dependency. It is not a peer: npm can retain an
      installed optional typing peer when pruning development dependencies.
      pg currently ships no declarations. Keep native pg public types rather than
      duplicating them in Tenon. JavaScript consumers and compiled runtime deployments
      need neither typings nor a compiler. Both pg and @types/pg remain development
      dependencies for Tenon's own build and tests; no regular dependencies remain.
      The packed consumer supplies its own driver/typings, checks both compilers,
      then prunes development dependencies and verifies runtime imports and shared
      application pool ownership. The compiler floor above is measured with tested
      dependencies; independent typings upgrades may require a newer compiler.
- [x] **ESM-only package — decided 22 October 2026.** Retain the existing ESM
      implementation, import export and declaration path. Do not add a CommonJS build
      or require export. CommonJS applications can use dynamic import. Reconsider
      direct CommonJS support only for a demonstrated adoption requirement. Current
      package exports already implement this decision; no code change is needed.
- [x] **Node 24 minimum — decided 22 October 2026.** Require Node >=24 for
      application execution and the CLI. Package engines and the lockfile declare
      this minimum; development and current checks use Node 24. Retain one runtime
      baseline without adding compatibility layers for older Node releases. Check
      maintained Node 24 patch releases before adoption; alternative runtimes have
      no compatibility promise without verification. This supersedes Node >=22.
- [x] **PostgreSQL 16 minimum — decided 22 October 2026.** Support PostgreSQL
      16 or newer for application execution, migrations, generation and baseline adoption.
      This is the supported baseline, not an extra runtime version probe or a promise
      that every newer major has been tested. npm test checks the actual server's
      server_version_num and test database name before starting the suite or changing
      schemas; older servers fail with upgrade/connection guidance. Following the
      user's local upgrade, all 74 tests pass on PostgreSQL 16.15 with Node 24,
      including runtime, migration, generation, baseline and packed-consumer checks.
      Verification on the latest supported stable major remains outstanding before
      adoption; passing on 16 does not establish coverage of other major versions.
      Baseline capture uses native pg_dump compatibility rules; matching its major
      to the source server avoids cross-version dump assumptions. Applications may
      author SQL requiring a newer major than Tenon's minimum. No older-version
      compatibility layer or database-upgrade automation is introduced.
- [x] **Custom-query type responsibility.** Authors keep SQL and result types
      in agreement, including aliases, outer-join nullability, expressions and nested
      JSON. Tenon does not analyze SQL or validate returned fields. Generated types,
      TypeScript and behavioral tests provide feedback. Native pg values and errors
      pass through without automatic conversion or association assembly.
- [x] **Readable errors and native PostgreSQL details — decided 22 October 2026.**
      Keep readable TenonError messages for Tenon's validation/cardinality failures.
      Preserve native PostgreSQL errors and their fields through sql/run. Migration
      failures retain migration/direction context and preserve the underlying cause.
      The CLI continues printing readable errors to stderr with a nonzero exit status.
      Improve actionable context when actual debugging reveals a gap; do not introduce
      a Tenon error-code taxonomy, machine-readable diagnostic format or JSON CLI mode
      for now. Revisit structured diagnostics only for a concrete consumer need.
      Existing behavior follows this policy; no runtime change is required.
- [x] **Cardinality checks happen after execution.** Result modes inspect SQL's
      returned rows; they do not limit affected records. Standalone writes follow
      autocommit, including when a later result-cardinality check fails. Use an
      explicit transaction and let the error escape its callback when the write must
      roll back on a mismatch. Both inline and named operations share this behavior.
- [x] **Explicit SQL migrations.** Commit ordered up files and optional authored
      down files. Migrate executes saved SQL and records history; it does not derive
      and apply changes from a schema object. Down files do not promise recovery of
      discarded data. A schema-diff draft generator is outside this implementation.
- [x] **Adoption from existing ORMs is a product requirement — decided
      22 October 2026.** Support capturing an existing PostgreSQL schema as a reviewed,
      committed initial SQL baseline and recording it on existing databases without
      replaying its DDL or changing application data. Replacing the old ORM remains
      application/agent work. Document capture, fresh replay, per-database adoption,
      deployment coordination and recovery explicitly. Each target database must match
      the same baseline at adoption; data and deployment-specific configuration need
      not be identical. Application instances sharing one database do not each need
      adoption or simultaneous replacement when the transition preserves compatibility.
      This reverses the recommendation to defer baselining. Capture and adoption are
      implemented as settled below; README documents the transition workflow. The
      overseeing agent owns the old ORM transition and checkpoint coordination.
- [x] **Native baseline capture and explicit adoption — decided 22 October 2026.**
      captureBaseline and tenon baseline capture use pg_dump's schema-only export to
      create 0001_baseline.up.sql in an empty Tenon directory, without a down file.
      Trust native export: no schema comparison, validation/replay framework, competing
      DDL serializer, old ORM migration import or metadata cleanup is implemented.
      Capture defaults to the complete database schema, with optional native schema
      selection. It omits owners/privileges and Tenon's own history table. The caller
      owns native prerequisites, selected-scope dependencies and deployment policy.
      A small pg adapter removes outer psql restrict directives, scopes the native
      preamble settings to the transaction and makes creation of the already-prepared
      history schema harmless. It leaves object definitions to PostgreSQL, including
      SQL-standard function bodies, rather than parsing them with the authored SQL
      transaction scanner. Keep the capture header and normal checksum validation.
      Capture shares the local migration-creation lock, publishes a complete file
      without overwriting and never updates source history. Native warnings are
      forwarded; failed capture cleans up and gives credential-safe errors.
      adoptBaseline and tenon baseline adopt explicitly record that first baseline
      under the existing exclusive migration lock, in one history transaction, without
      executing its SQL or modifying application data/sequence positions. They require
      an existing namespace and a baseline with no down file. Matching existing history
      is a no-op, even after subsequent migrations; conflicting/edited history fails.
      Each existing database must be at the common checkpoint when it adopts. Fresh
      databases use normal migrate to execute baseline SQL, not adoption. CLI warnings
      and README cover first-release preparation, subsequent ordinary deployments,
      old ORM migration authority, application behavior and rollback responsibilities.
      Existing ORM metadata is untouched; the transition agent decides its cleanup.
      Integration tests verify Tenon's SQL bridge and workflows, rather than checking
      pg_dump's own schema fidelity. Tests cover live data/sequence preservation,
      adoption retries/concurrency, normal future migrations, fresh replay, checksum
      conflicts, rollback boundaries, capture failures and CLI guidance.
- [x] **Schema authority and separate commands.** SQL migrations are the source
      of physical truth. `tenon migrate` never generates files; `tenon generate` inspects the
      current database without migrating it. Commit generated definitions. A checkout
      typechecks without a live database, and production migrates and starts a prebuilt
      application without writable type storage. Generation at a rolled-back checkpoint
      is valid; pending migrations warn rather than block. `generate --check` checks
      freshness without rewriting. CI must replay migrations to the intended checkpoint.
- [x] **Ordinary generated row types.** Export full row types and a `Rows` map
      using exact SQL names. Compose with Pick, indexed access, intersections and
      ordinary object types. Identity/defaulted columns are required in full returned
      rows; nullable columns retain null. Legal, non-conflicting table names also get
      named type aliases; other names remain available through Rows. Date types use
      globalThis.Date. Generated files contain row types and migrationHistory, with
      no runtime imports, constructors, table registration, or inferred insert types.
      The generator's obsolete importPath/CLI --import setting has been removed.
- [x] **Retire runtime schema metadata.** Removed column/index/table/schema
      constructors, generated runtime tables/foreign-key metadata, scalar encoders,
      filter helpers, automatic includes, and their recursive types. PostgreSQL owns
      defaults and constraints; SQL owns naming, result shape and row selection.
      This supersedes the earlier array/constructor decisions and missing-find rules.
      Unique keys, index forms and foreign keys no longer restrict row generation.
      Generated comments describe database facts without restoring a runtime schema.
- [x] **Schema discovery through existing sources — decided 22 October 2026.**
      Rely on migration files, committed generated row types and ordinary PostgreSQL
      inspection queries for now. Do not add a separate inspection command, runtime
      schema API, MCP server or query-preview framework. Row types describe returned
      values; foreign keys, indexes, defaults and other database facts remain available
      through SQL and the generated comment summary settled below. Evaluate a realistic
      consumer before expanding discovery tooling.
- [x] **Schema summary in the generated file — decided 22 October 2026.**
      Prepend table-grouped comments to the existing generated types file. Keep schema
      context and TypeScript contracts in one committed artifact, rather than a second
      generated file or exported runtime metadata. These facts are important context
      for agents authoring SQL: row shapes alone omit valid joins, conflict targets,
      defaults and other database behavior. Include SQL column types/nullability,
      primary/unique/foreign-key/check/exclusion constraints, full index definitions,
      defaults, identity mode/sequence settings and generated-column expressions.
      PostgreSQL deparses expressions, constraints and indexes; preserve names,
      predicates, included columns, referential actions and deferral/validation details.
      Include backing indexes and mark invalid/not-ready indexes. This is a descriptive
      summary, not an executable schema dump or application relation model; triggers,
      policies, permissions and other catalog objects still require SQL inspection.
      Read comments and types in the same read-only snapshot. Stable ordering and
      transaction-local deparsing settings avoid connection-setting noise; local
      names omit the selected namespace where unambiguous, external references retain
      qualification. Skip attached tables and internal partition constraint clones.
      Sequence values and routine partition maintenance do not change the artifact;
      schema metadata changes do, even with identical row types. Existing generate and
      --check cover both comments and types. Prefix every catalog-text line safely as
      a comment, including multiline identifiers/literals. Integration/compiler checks
      cover these behaviors; SQL migrations remain the source of truth.
- [x] **Initial migration runner.** Numeric `0001_description.up.sql` and optional
      matching down files run in numeric order. `__tenon_migrations` records history
      in the selected PostgreSQL namespace. Checksums cover exact up/down contents;
      changed/missing applied files and out-of-order additions fail. Exclusive advisory
      locks coordinate migration runs with shared generation locks. Each file and its
      history change commit together; earlier files remain committed if a later file
      fails. Rollback prechecks irreversibility and runs selected down files in reverse
      order. Migration files cannot supply their own transaction-control statements.
- [x] **Transactional-only migrations — decided 22 October 2026.** Keep every
      up/down file and its history change in one transaction. If a file fails, its
      changes and history update roll back together; earlier files in the run remain
      committed. No per-file opt-out, SQL-based execution-mode inference or automatic
      nontransactional fallback. SQL that PostgreSQL prohibits inside a transaction
      is outside the runner's supported subset. Nontransactional migration execution
      is deferred unless a concrete application need justifies reopening it. Routine
      database maintenance and operational orchestration are outside this runner's
      purpose; schema changes such as ordinary index creation remain valid migration
      work. The implementation already follows this policy; no code change is needed.
- [x] **Native waiting for migration locks — decided 22 October 2026.** Use
      PostgreSQL's blocking session advisory locks for migration tools, preserving
      exclusive migrate/rollback locks and shared generation/status locks. Respect
      configured lock_timeout and other native PostgreSQL limits; no Tenon deadline,
      retry loop, polling scheduler or new configuration is added. Without a configured
      timeout, a conflicting command can wait indefinitely. Read migration history
      after acquiring the lock before selecting work; overlapping runs apply each file
      once and subsequent runs become no-ops. Preserve native lock-timeout errors
      (55P03), release connections after a timeout and release acquired locks after
      success or failure. Integration tests observe queued advisory locks directly,
      verify shared/exclusive coordination, timeout propagation and connection reuse.
      Waiting is established practice, not a universal default: [Flyway waits/retries](https://documentation.red-gate.com/fd/flyway-lock-retry-count-setting-277579009.html),
      while [node-pg-migrate supports fail and wait modes](https://github.com/salsita/node-pg-migrate/blob/main/src/runner.ts)
      and defaults to failing. Using PostgreSQL's own wait mechanism keeps this change
      small and uses the same advisory-lock protocol as before.
- [x] **Explicit connection ownership.** Caller-supplied pg pools remain owned by
      their caller; Tenon closes pools it creates. close is idempotent and rejects
      subsequent work. Runtime clients have no schema or namespace option: qualify
      SQL names explicitly or use the connection's PostgreSQL configuration. Migration
      and generation namespace options remain separate tooling settings.

- [x] **Callback transactions — decided 21 October 2026.** Keep
      db.transaction(async tx => ...). One checked-out connection serves tx.sql and
      the same typed tx.run registry. Successful callbacks commit; escaping errors
      roll back; callback values reach the caller only after commit. Root db calls
      stay independent. Await all transaction work before the callback ends; tx clients
      reject new work once it has ended, including while commit/rollback is in progress.
      A caught PostgreSQL error cannot make an aborted transaction report a successful
      commit. Do not introduce manual transaction handles, implicit context propagation,
      or per-statement transaction references in this pass. Use the connection's
      configured default isolation unless the callback changes it explicitly in SQL.
      Partial recovery uses explicit savepoints as settled below.

- [x] **Explicit SQL savepoints — decided 22 October 2026.** Keep one outer
      db.transaction callback and use SAVEPOINT, ROLLBACK TO and RELEASE SAVEPOINT
      through tx.sql when partial recovery is needed. Do not add nested transaction
      callbacks, automatic savepoint names or savepoint helpers for now. Nested
      transaction behavior is not a current product need; explicit PostgreSQL SQL
      handles the occasional case without another callback lifecycle. Applications
      own savepoint naming, recovery and control flow. Existing execution and
      transaction-ownership checks already permit this SQL, and integration tests
      cover recovery from a failed statement within a callback. No runtime change is
      required. Connection-loss and rollback-failure hardening remain unfinished work.

- [x] **Explicit SQL transaction isolation — decided 22 October 2026.** Keep
      isolation changes in SET TRANSACTION SQL inside the callback, before its first
      data query or modification. tx.sql already supports this. Use the connection's
      configured default when omitted; add no isolation options object or automatic
      callback retries. Application code owns any retry strategy.

- [x] **PostgreSQL-owned statement timeouts — decided 22 October 2026.** Use
      PostgreSQL's existing statement_timeout through pg connection configuration or
      explicit SET LOCAL SQL inside a callback transaction. Add no Tenon-specific
      timeout options to sql, run or define, and impose no Tenon default deadline.
      PostgreSQL stops statements that exceed the configured limit; preserve its
      native errors and normal transaction behavior. Applications choose limits and
      handle failures. This is already supported by the existing connection and SQL
      APIs; no execution-code change is required. Explicit caller cancellation is
      deferred as settled below; chunked reads use explicit SQL as settled below.

- [x] **Defer explicit query cancellation — decided 22 October 2026.** Rely on
      PostgreSQL statement_timeout for duration limits. Add no AbortSignal option or
      cancellation API to sql, run or define for now. Current applications can allow
      unwanted work to complete and ignore its result; no demonstrated need justifies
      cancellation and connection-reuse machinery yet. Ignoring a result does not
      stop the SQL, undo writes or remove the need to handle promise rejections.
      Transaction work must still be awaited before the callback ends. Revisit only
      for a concrete consumer need; any future signal would be per execution and
      preserve the registered result contract. Existing runtime behavior already
      follows this policy; no code change is required.

- [x] **Explicit SQL cursors and deferred streaming API — decided 22 October 2026.**
      Keep sql/run results buffered with their existing return contracts. Use authored
      pagination or explicit DECLARE/FETCH/CLOSE SQL inside a callback transaction for
      chunked reads. Ordinary transaction-scoped cursors use the callback's single
      connection; fetch and process batches before the callback ends. Add no dedicated
      streaming method, async iterator, cursor helper or result-mode option for now.
      Applications own cursor names, batch sizes, processing and explicit closure;
      PostgreSQL closes non-held cursors at transaction end. Revisit a helper only when
      a concrete export or bulk-processing workflow justifies iterator/connection/
      early-exit cleanup contracts. Existing SQL execution already permits cursor
      commands; no execution-code change is required.

- [x] **Callback transaction ownership guard — decided 22 October 2026.** Reject
      direct commands that start/end a transaction through public sql/run, on both
      root and callback clients, before dispatch to pg. Cover BEGIN/START TRANSACTION,
      COMMIT/END, full ROLLBACK/ABORT, chaining and prepared-transaction forms. Error
      messages identify the operation and point to db.transaction(). A narrow prefix
      check skips leading empty statements, whitespace and nested/line comments; it
      does not inspect SQL strings, identifiers, expressions or procedure bodies.
      The existing extended-protocol rule still rejects multiple nonempty statements.
      SET TRANSACTION, SAVEPOINT, ROLLBACK TO (including WORK/TRANSACTION variants)
      and RELEASE remain available inside callbacks, with normal PostgreSQL behavior.
      Tenon owns the outer boundary; applications can manage their own savepoints.
      Caught guard errors leave the transaction usable; escaping errors roll back the
      callback's prior work. Tenon's internal BEGIN/COMMIT/ROLLBACK are unaffected.
      This guards the callback contract; it is not general SQL analysis or a security
      boundary. Native PostgreSQL syntax/value errors continue to pass through.

- [x] **Standard pg value parsing — decided 21 October 2026.** Generate bigint
      and numeric/decimal as string, json/jsonb as unknown, and bytea as Buffer, alongside
      existing int32, boolean, text/varchar, UUID, timestamptz and native enum mappings.
      Preserve pg's normal values without normalization or new conversion dependencies.
      JSON can be an object, array, scalar or null; operations declare application
      shapes explicitly. unknown already includes null. Binary type references use
      import("node:buffer").Buffer to avoid clashes with a table named Buffer; this
      introduces no runtime import. Generated nullable scalar/binary columns retain
      null, and all full-row columns remain required. Behavioral and real-consumer
      compiler checks cover precision, JSON, binary bytes and name collisions.
- [x] **Offline migration scaffolding.** createMigration({ name, directory? })
      creates the next numbered, empty up/down SQL pair, with at least four digits.
      tenon new <name> exposes it without DATABASE_URL.
      Existing files are not overwritten. Local creation uses an exclusive directory
      lock file to serialize numbering; a stale lock after a crashed creator requires
      removal after that process has stopped. Unfinished empty files still fail
      migration validation; fill them before execution, or remove an irreversible
      migration's unused down file. Scaffolding neither migrates nor generates types.

- [x] **Verified recursive array types — decided 21 October 2026.** Generated
      modules with supported array columns export PgArray<T> = (T | null | PgArray<T>)[].
      Whole-column nullability is separate. Do not infer fixed dimensions from [] or
      [][] declarations; PostgreSQL does not enforce them. Verify built-in parser
      mappings by exact catalog OID, independently of scalar mappings: integer[] and
      numeric[] map to number leaves; bigint[] to string; text[], varchar[] and uuid[]
      to string; boolean[] to boolean; timestamptz[] to Date; bytea[] to Buffer; json[]
      and jsonb[] to unknown. Preserve actual driver values, including numeric-array
      rounding and omitted SQL lower-bound metadata; authors can cast to text[] when
      exact numeric values are required. No runtime parser overrides or array reshaping.
      Empty arrays, null elements, nested arrays, binary/JSON/date parsing and helper
      name collisions have behavioral/compiler checks. PgArray is reserved as a
      generated helper name; a table named PgArray remains available through Rows.
      Unsupported/custom array types (including enum arrays without a registered
      standard parser) now generate unknown with a warning, rather than inventing
      an array result type; this supersedes their earlier rejection behavior.

- [x] **Unmapped column types — decided 21 October 2026.** Generate unknown
      and warn for each table column without a verified mapping, including domains
      with unverified bases, composite/custom types and unverified arrays. Preserve the column name and all
      other generated types. Warnings identify the namespace, table, column and
      PostgreSQL type/OID; programmatic callers can capture them with onWarning,
      otherwise they go to console.warn. The CLI writes them to stderr, including
      in --check mode. Output remains deterministic and warnings do not fail freshness
      checks. unknown includes null; column properties remain required. Intentionally
      unknown JSON/JSONB mappings do not warn. No parser overrides, runtime conversion,
      application mapping configuration or guessed array shapes are introduced.
      This fallback applies to column types only: history corruption, connection
      failures and other generation errors still fail.

- [x] **Domains use verified underlying types — decided 22 October 2026.**
      Follow nested domain bases to an existing verified scalar, enum or exact array
      mapping. Preserve pg's native values: bigint/numeric stay strings, JSON stays
      unknown without warnings, enum bases retain literal unions, and domains over
      verified arrays use PgArray. An array of domains still has an unverified parser
      and stays unknown with a warning, as do domains over unverified types/arrays.
      Warnings identify the declared domain and its underlying unmapped type. Add no
      brands, custom mapping configuration, validation or parser overrides. Continue
      deriving column nullability from the column's NOT NULL flag: domain NOT NULL
      alone does not narrow it, because PostgreSQL can admit already-domain-typed
      nulls through expressions such as empty scalar subqueries.
      Include referenced domain definitions, base type/typmod, non-inherited collation,
      defaults, NOT NULL and named constraints in the existing generated comments.
      Include nested bases and domains referenced through arrays, including external
      schemas; deduplicate and sort the definitions, excluding unused domains. Table
      comments retain the declared domain name. Domains and types share the same
      snapshot and freshness check; metadata-only domain changes update the artifact.
      Driver, TypeScript-consumer and comment checks cover nested bases, scalar/enum/
      array parsing, unsupported bases, constraints, external references and multiline
      names/defaults. PostgreSQL remains responsible for enforcing domain constraints.

- [x] **Views use manual types — decided 21 October 2026.** Always exclude
      ordinary and materialized views from generated Rows and named row exports.
      They do not block generation, including when their columns use unsupported
      generated table types. Authors declare view-query outputs beside inline SQL
      or named definitions, composing generated table types where useful. No opt-in,
      inferred view nullability, or separate view schema API. SQL migrations still own
      view definitions; operations own their queries and refreshes.

- [x] **Foreign tables use manual types — decided 22 October 2026.** Skip
      independent foreign tables and attached foreign partitions during table selection,
      before inspecting columns or building comments. Their presence does not block
      ordinary table generation or produce unsupported-column warnings. Domains used
      only by skipped tables are omitted from the summary. Author foreign-table query
      results beside inline SQL or named operation definitions, composing generated
      types where useful. Add no inclusion option, remote inspection, wrapper setup or
      runtime schema API. PostgreSQL and migrations own foreign-data configuration.
      Compiler and database checks cover ordinary/root tables beside foreign tables,
      attached foreign partitions, unchanged artifacts/freshness, and namespaces with
      only foreign tables. This replaces the previous whole-generation rejection.

- [x] **Application-owned JSON contracts — decided 22 October 2026.** Keep
      JSON/JSONB as unknown in generated types, without warnings. Developers and agents
      can declare JSON shapes in operation row types and validate their own inputs
      before insertion. A declared TypeScript shape does not validate stored data.
      Application validation and any authored database constraints remain application
      responsibilities. No built-in JSON schema definitions, validation hooks, JSON
      Schema extension integration or schema-to-TypeScript generation are needed.
      Do not infer application shapes from sampled JSON values or arbitrary CHECK SQL.
      Existing SQL execution, ordinary type composition and value parsing already
      support this decision; no runtime or generator changes are required.

- [x] **Stable partitioned table types — decided 22 October 2026.** Generate
      ordinary nonpartition tables and top-level partitioned tables in the selected
      namespace. Skip attached partitions, including intermediate parents and default
      partitions, before inspecting their columns. This replaces the earlier policy
      of generating the physical partition inventory. Direct partition SQL can reuse
      the root row type or declare its own result contract; stricter child constraints
      do not make the broader root type unsafe. No partition-selection configuration
      or partition-management API is added. Routine creation/removal of attached
      partitions leaves the generated file and --check freshness unchanged when
      migration history is unchanged. Detached tables become independent models on
      regeneration. Parent column changes still require regeneration. New versioned
      migrations still change the generated migrationHistory metadata even if row
      shapes are equal. Compiler/PostgreSQL checks cover root and ordinary types,
      skipped multilevel descendants, partition maintenance, detachment/reattachment,
      root schema changes and unchanged CLI freshness checks.
