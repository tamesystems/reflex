# A1 type graph audit

Bun 1.4.4, TypeScript 5.9.3, macOS, 2026-11-10. The root graph now includes
both author APIs, inventory's migration, the new behavior tests and 27 negative
checks against the real package. Legacy consumers remain in the graph.

`bunx tsc --noEmit -p tsconfig.json --extendedDiagnostics` passed with 416,677
instantiations, 5.10 s check time and 6.67 s total time. A profiling configuration
excluding only `packages/effect/test/author.test.ts`, `author.types.ts`, and
`test/author-diagnostics.test.ts` used 386,236 instantiations. The new tests account
for 30,441 instantiations; the remaining increase over the previous 325,000 budget
comes from retaining both APIs and compiling the migrated inventory through the new
contract, action and coverage types. The old runtime implementation is reused.

The budget is reset to 417,000 with the existing 10% margin. This is a graph-size
baseline, not a relaxation of the margin. Timing runs under concurrent compiler load
were substantially slower; wall-clock time is not used as this gate.
