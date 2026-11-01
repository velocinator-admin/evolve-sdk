import { project } from "./project";

export const LAYOUT = `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
`;

/** A fresh create-next-app-like project (Next 16, TS, pnpm), with next-evolve "installed". */
export function freshApp(extra: Record<string, string> = {}, deps: Record<string, string> = {}) {
  return project({
    "package.json": `${JSON.stringify(
      {
        name: "acme",
        private: true,
        scripts: { dev: "next dev", build: "next build" },
        dependencies: {
          next: "16.4.3",
          react: "19.3.1",
          "next-evolve": "^0.2.2",
          zod: "^4.0.0",
          ...deps,
        },
      },
      null,
      2,
    )}\n`,
    "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.4.3" }),
    "pnpm-lock.yaml": "",
    "tsconfig.json": "{}",
    ".gitignore": "node_modules\n.next\n",
    ".env.local": "DATABASE_URL=postgres://mine\nEVOLVE_TRACK_SECRET=keep-me\n",
    "app/layout.tsx": LAYOUT,
    "app/page.tsx": "export default function Home() {\n  return <h1>Home</h1>;\n}\n",
    ...extra,
  });
}
