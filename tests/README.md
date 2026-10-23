# Eatswada Phase 3.2 tests

## Static gates

```bash
npm run test:syntax
npm run test:launch-gate
```

## Integration gate

Start the backend against a **dedicated test MongoDB database** first, then run:

```bash
TEST_BASE_URL=http://localhost:5000 npm run test:integration
```

Optional role tokens can be supplied to test positive and cross-role authorization:

```bash
TEST_BASE_URL=http://localhost:5000 \
TEST_ADMIN_TOKEN='...' \
TEST_VENDOR_TOKEN='...' \
TEST_RIDER_TOKEN='...' \
TEST_CUSTOMER_TOKEN='...' \
npm run test:integration
```

The default integration gate is non-destructive. It performs health/public endpoint checks and authorization-boundary checks.

Do **not** point mutation tests at production. A dedicated MongoDB database and explicit `TEST_ALLOW_MUTATIONS=true` confirmation are required before adding/running destructive lifecycle fixtures.

## Financial-integrity suites

```bash
npm run test:financial            # all five suites, stops at the first failing suite
npm run test:financial-cod        # COD delivery / force-deliver
npm run test:financial-payout     # rider payouts
npm run test:financial-settlement # restaurant settlements + discount funding
npm run test:financial-cross-cutting
npm run test:financial-standalone # standalone-MongoDB fail-closed behaviour
```

These suites are **self-contained and disposable**. `tests/helpers/replset.js` starts
a throw-away `mongod` (via `mongodb-memory-server`) on `127.0.0.1` with a random port
and a random database name, and refuses to connect to any non-loopback host. It never
reads `MONGO_URI`, so the suites cannot reach production, Render or Atlas.

- Replica-set suites (`cod`, `payout`, `settlement`, `cross-cutting`) exercise the real
  transaction paths. Startup verifies a writable primary and commits a probe transaction.
- The standalone suite starts a separate `mongod` with no replica set and verifies that
  critical money movements fail closed (`TRANSACTION_REQUIRED`, HTTP 503).
- Exit code is non-zero if any test fails, times out, or if a suite runs zero tests.
- If `mongod` cannot start (unsupported platform, no network for the first binary
  download) the suite fails with a message saying it is a test-environment problem.

### Supported route: GitHub Actions / Linux x64

See `.github/workflows/financial-tests.yml` (Ubuntu, Node 22, `npm ci`, `npm run test:financial`).

### Android / Termux

`mongodb-memory-server` downloads official Linux x64/arm64 **glibc** builds of `mongod`.
Termux is Android/bionic, so this is **not a supported route** and has not been verified.

- `EACCES ... symlink ... node_modules/.bin/nodemon` is an Android shared-storage
  limitation (`/sdcard` cannot hold symlinks). Work from Termux's home directory
  (`cp -r` the project to `~/Eatswada`) or use `npm ci --no-bin-links`.
- `npm run test:syntax` needs no database and works in Termux.
- If a compatible `mongod` exists on the device, `MONGOMS_SYSTEM_BINARY=/path/to/mongod`
  may let the suites run; otherwise rely on the GitHub Actions run.
