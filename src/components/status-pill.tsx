import { CircleCheck, CircleDashed } from "lucide-react";

type StatusPillProps = {
  label: string;
  tone: "success" | "warning";
};

export function StatusPill({ label, tone }: StatusPillProps) {
  const Icon = tone === "success" ? CircleCheck : CircleDashed;

  return (
    <span className={`status-pill ${tone}`}>
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
}
