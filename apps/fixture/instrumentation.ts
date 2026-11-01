export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [{ registerEvolve }, { default: config }, { default: goals }] = await Promise.all([
      import("next-evolve/instrumentation"),
      import("./evolve.config"),
      import("./evolve.goals"),
    ]);
    await registerEvolve({ config, goals });
  }
}
