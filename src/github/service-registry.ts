type GitHubServiceFactories<AuthorizationServices, RuntimeServices> = {
  createAuthorization(): Promise<AuthorizationServices>;
  createRuntime(
    authorization: AuthorizationServices,
  ): Promise<RuntimeServices>;
};

export function createGitHubServiceRegistry<
  AuthorizationServices,
  RuntimeServices,
>(
  factories: GitHubServiceFactories<AuthorizationServices, RuntimeServices>,
) {
  let authorization: Promise<AuthorizationServices> | undefined;
  let runtime: Promise<RuntimeServices> | undefined;

  const getAuthorizationServices = (): Promise<AuthorizationServices> => {
    authorization ??= factories.createAuthorization();
    return authorization;
  };

  const getRuntimeServices = (): Promise<RuntimeServices> => {
    runtime ??= getAuthorizationServices().then((resolved) =>
      factories.createRuntime(resolved),
    );
    return runtime;
  };

  return {
    getAuthorizationServices,
    getRuntimeServices,
  };
}
