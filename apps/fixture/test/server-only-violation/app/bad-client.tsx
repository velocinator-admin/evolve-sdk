"use client";

import { evolveStaticParams } from "next-evolve";

export function Bad() {
  return <p>{evolveStaticParams().length}</p>;
}
