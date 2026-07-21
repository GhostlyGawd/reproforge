import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import PrivacyPage from "@/app/privacy/page";
import SecurityPage from "@/app/security/page";
import SupportPage from "@/app/support/page";
import TermsPage from "@/app/terms/page";

const pages = [
  ["privacy", PrivacyPage],
  ["security", SecurityPage],
  ["support", SupportPage],
  ["terms", TermsPage],
] as const;

describe("public product policy pages", () => {
  it.each(pages)("renders an accessible %s page with shared product navigation", (_slug, Page) => {
    const html = renderToStaticMarkup(createElement(Page));

    expect(html).toContain("<main");
    expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    expect(html).toContain('aria-label="Policy navigation"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/support"');
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/">Back to ReproForge</a>');
  });

  it("states the real data boundary, providers, retention, and account controls", () => {
    const html = renderToStaticMarkup(createElement(PrivacyPage));

    expect(html).toContain("30 days");
    expect(html).toContain("365 days");
    expect(html).toContain("Auth0");
    expect(html).toContain("GitHub");
    expect(html).toContain("Neon Postgres");
    expect(html).toContain("Vercel");
    expect(html).toContain("OpenAI Responses API");
    expect(html).toContain('href="/account"');
    expect(html).toContain("No first-party analytics or advertising");
  });

  it("publishes narrow pre-release terms without fabricating legal or service promises", () => {
    const html = renderToStaticMarkup(createElement(TermsPage));

    expect(html).toContain("private beta");
    expect(html).toContain("synthetic or authorized canary repositories");
    expect(html).toContain("no service-level agreement");
    expect(html).toContain("Do not submit secrets");
    expect(html).not.toMatch(/governing law|limited liability company|inc\.|corporation/i);
  });

  it("routes public support separately from private vulnerability reporting", () => {
    const support = renderToStaticMarkup(createElement(SupportPage));
    const security = renderToStaticMarkup(createElement(SecurityPage));

    expect(support).toContain("https://github.com/GhostlyGawd/reproforge/issues");
    expect(support).toContain('href="/security"');
    expect(support).toContain("Do not post vulnerability details");
    expect(security).toContain("https://github.com/GhostlyGawd/reproforge/security/policy");
    expect(security).toContain("Report a vulnerability");
    expect(security).not.toMatch(/mailto:|rhenmcleod/i);
  });
});
