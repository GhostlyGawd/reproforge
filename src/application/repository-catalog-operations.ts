import type { AuthorizedPrincipal } from "@/application/authorization";
import type { RepositorySourceProvider } from "@/application/ports/repository-source";
import type {
  ListAuthorizedRepositoriesInput,
  RepositoryOperations,
  StartRepositoryReproductionInput,
} from "@/application/repository-operations";

export class RepositoryExecutionUnavailableError extends Error {
  readonly code = "REPOSITORY_EXECUTION_UNAVAILABLE" as const;

  constructor() {
    super("Repository execution is not available in this deployment");
    this.name = "RepositoryExecutionUnavailableError";
  }
}

export class RepositoryCatalogOperations implements RepositoryOperations {
  constructor(private readonly source: RepositorySourceProvider) {}

  listAuthorizedRepositories(
    principal: AuthorizedPrincipal,
    input: ListAuthorizedRepositoriesInput,
  ) {
    return this.source.listAuthorizedRepositories(principal, input);
  }

  async startRepositoryReproduction(
    principal: AuthorizedPrincipal,
    input: StartRepositoryReproductionInput,
  ): Promise<never> {
    await this.source.resolveRevision(principal, {
      commitSha: input.source.commitSha,
      repositoryId: input.source.repositoryId,
    });
    throw new RepositoryExecutionUnavailableError();
  }

  async getReproduction(): Promise<never> {
    throw new RepositoryExecutionUnavailableError();
  }

  async cancelReproduction(): Promise<never> {
    throw new RepositoryExecutionUnavailableError();
  }

  async exportReproBundle(): Promise<never> {
    throw new RepositoryExecutionUnavailableError();
  }
}

export class DeferredRepositoryOperations implements RepositoryOperations {
  private operations?: Promise<RepositoryOperations>;

  constructor(
    private readonly create: () => Promise<RepositoryOperations>,
  ) {}

  cancelReproduction(
    ...parameters: Parameters<RepositoryOperations["cancelReproduction"]>
  ) {
    return this.resolve().then((operations) =>
      operations.cancelReproduction(...parameters),
    );
  }

  exportReproBundle(
    ...parameters: Parameters<RepositoryOperations["exportReproBundle"]>
  ) {
    return this.resolve().then((operations) =>
      operations.exportReproBundle(...parameters),
    );
  }

  getReproduction(
    ...parameters: Parameters<RepositoryOperations["getReproduction"]>
  ) {
    return this.resolve().then((operations) =>
      operations.getReproduction(...parameters),
    );
  }

  listAuthorizedRepositories(
    ...parameters: Parameters<RepositoryOperations["listAuthorizedRepositories"]>
  ) {
    return this.resolve().then((operations) =>
      operations.listAuthorizedRepositories(...parameters),
    );
  }

  startRepositoryReproduction(
    ...parameters: Parameters<RepositoryOperations["startRepositoryReproduction"]>
  ) {
    return this.resolve().then((operations) =>
      operations.startRepositoryReproduction(...parameters),
    );
  }

  private resolve(): Promise<RepositoryOperations> {
    this.operations ??= this.create();
    return this.operations;
  }
}
