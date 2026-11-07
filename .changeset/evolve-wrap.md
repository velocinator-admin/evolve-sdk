---
"next-evolve": minor
---

New `npx next-evolve wrap [route]` (SDK-5): finds the components a page renders, generates a Zod schema from their TypeScript props (strings with a max length, literal unions, numbers, booleans, optional props, primitive arrays; everything else stays a plain prop), writes an `optimizable()` export in a sibling `<file>.evolve.ts` and replaces the usage with `<Optimizable id>`. Interactive picker, `--yes`, `--component`, `--dry-run` and `--build`; the diff is always shown first, and if `tsc` (or `next build`) fails afterwards every file is restored byte-identical. See `docs/wrap.md`.
