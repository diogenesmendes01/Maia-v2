# types

**Path:** `src/types/`

**Purpose** — Global TypeScript types and enums shared across modules without becoming a circular dependency. Today this is small and focused: the cross-cutting enum file (cognitive layers, etc.) and ambient declarations for third-party packages without `@types/*` packages.

## Key files

| File | Role |
|---|---|
| `src/types/enums.ts` | Global enums (e.g., `CognitiveLayer` — used by `src/cognitive-graph/orchestrator.ts`) |
| `src/types/pdfmake-printer.d.ts` | Ambient declaration for `pdfmake/src/printer` (no `@types/`) |

## Patterns it follows

- One file per coherent topic; do not bundle unrelated types here
- `.d.ts` for ambient declarations; `.ts` for runtime values (enums)
- Module-specific types stay in `src/<module>/types.ts`; only put a type here if **two or more** modules import it without coupling

## How to extend

| Need | Where |
|---|---|
| Add a cross-cutting enum | Extend `enums.ts`; document where it's consumed |
| Add an ambient declaration | New `<package>.d.ts`; document why the package needs it |
| Add a global type alias | First ask: can it live in a single module's `types.ts`? If not, here, with a comment explaining the cross-module need |

## Public surface

| Consumed by | What |
|---|---|
| `src/cognitive-graph/orchestrator.ts` | `CognitiveLayer` enum |
| `src/lib/pdf/*.ts` | `pdfmake-printer.d.ts` declaration |

## Tests

Type declarations are validated by `npm run typecheck`. There is no runtime test for ambient declarations.

## In-flight changes

At last verification (2026-05-28): none specifically scoped to `src/types/`.

Verify: `gh pr list --state open --search "types OR enums"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
