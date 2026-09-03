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
