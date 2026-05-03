/**
 * UAT v2 Blocker D-15: the api-server must refuse to start if the
 * dev-tenant impersonation header (`x-org-id` accepted without auth,
 * resolved to `platform_admin`) is enabled outside of a development
 * environment. Anything other than an explicit `NODE_ENV=development`
 * — including unset, "test", "staging", or "production" — must cause
 * `assertDevTenantHeaderSafe` to throw so the misconfiguration cannot
 * silently ship.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { assertDevTenantHeaderSafe } from "../src/lib/auth";

test("dev-tenant header guard: allowed when explicitly development", () => {
  assert.doesNotThrow(() =>
    assertDevTenantHeaderSafe({
      ALLOW_DEV_TENANT_HEADER: "true",
      NODE_ENV: "development",
    }),
  );
});

test("dev-tenant header guard: allowed when flag is absent", () => {
  assert.doesNotThrow(() =>
    assertDevTenantHeaderSafe({ NODE_ENV: "production" }),
  );
  assert.doesNotThrow(() => assertDevTenantHeaderSafe({}));
});

test("dev-tenant header guard: allowed when flag is not the literal 'true'", () => {
  assert.doesNotThrow(() =>
    assertDevTenantHeaderSafe({
      ALLOW_DEV_TENANT_HEADER: "false",
      NODE_ENV: "production",
    }),
  );
  assert.doesNotThrow(() =>
    assertDevTenantHeaderSafe({
      ALLOW_DEV_TENANT_HEADER: "1",
      NODE_ENV: "production",
    }),
  );
});

test("dev-tenant header guard: throws when enabled in production", () => {
  assert.throws(
    () =>
      assertDevTenantHeaderSafe({
        ALLOW_DEV_TENANT_HEADER: "true",
        NODE_ENV: "production",
      }),
    /ALLOW_DEV_TENANT_HEADER=true is only permitted when NODE_ENV=development/,
  );
});

test("dev-tenant header guard: throws when enabled with NODE_ENV unset", () => {
  assert.throws(
    () => assertDevTenantHeaderSafe({ ALLOW_DEV_TENANT_HEADER: "true" }),
    /NODE_ENV=\(unset\)/,
  );
});

test("dev-tenant header guard: throws when enabled in staging or test", () => {
  for (const env of ["staging", "test", "uat", "preview"]) {
    assert.throws(
      () =>
        assertDevTenantHeaderSafe({
          ALLOW_DEV_TENANT_HEADER: "true",
          NODE_ENV: env,
        }),
      new RegExp(`NODE_ENV=${env}`),
      `expected throw for NODE_ENV=${env}`,
    );
  }
});
