declare namespace Cloudflare {
  interface Env {
    REPO_COORDINATOR: DurableObjectNamespace<import('../src/durable_objects/RepoCoordinator').RepoCoordinator>;
    REPO_REGISTRY: DurableObjectNamespace<import('../src/durable_objects/RepoRegistry').RepoRegistry>;
    TEST_RUNNER_MODE: string;
    ARTIFACTS_MODE: string;
    ADMIN_KEY: string;
    AUTH_SECRET: string;
  }
}
