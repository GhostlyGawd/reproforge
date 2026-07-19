import { runTrustedSample } from "@/application/sample-case";
import { ReproForgeApp } from "@/components/reproforge-app";

export default async function Home() {
  const sample = await runTrustedSample();

  return <ReproForgeApp sample={sample} />;
}
