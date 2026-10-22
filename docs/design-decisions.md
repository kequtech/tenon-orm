# Design decisions

Tenon is a SQL toolkit with an ORM's migration and schema workflow. These are
current tradeoffs, not rules that future implementations must preserve.

## Query authoring

Tagged templates keep values beside their SQL use and allow SafeQL to inspect
queries. The tag binds values; identifier quoting is a separate explicit helper.
Nested fragments and automatic query construction are deliberately absent.
Externally authored strings use the visibly named unsafeSql escape hatch.

Operation factories preserve direct imports and infer inputs from ordinary
function parameters. The tagged query supplies its row type. This gives editor
navigation and type reuse without a runtime registry. A shared operations
directory is a useful application convention, not something Tenon discovers.

There is one constructor and four result modes. Native pg results remain the
default; row modes are explicit. Undeclared row fields are unknown, avoiding the
false implication that a successful query can never return. Schema-aware linting
helps verify declarations, but does not replace runtime checks or database tests.

## Write safety

Affected-row expectations check the actual final command count. Root calls use a
transaction; callback calls use a savepoint so a caught failure can recover locally.
Complete operations are queued to prevent concurrent writes crossing savepoint
boundaries. Failed recovery prevents commit.

This costs two extra successful command round trips per guarded statement.
The guarantee excludes extra trigger, cascade, and CTE effects. It cannot bound
work before rollback or identify the wrong single row. A WHERE scanner would not
solve those problems either.

Structured errors support recovery without parsing messages. Optional diagnostics
exclude SQL and values, and observer failures cannot change a committed outcome.
Automatic retries remain application-owned because lost commit acknowledgments
and external side effects make generic retry unsafe.

## Types and tooling

pg is an application-owned peer. Generated types preserve its default values;
unsupported mappings remain unknown. Date/timezone behavior, numeric-array
precision, JSON validation, and custom parsers require application attention.

SafeQL is a development dependency, not part of execution. Its compiler tooling
currently uses TypeScript 6. The project also checks installed consumers with
TypeScript 7. Its array/nullability inference and driver mappings need explicit
overrides in some queries; the integration tests record those boundaries.

Schema generation describes tables and partitioned roots, not every PostgreSQL
object. Views use query-specific types; triggers and policies stay in migrations.
Measure large-schema generation before adding caching or batching.

## Migration boundaries

Each file commits with its history entry. Applied checksums include down SQL:
correcting an applied rollback file therefore needs a forward repair strategy.
Session advisory locks coordinate Tenon tools, not other migrators or deployments.

Nontransactional migrations are deferred until a product needs them. Supporting
concurrent index creation inside the migrator requires an explicit model for
partial failure, invalid indexes, retry, and history—not merely a transaction flag.

Baseline capture delegates to pg_dump. Its adapter removes psql wrappers and
localizes settings. The baseline header bypasses the authored-SQL scanner; it is
a convention, not provenance verification. Adoption records history without
comparing the existing schema. Dump/replay tests on supported server majors matter.

## Evidence still needed

The installed-package exercise covers a small product's additive upgrade,
failure/repair, rollback, baseline adoption, and logical data recovery. It does
not establish production proxy compatibility, physical backup recovery, or
large-workload performance. Test those in the first product's actual environment.

Compare Tenon with plain pg plus schema tooling on real tasks before claiming
agent preference. The strongest case for Tenon is a reliable SQL workflow, not
the number of ORM conveniences it can accumulate.
