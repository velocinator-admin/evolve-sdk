# Wrap components for you: `next-evolve wrap`

`npx next-evolve wrap` makes your existing components optimizable without hand-writing schemas. It finds the components a page renders and reads their TypeScript props. For each one you pick, it writes a Zod schema, an `optimizable()` export and an `<Optimizable id>` usage. It shows you the diff before it writes anything.

```bash
npx next-evolve wrap /pricing --dry-run   # see what it would change
npx next-evolve wrap /pricing             # pick, review the diff, confirm
```

Run it after `init`. It needs `next-evolve`, `zod` (4) and `typescript` in the app, plus a `tsconfig.json`.

## What it does

Say `/` renders a hero:

```tsx
// app/page.tsx
import { Hero } from "@/components/hero";

export default function Home() {
  return <Hero title="Ship faster" ctaLabel="Start free" ctaHref="/signup" />;
}
```

`wrap /` lists the candidates, ranked. Components named like a hero, pricing table, CTA, banner, testimonial or FAQ rank first, and so do components that have heading or button props. The recommended ones get a ★:

```
Candidates (★ = recommended):
   1. ★ <Hero> on /  →  id "home-hero"  (title, ctaLabel)
```

Then it writes a new file next to the component, `components/hero.evolve.ts`:

```ts
import { optimizable } from "next-evolve";
import { z } from "zod";
import { Hero } from "./hero";

export const heroSchema = z.object({
  title: z.string().max(80),
  ctaLabel: z.string().max(40),
});
// Kept as you pass them (not editable): ctaHref (a link or asset URL).

export const OptimizableHero = optimizable(Hero, heroSchema);
```

It also replaces the usage on the page. The props you passed become the control:

```tsx
import { Optimizable } from "next-evolve";
import { OptimizableHero } from "@/components/hero.evolve";

export default function Home() {
  return (
    <Optimizable
      id="home-hero"
      component={OptimizableHero}
      props={{ title: "Ship faster", ctaLabel: "Start free", ctaHref: "/signup" }}
    />
  );
}
```

`wrap` doesn't touch your component file. The schema lives in a separate `.evolve.ts` file because `next-evolve` is server-only: putting `optimizable()` inside `hero.tsx` would break any client component that imports `Hero`, and it can't work at all in a `"use client"` file. A component declared in the page file itself gets its schema in the page.

After writing, `wrap` runs `tsc --noEmit` (with `--build`, also `next build`). If the check fails, `wrap` restores every file byte for byte, so nothing is left half-done. Errors tsc reports only in files `wrap` didn't change were already there; `wrap` reports them but keeps its changes.

## Which props become editable

| Prop type                                   | Schema                            |
| ------------------------------------------- | --------------------------------- |
| `string`                                    | `z.string().max(n)` (see below)   |
| `"left" \| "center"` (string literal union) | `z.enum(["left", "center"])`      |
| `number`                                    | `z.number()`                      |
| `2 \| 3 \| 4` (number literal union)        | `z.literal([2, 3, 4])`            |
| `boolean`                                   | `z.boolean()`                     |
| `string[]`, `number[]`, `("a" \| "b")[]`    | `z.array(…)`                      |
| optional (`title?: string`)                 | `.optional()` on any of the above |

Everything else stays a plain prop that you pass as before and Evolve never changes. That covers objects, arrays of objects, functions, React nodes (`children: ReactNode`), `null`able props, TypeScript `enum`s and mixed unions. Some strings stay plain too: links and assets (`href`, `ctaHref`, `imageUrl`, `logos`…), `className`, `style`, `id`, and `aria-*`/`data-*`. Each generated schema ends with a comment listing what was left out and why.

Props that come from React or the DOM through a spread type (`ComponentProps<"section"> & { … }`) are ignored, so only the props you declared show up.

**String max lengths** come from the prop name: 40 for labels and buttons (`cta`, `buttonText`, `label`), 80 for titles and names, 160 for subtitles, taglines and messages, 400 for descriptions, quotes and body copy, 120 otherwise. If the text the page passes is longer, the limit grows to 1.5× that text. Tighten them by hand; they become the dashboard's form validation.

The schema is yours to edit: add `.min()`, `.meta({ label: "Headline" })` or `.meta({ locked: true })` ([locking](api.md#optimizablecomponent-schema)), or delete a line to keep a prop fixed.

## What it skips

`wrap` explains every skip:

- **Rendered inside a callback** (`items.map((i) => <Card {...i} />)`): many instances can't share one region id.
- **No editable props**, or **no props**.
- **Generic components**, **class components**, and components whose props are a **union type**.
- **Already `optimizable()`**: wrap the usage by hand.
- **`"use client"` pages**: `<Optimizable>` is a server component. Client _components_ are fine.
- Components from packages (`next/link`, UI libraries).

## Options

| Option                       | What it does                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `[route]`                    | Only this page (`/`, `/pricing`, `/lp/[slug]`). Without it, every page under `app/` |
| `--component <Name,…>`, `-c` | Pick by component name or region id, no prompt                                      |
| `--yes`, `-y`                | Take the recommended (★) candidates and write without asking                        |
| `--dry-run`                  | Print the candidates and the diff; write nothing                                    |
| `--build`                    | Also run `next build` after `tsc`; a failure restores the files                     |

In a terminal, `wrap` asks which candidates to wrap (`1,3`, `1-4`, `all`, or Enter for the ★ ones), then asks before it writes. With no terminal (CI, scripts), pass `--yes` or `--component`.

## Region ids

Ids are `<route>-<component>` (`home-hero`, `pricing-table`, `launch-cta-banner`), and always valid region ids: lowercase, at most 40 characters. They're unique across the app: if `<Optimizable id="home-hero">` already exists, the new one is `home-hero-2`. You can rename an id before the region has experiments. Once it has some, keep the id: experiments are keyed by it.

## After wrapping

- The page must be an Evolve route (`routes` in `evolve.config.ts`). `wrap` tells you which ones aren't yet; add them, or re-run `init --routes "…"`.
- With `cacheComponents: true`, `wrap` puts each `<Optimizable>` in a `<Suspense>` boundary.
- Load the page once. The regions register on first render, then show up in the dashboard, ready for an experiment.
- Re-running `wrap` is safe: wrapped usages aren't candidates anymore, and a second component from the same file is added to the existing `.evolve.ts`.
