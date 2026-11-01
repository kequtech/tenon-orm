# Schema snapshots and fingerprints

`inspectSchema` reads a versioned catalog snapshot independently of generated TypeScript, codec
choices, and generator comments. Use it as one part of an application-owned schema checkpoint guard.
It does not adopt a baseline, execute migrations, or validate a whole database.

With [shared configuration](configuration.md):

```sh
npx tenon schema
npx tenon schema --namespace app --database main
```

The command requires configuration and emits JSON. Namespace selection matches generation:
`--namespace`, then `generate.namespace`, then `migrations.namespace`, then `public`.
It writes nothing to the database or filesystem. Save and review the JSON using your existing
application tooling.

The programmatic API takes an explicit connection and optional namespace, without discovering config:

```ts
import { inspectSchema } from '@kequtech/tenon-orm';

const snapshot = await inspectSchema({ connection, namespace: 'app' });
console.log(snapshot.formatVersion, snapshot.postgresMajor, snapshot.fingerprint);
```

A supplied pool remains application-owned. Catalog reads use default codecs on one borrowed session,
a read-only repeatable-read transaction, and Tenon's shared migration advisory lock. Temporary
search-path and deparser settings are restored before release. Snapshot reads pin UTC, ISO dates,
PostgreSQL interval output, hex bytes, round-trip floats and the C monetary locale, so caller session
formatting cannot change a fingerprint. Uncoordinated external DDL is outside
Tenon's migration locking contract.

## Version 1 scope

`SchemaSnapshot` contains `formatVersion: 1`, `postgresMajor`, `namespace`, the collections below,
and `fingerprint`. Names are sorted using PostgreSQL's C collation. Column, enum-label, and parent
orders retain their catalog meaning. Public types are readonly.

| Collection        | Included metadata                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tables`          | Ordinary and partitioned tables, including attached partitions; persistence, inheritance parents, partition keys and bounds                                                     |
| Table columns     | Ordered names, formatted PostgreSQL types, column-level nullability, `expression` for defaults/generated expressions, identity/generated kinds, explicit non-default collations |
| Table constraints | Named primary, unique, foreign-key, check, and exclusion definitions                                                                                                            |
| Table indexes     | Named definitions, including expressions/predicates, validity and readiness                                                                                                     |
| `enums`           | All enums in the namespace, with ordered labels, including unused or empty enums                                                                                                |
| `domains`         | All domains in the namespace, with base type, nullability, default, collation and named constraints                                                                             |
| `sequences`       | All sequence declarations in the namespace: type, start/increment/min/max/cache/cycle and owned-column association                                                              |

The catalog kind codes are `r` (ordinary table) and `p` (partitioned table); persistence is `p`
(permanent), `u` (unlogged), or `t` (temporary). Column `identity` is empty, `a` (always), or `d`
(by default); `generated` is empty, `s` (stored), or `v` (virtual).

Sequence integers are exact strings. Sequence positions and table rows are excluded. The selected
namespace's `__tenon_migrations` table is excluded; migration-file checksums and adoption history
remain separate checks.

Version 1 excludes functions and their bodies, privileges/owners, row-security settings and
policies, triggers, rules, views/materialized views, foreign tables, extension/composite/range type
definitions, collation definitions, table storage settings and external object definitions.
Index storage clauses emitted by PostgreSQL's index definition (such as `WITH (fillfactor=...)`)
are included in that definition and therefore affect the fingerprint.
References to external objects remain qualified in PostgreSQL definitions. Verify excluded
application contracts independently; this fingerprint is not proof of complete schema equivalence.

## Fingerprint contract

The fingerprint is `tenon-schema-v1:sha256:<hex>`. It hashes canonical JSON of the metadata, excluding
the fingerprint itself: object keys are sorted, arrays preserve their order, and strings retain their
exact content. Database object OIDs and connection values are absent. Schema names and the PostgreSQL
major version are included. A fresh replay into the same namespace on the same PostgreSQL major
reproduces the fingerprint despite different OIDs or sequence positions.

Generator syntax, prose and codec changes do not affect this format. Changes to fingerprint inputs
require a new format version. PostgreSQL owns SQL deparsing; inspect snapshot differences when
upgrading PostgreSQL, including patch releases. Different major versions deliberately produce
incomparable checkpoints. This avoids silently assuming that their catalog/deparser contracts match.

## Adopt a reviewed checkpoint

Keep any existing guard until the replacement is verified:

1. Replay the immutable baseline into a disposable database using the intended namespace and
   PostgreSQL major. Verify it against the existing frozen references and independent checks.
2. Capture and review the versioned snapshot. Commit its expected fingerprint alongside the
   application's fixed adoption policy, retaining the original references.
3. Before adoption, inspect the target and compare it with that reviewed reference. Refuse on a
   mismatch. Keep function/security/history checks and test matching adoption, preserved rows,
   repeat adoption, and refusal after relevant drift.

Do not establish the expected fingerprint from whichever live database happens to be configured.
Tenon's baseline adoption does not automatically perform this comparison. See
[adoption safety](adoption-guide.md#check-and-adopt-an-existing-database).
