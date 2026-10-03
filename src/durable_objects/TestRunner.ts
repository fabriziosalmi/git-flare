// One test container per repository (Durable Object with a container attached). The container starts with
// internet access DISABLED: the tree arrives as a tar on stdin, and the untrusted code under test holds no
// credential. The only name it can reach is the npm registry proxy (registry-proxy.ts: read-only, npm
// only), used by the declared install commands. Install commands run as root with npm's cache in a root-only
// directory (content-addressed, checked by npm against the lockfile's integrity hashes); test commands run as
// the unprivileged `node` user, which cannot write node_modules or npm's cache. Nothing of a run survives into
// the next: every process of the test user is killed (and checked gone) before and after each run and after
// each command (so each test command runs alone: a service it needs must be started inside it), and every
// directory that user can write is wiped. Before the root install step, every package-manager config in the
// tree (.npmrc, .yarnrc, .yarnrc.yml, .pnpmfile.cjs, at any depth) is removed and the settings that name
// programs or enable scripts are pinned, so install runs no program and no script the tree chose. Install and
// test commands run sequentially under one overall time budget.
import { DurableObject } from 'cloudflare:workers';
import { REGISTRY_HOST, type RegistryProxy } from '../testing/registry-proxy.js';
import { tail, type TestRun } from '../testing/runner.js';

const WORKDIR = '/workspace/run';
const TEST_HOME = '/workspace/home';
const NPM_CACHE = '/workspace/npm-cache';
const TEST_USER = 'node'; // uid 1000 in the node image
const NPM_ENV = {
  npm_config_registry: `http://${REGISTRY_HOST}/`,
  npm_config_replace_registry_host: 'always', // every resolved URL goes to the proxy, whatever host it names
  npm_config_cache: NPM_CACHE, // content-addressed, integrity-checked by npm on read; root-only
  npm_config_ignore_scripts: 'true', // also when a command forgets --ignore-scripts or the tree's .npmrc says otherwise
  npm_config_prefer_offline: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  npm_config_git: '/bin/false', // git dependencies cannot run a git binary the tree's config names
  YARN_IGNORE_PATH: '1', // yarn 1 (in the node image): no yarn-path program
  YARN_IGNORE_SCRIPTS: 'true',
  YARN_ENABLE_SCRIPTS: 'false', // yarn 2+
};
const PM_CONFIGS = ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs'];
const LIVE_TEST_USER_PROCS = `for f in /proc/[0-9]*/status; do awk '/^State:/{s=$2} /^Uid:/{u=$2} END{if (u == 1000 && s != "Z") print FILENAME}' "$f" 2>/dev/null; done`;
// Everything the test user can write outside the run's own directories, wiped before every run.
const USER_WRITABLE = ['/tmp', '/var/tmp', '/dev/shm', '/dev/mqueue', '/home/node'];
const INACTIVITY_MS = 10 * 60_000;
const dec = new TextDecoder();

export class TestRunner extends DurableObject<object> {
  private container(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error('no container attached to TestRunner (check the containers section of wrangler.jsonc)');
    return c;
  }

  private image?: string;

  private async ensureRunning(): Promise<Container> {
    const c = this.container();
    if (!c.running) {
      this.image = c.images.runner;
      c.start({ image: c.images.runner, enableInternet: false, instance: 'standard-1' });
      await c.setInactivityTimeout(INACTIVITY_MS);
      const proxy = (this.ctx.exports as unknown as { RegistryProxy?: Fetcher & RegistryProxy }).RegistryProxy;
      if (proxy) await c.interceptOutboundHttp(REGISTRY_HOST, proxy);
    }
    return c;
  }

  /** exec that tolerates the first moments after start() while the container comes up. */
  private async exec(c: Container, argv: string[], opts: ContainerExecOptions = {}): Promise<ExecProcess> {
    let last: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await c.exec(argv, opts);
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`container exec failed (${argv.join(' ').slice(0, 60)}; image ${this.image ?? c.images.runner}): ${String((last as Error)?.message ?? last)}`);
  }

  /** Kill every process of the test user (background ones included) and check that none is left. */
  private async killTestUser(c: Container): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await (await this.exec(c, ['/sbin/su-exec', `${TEST_USER}:${TEST_USER}`, 'kill', '-9', '-1'])).output(); // fails harmlessly when none
      // Live processes of uid 1000 (zombies excluded: dead, only waiting to be reaped by tini).
      const left = await (await this.exec(c, ['sh', '-c', LIVE_TEST_USER_PROCS])).output();
      if (!dec.decode(left.stdout).trim()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('test user processes survive kill -9');
  }

  async run(tar: Uint8Array, commands: string[], timeoutMs: number, install: string[] = []): Promise<TestRun> {
    const t0 = Date.now();
    const c = await this.ensureRunning();
    await this.killTestUser(c);
    const reset = `rm -rf ${WORKDIR} ${TEST_HOME} && find ${USER_WRITABLE.join(' ')} -mindepth 1 -delete 2>/dev/null; mkdir -p ${WORKDIR} ${TEST_HOME} ${NPM_CACHE} && chmod 700 ${NPM_CACHE} && chown ${TEST_USER}:${TEST_USER} ${TEST_HOME}`;
    const prep = await (await this.exec(c, ['sh', '-c', reset])).output();
    if (prep.exitCode !== 0) throw new Error(`workspace reset failed: ${dec.decode(prep.stderr)}`);
    const untar = await (await this.exec(c, ['tar', '-x', '-f', '-', '-C', WORKDIR], { stdin: new Blob([tar]).stream() })).output();
    if (untar.exitCode !== 0) throw new Error(`tree extraction failed: ${dec.decode(untar.stderr)}`);
    // The tree's package-manager configs never reach the root install step (they can name programs to run).
    const configs = PM_CONFIGS.flatMap((n, i) => [...(i ? ['-o'] : []), '-name', n]);
    await (await this.exec(c, ['find', WORKDIR, '(', ...configs, ')', '-exec', 'rm', '-f', '{}', '+'])).output();
    // -h: a symbolic link in the tree changes owner itself, never the file it points to.
    await (await this.exec(c, ['chown', '-R', '-h', `${TEST_USER}:${TEST_USER}`, WORKDIR])).output();

    const results: TestRun['results'] = [];
    let log = '';
    let passed = true;
    const steps: Array<{ command: string; phase?: 'install' }> = [...install.map((command) => ({ command, phase: 'install' as const })), ...commands.map((command) => ({ command }))];
    for (const { command, phase } of steps) {
      const remaining = timeoutMs - (Date.now() - t0);
      if (remaining <= 0) {
        results.push({ command, exitCode: -1, ms: 0, timedOut: true, ...(phase ? { phase } : {}) });
        passed = false;
        break;
      }
      const started = Date.now();
      const base = { CI: 'true', PATH: '/usr/local/bin:/usr/bin:/bin' };
      const p =
        phase === 'install'
          ? await this.exec(c, ['sh', '-c', command], { cwd: WORKDIR, stderr: 'combined', env: { ...base, HOME: '/root', ...NPM_ENV } })
          : await this.exec(c, ['/sbin/su-exec', `${TEST_USER}:${TEST_USER}`, 'env', `HOME=${TEST_HOME}`, 'sh', '-c', command], { cwd: WORKDIR, stderr: 'combined', env: base });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        p.kill(9);
      }, remaining);
      const out = await p.output();
      clearTimeout(timer);
      if (!phase) await this.killTestUser(c); // what a test command left running (or a timeout left behind) dies here
      log += `$ ${phase ? '(install) ' : ''}${command}\n${dec.decode(out.stdout)}\n[exit ${out.exitCode}${timedOut ? ', killed: timeout' : ''}]\n`;
      results.push({ command, exitCode: out.exitCode, ms: Date.now() - started, ...(timedOut ? { timedOut } : {}), ...(phase ? { phase } : {}) });
      if (out.exitCode !== 0 || timedOut) {
        passed = false;
        break;
      }
    }
    await this.killTestUser(c);
    return { passed, results, logTail: tail(log), ms: Date.now() - t0, image: this.image };
  }

  async destroy(): Promise<void> {
    const c = this.ctx.container;
    if (c?.running) await c.destroy();
  }
}
