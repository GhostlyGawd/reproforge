import type { Metadata } from "next";
import Link from "next/link";

import { PolicyPage } from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Support — ReproForge",
  description: "How to report a reproducible ReproForge problem safely.",
};

export default function SupportPage() {
  return (
    <PolicyPage
      eyebrow="Support"
      title="Bring evidence. Keep sensitive details private."
      lede="ReproForge is a private-beta prototype with no guaranteed response time. Focused, reproducible reports are the fastest path to a useful answer."
    >
      <section>
        <h2>Product and documentation issues</h2>
        <p>
          Search existing reports, then open a public issue in the{" "}
          <a href="https://github.com/GhostlyGawd/reproforge/issues" rel="noreferrer">
            ReproForge GitHub issue tracker
          </a>.
        </p>
        <ul>
          <li>Include the ReproForge commit and the exact sanitized command.</li>
          <li>Describe expected and observed behavior.</li>
          <li>Include operating system, Node.js, and npm versions when relevant.</li>
          <li>Say whether the trusted control succeeds.</li>
          <li>Attach a minimal synthetic fixture or safe bundle when possible.</li>
        </ul>
      </section>

      <section>
        <h2>Security reports</h2>
        <p>
          <strong>Do not post vulnerability details</strong>, credentials, private repository
          information, or personal data in a public issue. Follow the private reporting path
          on the <Link href="/security">security page</Link> instead.
        </p>
      </section>

      <section>
        <h2>Current scope</h2>
        <p>
          Support covers reproducible defects in the bounded fixture, authorized canary flow,
          public documentation, and account controls. General environment consulting,
          arbitrary-repository execution, recovery of sensitive data, and production incident
          response are outside this private beta.
        </p>
      </section>
    </PolicyPage>
  );
}

