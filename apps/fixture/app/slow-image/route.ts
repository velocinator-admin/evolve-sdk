// Fixture-only (T17.4): a large image served after `ms` milliseconds (0–5000).
// Detailed enough to be an LCP candidate: Chrome ignores low-entropy images
// (under 0.05 bits per displayed pixel), like a single flat rectangle.
export const dynamic = "force-dynamic";

let seed = 1;
const rand = () => {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
};
const shapes = Array.from({ length: 400 }, () => {
  const [x, y, r] = [rand() * 960, rand() * 480, 4 + rand() * 40].map(Math.round);
  const c = Math.floor(rand() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="#${c}"/>`;
}).join("");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480"><rect width="960" height="480" fill="#3b6ef5"/>${shapes}</svg>`;

export async function GET(req: Request): Promise<Response> {
  const ms = Math.min(5000, Math.max(0, Number(new URL(req.url).searchParams.get("ms")) || 0));
  await new Promise((r) => setTimeout(r, ms));
  return new Response(SVG, {
    headers: { "content-type": "image/svg+xml", "cache-control": "no-store" },
  });
}
