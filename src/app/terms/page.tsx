import type { Metadata } from "next";
import Link from "next/link";

import { PolicyPage } from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Terms — ReproForge",
  description: "Narrow private-beta terms for evaluating ReproForge.",
};

export default function TermsPage() {
  return (
    <PolicyPage
      eyebrow="Private-beta terms"
      title="A narrow agreement for a bounded preview."
      lede="These prototype terms cover evaluation of the ReproForge private beta. ReproForge is not yet a public commercial service."
    >
      <section>
        <h2>Permitted use</h2>
        <p>
          You may evaluate ReproForge with its bundled fixture and with synthetic or
          authorized canary repositories that you control. You must have permission to
          install the GitHub App, access the selected repository, and process the exact
          commit you submit.
        </p>
      </section>

      <section>
        <h2>Prohibited inputs and activity</h2>
        <p>
          <strong>Do not submit secrets</strong>, credentials, regulated data, customer data,
          malware, unlawful material, or source you are not authorized to use. Do not evade
          quotas, isolation, repository allowlists, authorization checks, or other safety
          boundaries. Do not use the product to attack or disrupt another system.
        </p>
      </section>

      <section>
        <h2>Your source and generated evidence</h2>
        <p>
          You retain whatever rights you already hold in submitted source and issue material.
          Using ReproForge does not transfer repository ownership. You are responsible for
          reviewing a generated reproduction bundle before sharing or relying on it.
        </p>
      </section>

      <section>
        <h2>Preview availability</h2>
        <p>
          The private beta is experimental, may change or stop, and has no service-level
          agreement, guaranteed support response, warranty of uninterrupted operation, or
          promise that a generated reproduction is complete. Access may be suspended to
          protect users, providers, or the product boundary.
        </p>
      </section>

      <section>
        <h2>Data controls and changes</h2>
        <p>
          The <Link href="/privacy">privacy notice</Link> describes current processing,
          retention, export, and deletion behavior. Material changes to these prototype terms
          will appear here with an updated date before broader availability.
        </p>
      </section>
    </PolicyPage>
  );
}

