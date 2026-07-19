import { connection } from "next/server";

import { getInvestigatorAvailability } from "@/ai/factory";
import { runTrustedSample } from "@/application/sample-case";
import { ReproForgeApp } from "@/components/reproforge-app";

export default async function Home() {
  await connection();
  const sample = await runTrustedSample();
  const availability = getInvestigatorAvailability();

  return (
    <ReproForgeApp
      liveInvestigatorAvailable={availability.liveAvailable}
      sample={sample}
    />
  );
}
