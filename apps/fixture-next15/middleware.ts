import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { applyEvolve } from "next-evolve/proxy";
import evolveConfig from "./evolve.config";

// Next 15.5: middleware on the Node runtime, composed with an existing auth check.
export function middleware(req: NextRequest, event: NextFetchEvent) {
  if (req.nextUrl.pathname.startsWith("/app") && !req.cookies.get("session")) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return applyEvolve(evolveConfig, req, event) ?? NextResponse.next();
}

export const config = {
  runtime: "nodejs",
  matcher: ["/", "/app/:path*", "/(ev_.*)"],
};
