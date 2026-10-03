# dep-lib

Fixture for git-flare's merge queue: its tests import an npm dependency (`ms`), so the test container must
install it first. `.gitflare/gates.json` declares `npm ci --ignore-scripts`, which runs with read-only access to
the npm registry through the platform's proxy; the tests themselves run without network access.
