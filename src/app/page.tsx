import { connection } from "next/server";

import { getInvestigatorAvailability } from "@/ai/factory";
import { getTrustedWebSample } from "@/application/default-case-service";
import { ReproForgeApp } from "@/components/reproforge-app";

export default async function Home() {
  await connection();
  const sample = await getTrustedWebSample();
  const availability = getInvestigatorAvailability();

  return (
    <ReproForgeApp
      liveInvestigatorAvailable={availability.liveAvailable}
      sample={sample}
    />
  );
}
