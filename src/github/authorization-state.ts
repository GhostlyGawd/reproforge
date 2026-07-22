export type GitHubAuthorizationStatus = "ACTIVE" | "REMOVED" | "SUSPENDED";

export type GitHubAuthorizationState = {
  providerUpdatedAt: string | null;
  status: GitHubAuthorizationStatus;
};

export type GitHubAuthorizationTransition = {
  at: string;
  status: GitHubAuthorizationStatus;
};

const STATUS_PRECEDENCE: Record<GitHubAuthorizationStatus, number> = {
  ACTIVE: 0,
  SUSPENDED: 1,
  REMOVED: 2,
};

export function reduceGitHubAuthorizationState(
  current: GitHubAuthorizationState,
  transition: GitHubAuthorizationTransition,
): GitHubAuthorizationState {
  if (current.status === "REMOVED") {
    return transition.status === "REMOVED" &&
      (current.providerUpdatedAt === null ||
        Date.parse(transition.at) > Date.parse(current.providerUpdatedAt))
      ? { providerUpdatedAt: transition.at, status: "REMOVED" }
      : current;
  }
  if (transition.status === "REMOVED") {
    return { providerUpdatedAt: transition.at, status: "REMOVED" };
  }
  if (current.providerUpdatedAt === null) {
    return {
      providerUpdatedAt: transition.at,
      status: transition.status,
    };
  }
  const currentTime = Date.parse(current.providerUpdatedAt);
  const transitionTime = Date.parse(transition.at);
  if (transitionTime > currentTime) {
    return {
      providerUpdatedAt: transition.at,
      status: transition.status,
    };
  }
  if (transitionTime < currentTime) return current;
  return STATUS_PRECEDENCE[transition.status] > STATUS_PRECEDENCE[current.status]
    ? { providerUpdatedAt: transition.at, status: transition.status }
    : current;
}
