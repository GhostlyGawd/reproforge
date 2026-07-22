"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function ProgressRefresh({ terminal }: { terminal: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (terminal) return;
    const interval = window.setInterval(() => router.refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [router, terminal]);

  return null;
}
