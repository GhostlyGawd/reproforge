import { runTrustedSample } from "@/application/sample-case";

export const runtime = "nodejs";

export async function GET() {
  const sample = await runTrustedSample();
  const payload = JSON.stringify(
    {
      bundle: sample.bundle,
      files: sample.files,
    },
    null,
    2,
  );

  return new Response(payload, {
    headers: {
      "Content-Disposition": 'attachment; filename="reproforge-sample-bundle.json"',
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
