/**
 * End-to-end tests for the SCIM 2.0 bridge — task #151.
 *
 * Walks the full Okta/Azure provisioning lifecycle:
 *
 *   1. Authentication: only an `org_admin`-scoped API key is accepted;
 *      analyst tokens get 401.
 *   2. ServiceProviderConfig advertises filter + patch.
 *   3. Users CRUD: create / get / list (with filter + pagination) /
 *      PATCH active toggle / DELETE.
 *   4. Groups CRUD with role mapping projection: create group, set a
 *      mapping via the admin API, add members → user_roles row
 *      appears with role=approver, remove member → revoked.
 *   5. Suspending a user via PATCH active=false also revokes
 *      group-derived role grants (full deprovision).
 *
 * Each test cleans up the `user_roles`, `scim_groups`, `api_keys`,
 * and `admin_audit_log` rows it creates so the suite is repeatable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
delete process.env["ALLOW_DEV_TENANT_HEADER"];

import {
  db,
  orgsTable,
  apiKeysTable,
  userRolesTable,
  scimGroupsTable,
  scimGroupMembersTable,
  adminAuditLogTable,
  type UserRoleName,
} from "@workspace/db";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import app from "../src/app";
import { generateToken } from "../src/lib/auth";
import { newId } from "../src/lib/ids";

const RUN = `scim-${randomUUID().slice(0, 8)}`;

async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) throw new Error("No org seeded");
  return row.id;
}

interface Handle {
  port: number;
  close: () => Promise<void>;
}

async function startServer(): Promise<Handle> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Could not bind ephemeral port");
  }
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function issueKey(
  orgId: string,
  scopeRole: UserRoleName,
  label: string,
): Promise<string> {
  const { plain, hash } = generateToken();
  await db.insert(apiKeysTable).values({
    id: newId("ak"),
    orgId,
    label,
    prefix: plain.slice(0, 12),
    tokenHash: hash,
    scopeRole,
    createdBy: "scim-test@procuro.ai",
  });
  return plain;
}

interface Captured {
  status: number;
  body: unknown;
}

async function call(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Captured> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/scim+json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await r.text();
  return {
    status: r.status,
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

async function cleanup(orgId: string, label: string): Promise<void> {
  // Tear down user_roles created in this run (matched on grantedBy).
  const groupRows = await db
    .select({ id: scimGroupsTable.id })
    .from(scimGroupsTable)
    .where(
      and(
        eq(scimGroupsTable.orgId, orgId),
        like(scimGroupsTable.displayName, `${RUN}%`),
      ),
    );
  const groupIds = groupRows.map((g) => g.id);
  if (groupIds.length > 0) {
    await db
      .delete(scimGroupMembersTable)
      .where(inArray(scimGroupMembersTable.groupId, groupIds));
    await db
      .delete(scimGroupsTable)
      .where(inArray(scimGroupsTable.id, groupIds));
  }
  await db
    .delete(userRolesTable)
    .where(
      and(
        eq(userRolesTable.orgId, orgId),
        like(userRolesTable.email, `%${RUN}%`),
      ),
    );
  await db
    .delete(apiKeysTable)
    .where(and(eq(apiKeysTable.orgId, orgId), eq(apiKeysTable.label, label)));
  await db
    .delete(adminAuditLogTable)
    .where(
      and(
        eq(adminAuditLogTable.orgId, orgId),
        like(adminAuditLogTable.targetLabel, `%${RUN}%`),
      ),
    );
}

test("ServiceProviderConfig advertises filter + patch and rejects analyst tokens", async () => {
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-admin`);
  const analystToken = await issueKey(orgId, "analyst", `${RUN}-analyst`);
  const handle = await startServer();
  try {
    const denied = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/ServiceProviderConfig`,
      analystToken,
    );
    assert.equal(denied.status, 401);

    const ok = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/ServiceProviderConfig`,
      adminToken,
    );
    assert.equal(ok.status, 200);
    const cfg = ok.body as {
      patch: { supported: boolean };
      filter: { supported: boolean; maxResults: number };
      authenticationSchemes: Array<{ type: string }>;
    };
    assert.equal(cfg.patch.supported, true);
    assert.equal(cfg.filter.supported, true);
    assert.ok(cfg.filter.maxResults >= 100);
    assert.equal(cfg.authenticationSchemes[0]?.type, "oauthbearertoken");
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-admin`);
    await cleanup(orgId, `${RUN}-analyst`);
  }
});

test("URL :orgId must match the bearer's tenant", async () => {
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-cross`);
  const handle = await startServer();
  try {
    const denied = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/some-other-org-id/ServiceProviderConfig`,
      adminToken,
    );
    assert.equal(denied.status, 401);
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-cross`);
  }
});

test("Users CRUD with filter, pagination, PATCH active toggle, and DELETE", async () => {
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-users`);
  const handle = await startServer();
  const userIds: string[] = [];
  try {
    // Create three users.
    const emails = [
      `${RUN}-alice@example.com`,
      `${RUN}-bob@example.com`,
      `${RUN}-carol@example.com`,
    ];
    for (const e of emails) {
      const r = await call(
        handle.port,
        "POST",
        `/api/scim/v2/orgs/${orgId}/Users`,
        adminToken,
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: e,
          externalId: `okta-${e}`,
          emails: [{ value: e, primary: true, type: "work" }],
          active: true,
        },
      );
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const obj = r.body as { id: string; userName: string; active: boolean };
      assert.equal(obj.userName, e);
      assert.equal(obj.active, true);
      userIds.push(obj.id);
    }

    // Conflict on duplicate POST.
    const dup = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: emails[0],
        externalId: `okta-${emails[0]}`,
        emails: [{ value: emails[0], primary: true }],
      },
    );
    assert.equal(dup.status, 409);
    const dupBody = dup.body as { scimType: string };
    assert.equal(dupBody.scimType, "uniqueness");

    // GET single.
    const single = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Users/${userIds[0]}`,
      adminToken,
    );
    assert.equal(single.status, 200);

    // GET list with pagination (count=2 of 3).
    const page1 = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Users?startIndex=1&count=2`,
      adminToken,
    );
    assert.equal(page1.status, 200);
    const p1 = page1.body as {
      totalResults: number;
      itemsPerPage: number;
      startIndex: number;
      Resources: Array<{ id: string }>;
    };
    assert.ok(p1.totalResults >= 3);
    assert.equal(p1.itemsPerPage, 2);
    assert.equal(p1.startIndex, 1);

    // GET list with filter `userName eq "alice@..."`.
    const filtered = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Users?filter=${encodeURIComponent(`userName eq "${emails[0]}"`)}`,
      adminToken,
    );
    assert.equal(filtered.status, 200);
    const f = filtered.body as {
      totalResults: number;
      Resources: Array<{ userName: string }>;
    };
    assert.equal(f.totalResults, 1);
    assert.equal(f.Resources[0]?.userName, emails[0]);

    // GET list with substring filter.
    const co = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Users?filter=${encodeURIComponent(`userName co "${RUN}"`)}`,
      adminToken,
    );
    assert.equal(co.status, 200);
    const coBody = co.body as { totalResults: number };
    assert.ok(coBody.totalResults >= 3);

    // PATCH suspend user (Okta replace path-style).
    const suspend = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Users/${userIds[0]}`,
      adminToken,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    );
    assert.equal(suspend.status, 200);
    const sBody = suspend.body as { active: boolean };
    assert.equal(sBody.active, false);

    // PATCH reactivate (Azure pathless replace).
    const reactivate = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Users/${userIds[0]}`,
      adminToken,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: true } }],
      },
    );
    assert.equal(reactivate.status, 200);
    const rBody = reactivate.body as { active: boolean };
    assert.equal(rBody.active, true);

    // DELETE — soft revoke.
    const del = await call(
      handle.port,
      "DELETE",
      `/api/scim/v2/orgs/${orgId}/Users/${userIds[1]}`,
      adminToken,
    );
    assert.equal(del.status, 204);
    const after = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Users/${userIds[1]}`,
      adminToken,
    );
    assert.equal(after.status, 200);
    const afterBody = after.body as { active: boolean };
    assert.equal(afterBody.active, false);
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-users`);
  }
});

test("Groups CRUD: SCIM POST /Groups + admin role mapping + member add grants user_roles", async () => {
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-groups`);
  const handle = await startServer();
  let userId: string | undefined;
  let groupId: string | undefined;
  try {
    // Provision a SCIM user we'll later add to a group.
    const userEmail = `${RUN}-dave@example.com`;
    const userExternal = `okta-${userEmail}`;
    const cu = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        externalId: userExternal,
        emails: [{ value: userEmail, primary: true }],
        active: true,
      },
    );
    assert.equal(cu.status, 201);
    userId = (cu.body as { id: string }).id;

    // Create a group through SCIM.
    const groupName = `${RUN}-procuro-approvers`;
    const cg = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Groups`,
      adminToken,
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: groupName,
        externalId: `okta-grp-${groupName}`,
      },
    );
    assert.equal(cg.status, 201, JSON.stringify(cg.body));
    const cgBody = cg.body as {
      id: string;
      displayName: string;
      "urn:ietf:params:scim:schemas:extension:procuro:2.0:Group": {
        roleMapping: string | null;
      };
    };
    groupId = cgBody.id;
    assert.equal(cgBody.displayName, groupName);
    assert.equal(
      cgBody[
        "urn:ietf:params:scim:schemas:extension:procuro:2.0:Group"
      ].roleMapping,
      null,
    );

    // GET groups list filtered by displayName.
    const lg = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Groups?filter=${encodeURIComponent(`displayName eq "${groupName}"`)}`,
      adminToken,
    );
    assert.equal(lg.status, 200);
    const lgBody = lg.body as { totalResults: number };
    assert.equal(lgBody.totalResults, 1);

    // Set role mapping via the admin API. We need an admin-scoped key
    // that authenticates against the tenant middleware (separate code
    // path from the SCIM bridge). The same `adminToken` works.
    const setMap = await call(
      handle.port,
      "PUT",
      `/api/admin/scim/groups/${groupId}/role-mapping`,
      adminToken,
      { roleMapping: "approver" },
    );
    assert.equal(setMap.status, 200);

    // PATCH add member: user is added by their Procuro user_roles.id.
    const addMember = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          {
            op: "add",
            path: "members",
            value: [{ value: userId, display: userEmail }],
          },
        ],
      },
    );
    assert.equal(addMember.status, 200, JSON.stringify(addMember.body));

    // The user should now have an `approver` user_roles row from the
    // group (in addition to the default `analyst` row from POST /Users).
    const grants = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.email, userEmail),
        ),
      );
    const approverRow = grants.find(
      (g) => g.role === "approver" && g.revokedAt === null,
    );
    assert.ok(
      approverRow,
      `expected an approver grant from the group; got: ${JSON.stringify(grants.map((g) => ({ role: g.role, via: g.grantedVia, revoked: g.revokedAt })))}`,
    );
    assert.equal(approverRow!.grantedVia, "scim-group");

    // PATCH remove member -> grant revoked.
    const rmMember = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          {
            op: "remove",
            path: `members[value eq "${userId}"]`,
          },
        ],
      },
    );
    assert.equal(rmMember.status, 200, JSON.stringify(rmMember.body));

    const after = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.id, approverRow!.id));
    assert.ok(after[0]?.revokedAt !== null, "expected approver grant revoked");

    // DELETE group revokes everything (re-add and check).
    await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
      {
        Operations: [
          { op: "add", path: "members", value: [{ value: userId }] },
        ],
      },
    );
    const delGroup = await call(
      handle.port,
      "DELETE",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
    );
    assert.equal(delGroup.status, 204);
    const grantsAfterDelete = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.email, userEmail),
          eq(userRolesTable.role, "approver"),
        ),
      );
    assert.ok(
      grantsAfterDelete.every((g) => g.revokedAt !== null),
      "deleting the group must revoke every approver grant it minted",
    );

    // 404 for the deleted group.
    const lookup = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
    );
    assert.equal(lookup.status, 404);
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-groups`);
  }
});

test("PATCH active=false on a user revokes group-derived grants too", async () => {
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-deprov`);
  const handle = await startServer();
  try {
    const userEmail = `${RUN}-eve@example.com`;
    const userExternal = `okta-${userEmail}`;
    const cu = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        externalId: userExternal,
        emails: [{ value: userEmail, primary: true }],
        active: true,
      },
    );
    assert.equal(cu.status, 201);
    const userId = (cu.body as { id: string }).id;

    const groupName = `${RUN}-readonly-grp`;
    const cg = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Groups`,
      adminToken,
      { displayName: groupName },
    );
    assert.equal(cg.status, 201);
    const groupId = (cg.body as { id: string }).id;

    await call(
      handle.port,
      "PUT",
      `/api/admin/scim/groups/${groupId}/role-mapping`,
      adminToken,
      { roleMapping: "read_only" },
    );

    await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
      {
        Operations: [
          { op: "add", path: "members", value: [{ value: userId }] },
        ],
      },
    );

    // Verify the read_only grant exists.
    const before = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.email, userEmail),
          eq(userRolesTable.role, "read_only"),
        ),
      );
    assert.ok(before[0] && before[0].revokedAt === null);

    // Suspend the user via PATCH.
    const sus = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Users/${userId}`,
      adminToken,
      {
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    );
    assert.equal(sus.status, 200);

    const after = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.email, userEmail),
        ),
      );
    assert.ok(
      after.every((g) => g.revokedAt !== null),
      `every role grant for a suspended user should be revoked. Got: ${JSON.stringify(after.map((g) => ({ role: g.role, via: g.grantedVia, revoked: g.revokedAt })))}`,
    );
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-deprov`);
  }
});

test("REGRESSION: remove → re-add same member must succeed and re-grant", async () => {
  // After remove, the user_roles row is revokedAt=now. Re-add must
  // not crash on the active-only partial unique index, and the user
  // must end up with an active grant again. We assert the response
  // status (was previously unasserted in the broader Groups test).
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-readd`);
  const handle = await startServer();
  try {
    const userEmail = `${RUN}-henry@example.com`;
    const cu = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        externalId: `okta-${userEmail}`,
        emails: [{ value: userEmail, primary: true }],
        active: true,
      },
    );
    assert.equal(cu.status, 201);
    const userId = (cu.body as { id: string }).id;

    const cg = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Groups`,
      adminToken,
      { displayName: `${RUN}-readd-grp` },
    );
    assert.equal(cg.status, 201);
    const groupId = (cg.body as { id: string }).id;

    await call(
      handle.port,
      "PUT",
      `/api/admin/scim/groups/${groupId}/role-mapping`,
      adminToken,
      { roleMapping: "approver" },
    );

    // ADD → REMOVE → ADD cycle.
    for (let i = 0; i < 2; i++) {
      const add = await call(
        handle.port,
        "PATCH",
        `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
        adminToken,
        {
          Operations: [
            { op: "add", path: "members", value: [{ value: userId }] },
          ],
        },
      );
      assert.equal(add.status, 200, JSON.stringify(add.body));
      const granted = await db
        .select()
        .from(userRolesTable)
        .where(
          and(
            eq(userRolesTable.orgId, orgId),
            eq(userRolesTable.email, userEmail),
            eq(userRolesTable.role, "approver"),
          ),
        );
      assert.ok(
        granted.some(
          (g) => g.revokedAt === null && g.grantedVia === "scim-group",
        ),
        `iteration ${i}: should have active approver grant after add`,
      );
      const remove = await call(
        handle.port,
        "PATCH",
        `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
        adminToken,
        {
          Operations: [
            { op: "remove", path: `members[value eq "${userId}"]` },
          ],
        },
      );
      assert.equal(remove.status, 200, JSON.stringify(remove.body));
      const afterRemove = await db
        .select()
        .from(userRolesTable)
        .where(
          and(
            eq(userRolesTable.orgId, orgId),
            eq(userRolesTable.email, userEmail),
            eq(userRolesTable.role, "approver"),
          ),
        );
      assert.ok(
        afterRemove.every(
          (g) => g.grantedVia !== "scim-group" || g.revokedAt !== null,
        ),
        `iteration ${i}: every group-derived approver grant should be revoked after remove`,
      );
    }

    // Final add should still produce exactly ONE active group-derived grant.
    const finalAdd = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
      {
        Operations: [
          { op: "add", path: "members", value: [{ value: userId }] },
        ],
      },
    );
    assert.equal(finalAdd.status, 200);
    const finalRows = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.email, userEmail),
          eq(userRolesTable.role, "approver"),
          eq(userRolesTable.grantedVia, "scim-group"),
          isNull(userRolesTable.revokedAt),
        ),
      );
    assert.equal(
      finalRows.length,
      1,
      "exactly one active group-derived approver grant is permitted",
    );
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-readd`);
  }
});

test("REGRESSION: mapping null↔role↔null↔role cycles never crash and converge correctly", async () => {
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-cycle`);
  const handle = await startServer();
  try {
    const userEmail = `${RUN}-iris@example.com`;
    const cu = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        externalId: `okta-${userEmail}`,
        emails: [{ value: userEmail, primary: true }],
      },
    );
    assert.equal(cu.status, 201);
    const userId = (cu.body as { id: string }).id;

    // Group with member but no mapping.
    const cg = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Groups`,
      adminToken,
      { displayName: `${RUN}-cycle-grp`, members: [{ value: userId }] },
    );
    assert.equal(cg.status, 201);
    const groupId = (cg.body as { id: string }).id;

    // Cycle the mapping multiple times.
    for (const role of [
      "approver",
      null,
      "read_only",
      null,
      "approver",
    ] as const) {
      const r = await call(
        handle.port,
        "PUT",
        `/api/admin/scim/groups/${groupId}/role-mapping`,
        adminToken,
        { roleMapping: role },
      );
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    // After the final cycle (mapping=approver), the user should hold
    // exactly one ACTIVE approver grant via this group, and any
    // earlier read_only grant must be revoked.
    const grants = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.email, userEmail),
          eq(userRolesTable.grantedVia, "scim-group"),
        ),
      );
    const activeApprover = grants.filter(
      (g) => g.role === "approver" && g.revokedAt === null,
    );
    assert.equal(activeApprover.length, 1);
    const activeReadOnly = grants.filter(
      (g) => g.role === "read_only" && g.revokedAt === null,
    );
    assert.equal(activeReadOnly.length, 0);
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-cycle`);
  }
});

test("REGRESSION: SCIM group add for a SUSPENDED user must NOT grant access", async () => {
  // Reviewer-flagged authorisation integrity test: deactivating a
  // user end-to-end should be sticky. A subsequent group add (or
  // mapping change) MUST NOT mint a fresh active grant that
  // re-authorises the suspended user.
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-suspended`);
  const handle = await startServer();
  try {
    const userEmail = `${RUN}-jude@example.com`;
    const cu = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        externalId: `okta-${userEmail}`,
        emails: [{ value: userEmail, primary: true }],
      },
    );
    assert.equal(cu.status, 201);
    const userId = (cu.body as { id: string }).id;

    const cg = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Groups`,
      adminToken,
      { displayName: `${RUN}-suspended-grp` },
    );
    assert.equal(cg.status, 201);
    const groupId = (cg.body as { id: string }).id;

    await call(
      handle.port,
      "PUT",
      `/api/admin/scim/groups/${groupId}/role-mapping`,
      adminToken,
      { roleMapping: "approver" },
    );

    // Suspend the user FIRST.
    const sus = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Users/${userId}`,
      adminToken,
      {
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    );
    assert.equal(sus.status, 200);

    // Now try to add them to the group via SCIM PATCH.
    const add = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
      {
        Operations: [
          { op: "add", path: "members", value: [{ value: userId }] },
        ],
      },
    );
    assert.equal(add.status, 200);

    let grants = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.email, userEmail),
        ),
      );
    assert.ok(
      grants.every((g) => g.revokedAt !== null),
      `suspended user must not have any active grant after group add. Got: ${JSON.stringify(grants.map((g) => ({ role: g.role, via: g.grantedVia, revoked: g.revokedAt })))}`,
    );

    // Same protection on mapping change: switch mapping while
    // member is in the group; suspended user must still have NO
    // active grant.
    await call(
      handle.port,
      "PUT",
      `/api/admin/scim/groups/${groupId}/role-mapping`,
      adminToken,
      { roleMapping: "read_only" },
    );
    grants = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.email, userEmail),
        ),
      );
    assert.ok(
      grants.every((g) => g.revokedAt !== null),
      `suspended user must not be re-authorised by mapping change. Got: ${JSON.stringify(grants.map((g) => ({ role: g.role, via: g.grantedVia, revoked: g.revokedAt })))}`,
    );
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-suspended`);
  }
});

test("REGRESSION: POST /Users uniqueness keys on userName, not externalId", async () => {
  // RFC 7644 §3.3: a duplicate POST against the same userName MUST
  // return 409 even when externalId differs (e.g. operator switched
  // IdPs). Previously the check was on externalId only.
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-uname`);
  const handle = await startServer();
  try {
    const userEmail = `${RUN}-kara@example.com`;
    const r1 = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        externalId: `okta-${userEmail}-A`,
        emails: [{ value: userEmail, primary: true }],
      },
    );
    assert.equal(r1.status, 201);

    const r2 = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        // Different externalId, same userName.
        externalId: `azure-${userEmail}-B`,
        emails: [{ value: userEmail, primary: true }],
      },
    );
    assert.equal(r2.status, 409);
    assert.equal(
      (r2.body as { scimType?: string }).scimType,
      "uniqueness",
      "must return scimType=uniqueness on duplicate userName",
    );
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-uname`);
  }
});

test("REGRESSION: deleted SCIM group can be recreated under the same name/externalId", async () => {
  // The unique indexes on (orgId, displayName) and (orgId, externalId)
  // are partial WHERE deletedAt IS NULL — re-creating a group after
  // delete must succeed (common Okta retry flow).
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-recreate`);
  const handle = await startServer();
  try {
    const displayName = `${RUN}-recreate-grp`;
    const externalId = `okta-${displayName}`;
    const c1 = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Groups`,
      adminToken,
      { displayName, externalId },
    );
    assert.equal(c1.status, 201);
    const groupId1 = (c1.body as { id: string }).id;

    const d1 = await call(
      handle.port,
      "DELETE",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId1}`,
      adminToken,
    );
    assert.equal(d1.status, 204);

    // Re-create with the same displayName + externalId.
    const c2 = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Groups`,
      adminToken,
      { displayName, externalId },
    );
    assert.equal(c2.status, 201, JSON.stringify(c2.body));
    const groupId2 = (c2.body as { id: string }).id;
    assert.notEqual(groupId1, groupId2, "must mint a fresh group id");
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-recreate`);
  }
});

test("REGRESSION: SCIM suspend revokes scim + scim-group but NOT manual grants", async () => {
  // Documents the deprovisioning policy in SCIM.md §0: SCIM
  // active=false is a statement about the SCIM-managed identity,
  // not a cross-source kill switch.
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-deprovpol`);
  const handle = await startServer();
  try {
    const userEmail = `${RUN}-leah@example.com`;
    const externalId = `okta-${userEmail}`;
    const cu = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        externalId,
        emails: [{ value: userEmail, primary: true }],
      },
    );
    assert.equal(cu.status, 201);
    const userId = (cu.body as { id: string }).id;

    // Manual grant from "another admin".
    const manualGrantId = newId("usrrole");
    await db.insert(userRolesTable).values({
      id: manualGrantId,
      userId: externalId,
      orgId,
      role: "auditor",
      email: userEmail,
      grantedVia: "manual",
      grantedBy: "test-admin@example.com",
    });

    // SCIM suspend.
    const sus = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Users/${userId}`,
      adminToken,
      { Operations: [{ op: "replace", path: "active", value: false }] },
    );
    assert.equal(sus.status, 200);

    const scimRow = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.id, userId));
    assert.notEqual(
      scimRow[0]?.revokedAt,
      null,
      "scim identity row must be revoked",
    );

    const manualAfter = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.id, manualGrantId));
    assert.equal(
      manualAfter[0]?.revokedAt,
      null,
      "manual grant must NOT be revoked by SCIM suspend (per docs §0)",
    );

    // Cleanup.
    await db.delete(userRolesTable).where(eq(userRolesTable.id, manualGrantId));
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-deprovpol`);
  }
});

test("REGRESSION: DELETE /Users is total deprovision (revokes manual + clerk too)", async () => {
  // Documents the deprovisioning policy in SCIM.md §0: DELETE is the
  // unambiguous offboarding signal and revokes EVERY active grant
  // for the user in the tenant — scim, scim-group, manual, clerk.
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-deletepol`);
  const handle = await startServer();
  try {
    const userEmail = `${RUN}-mark@example.com`;
    const externalId = `okta-${userEmail}`;
    const cu = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        externalId,
        emails: [{ value: userEmail, primary: true }],
      },
    );
    assert.equal(cu.status, 201);
    const userId = (cu.body as { id: string }).id;

    // Two non-SCIM grants: one manual, one clerk.
    const manualGrantId = newId("usrrole");
    const clerkGrantId = newId("usrrole");
    await db.insert(userRolesTable).values([
      {
        id: manualGrantId,
        userId: externalId,
        orgId,
        role: "auditor",
        email: userEmail,
        grantedVia: "manual",
        grantedBy: "test-admin@example.com",
      },
      {
        id: clerkGrantId,
        userId: externalId,
        orgId,
        role: "approver",
        email: userEmail,
        grantedVia: "clerk",
        grantedBy: "clerk-org-webhook",
      },
    ]);

    // SCIM DELETE — total deprovision.
    const del = await call(
      handle.port,
      "DELETE",
      `/api/scim/v2/orgs/${orgId}/Users/${userId}`,
      adminToken,
    );
    assert.equal(del.status, 204);

    for (const id of [userId, manualGrantId, clerkGrantId]) {
      const row = await db
        .select()
        .from(userRolesTable)
        .where(eq(userRolesTable.id, id));
      assert.notEqual(
        row[0]?.revokedAt,
        null,
        `${id} must be revoked by SCIM DELETE (per docs §0)`,
      );
    }
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-deletepol`);
  }
});

test("REGRESSION: malformed trailing filter token returns 400 invalidFilter", async () => {
  // Reviewer-suggested hardening: parser must remain RFC-strict on
  // dangling/malformed tokens rather than silently truncating.
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-malformed`);
  const handle = await startServer();
  try {
    const cases = [
      'userName eq', // missing value
      'userName eq "alice@x.com" and', // dangling AND
      'userName eq "alice@x.com" and externalId', // missing op + value
      'userName foo "alice@x.com"', // unknown operator
    ];
    for (const f of cases) {
      const r = await call(
        handle.port,
        "GET",
        `/api/scim/v2/orgs/${orgId}/Users?filter=${encodeURIComponent(f)}`,
        adminToken,
      );
      assert.equal(r.status, 400, `case "${f}" should be 400`);
      assert.equal(
        (r.body as { scimType?: string }).scimType,
        "invalidFilter",
        `case "${f}" should be invalidFilter`,
      );
    }
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-malformed`);
  }
});

test("REGRESSION: invalid filter returns SCIM 400 invalidFilter", async () => {
  // RFC 7644 §3.4.2.2 — provider that supports filter MUST return
  // 400 + scimType=invalidFilter for syntactically invalid or
  // unsupported filters, not silently return all rows.
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-filter`);
  const handle = await startServer();
  try {
    // Garbage syntax.
    const u1 = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Users?filter=${encodeURIComponent("totally not a filter")}`,
      adminToken,
    );
    assert.equal(u1.status, 400);
    assert.equal((u1.body as { scimType?: string }).scimType, "invalidFilter");

    // Unsupported attribute.
    const u2 = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Users?filter=${encodeURIComponent('nickName eq "x"')}`,
      adminToken,
    );
    assert.equal(u2.status, 400);
    assert.equal((u2.body as { scimType?: string }).scimType, "invalidFilter");

    // Unsupported group attribute.
    const g1 = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Groups?filter=${encodeURIComponent('description co "team"')}`,
      adminToken,
    );
    assert.equal(g1.status, 400);
    assert.equal((g1.body as { scimType?: string }).scimType, "invalidFilter");

    // Valid filter still works (sanity).
    const ok = await call(
      handle.port,
      "GET",
      `/api/scim/v2/orgs/${orgId}/Users?filter=${encodeURIComponent('userName eq "no-such@example.com"')}`,
      adminToken,
    );
    assert.equal(ok.status, 200);
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-filter`);
  }
});

test("REGRESSION: SCIM group never revokes a manual grant for the same role", async () => {
  // Reviewer-flagged authorisation integrity test (task #151 review):
  // if a user already holds the target role from a manual grant,
  // adding/removing them from a SCIM group whose mapping is the same
  // role MUST NOT revoke the manual grant. The SCIM bridge can only
  // ever revoke grants it minted itself (grantedVia=scim-group AND
  // grantedBy=scim-group:<thisGroupId>).
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-overlap`);
  const handle = await startServer();
  try {
    const userEmail = `${RUN}-grace@example.com`;
    const externalId = `okta-${userEmail}`;

    // SCIM-provision the user (default analyst).
    const cu = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        externalId,
        emails: [{ value: userEmail, primary: true }],
        active: true,
      },
    );
    assert.equal(cu.status, 201);
    const userRoleId = (cu.body as { id: string }).id;

    // Manually grant the same role the group is going to map to.
    const manualGrantId = newId("usrrole");
    await db.insert(userRolesTable).values({
      id: manualGrantId,
      userId: externalId,
      orgId,
      role: "approver",
      email: userEmail,
      grantedVia: "manual",
      grantedBy: "test-admin@example.com",
    });

    // Create a SCIM group + map to approver.
    const cg = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Groups`,
      adminToken,
      { displayName: `${RUN}-overlap-grp` },
    );
    assert.equal(cg.status, 201);
    const groupId = (cg.body as { id: string }).id;

    // Set mapping AFTER manual grant exists. Re-projection MUST NOT
    // touch the manual grant — both because the existing row is not
    // owned by this group and because no membership rows exist yet.
    const setMap = await call(
      handle.port,
      "PUT",
      `/api/admin/scim/groups/${groupId}/role-mapping`,
      adminToken,
      { roleMapping: "approver" },
    );
    assert.equal(setMap.status, 200);

    let manual = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.id, manualGrantId));
    assert.equal(
      manual[0]?.revokedAt,
      null,
      "setting mapping must not revoke a pre-existing manual grant",
    );

    // PATCH add member. Bridge must detect the foreign grant and
    // refuse to take ownership: store grantedUserRoleId=null on the
    // membership row.
    const addMember = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
      {
        Operations: [
          {
            op: "add",
            path: "members",
            value: [{ value: userRoleId }],
          },
        ],
      },
    );
    assert.equal(addMember.status, 200);

    manual = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.id, manualGrantId));
    assert.equal(
      manual[0]?.revokedAt,
      null,
      "adding to SCIM group must not change the manual grant",
    );

    const memberRows = await db
      .select()
      .from(scimGroupMembersTable)
      .where(eq(scimGroupMembersTable.groupId, groupId));
    assert.equal(memberRows.length, 1);
    assert.equal(
      memberRows[0]?.grantedUserRoleId,
      null,
      "membership must NOT claim ownership of a foreign grant",
    );

    // PATCH remove member. Manual grant still untouched.
    const rm = await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
      {
        Operations: [
          { op: "remove", path: `members[value eq "${userRoleId}"]` },
        ],
      },
    );
    assert.equal(rm.status, 200);
    manual = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.id, manualGrantId));
    assert.equal(
      manual[0]?.revokedAt,
      null,
      "removing from SCIM group must not revoke the manual grant",
    );

    // DELETE group — still no impact on manual grant.
    await call(
      handle.port,
      "PATCH",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
      {
        Operations: [
          { op: "add", path: "members", value: [{ value: userRoleId }] },
        ],
      },
    );
    const dg = await call(
      handle.port,
      "DELETE",
      `/api/scim/v2/orgs/${orgId}/Groups/${groupId}`,
      adminToken,
    );
    assert.equal(dg.status, 204);
    manual = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.id, manualGrantId));
    assert.equal(
      manual[0]?.revokedAt,
      null,
      "deleting the SCIM group must not revoke the manual grant",
    );

    // Cleanup the manual grant we inserted directly.
    await db.delete(userRolesTable).where(eq(userRolesTable.id, manualGrantId));
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-overlap`);
  }
});

test("Setting role mapping later projects across existing memberships", async () => {
  const orgId = await pickOrgId();
  const adminToken = await issueKey(orgId, "org_admin", `${RUN}-late`);
  const handle = await startServer();
  try {
    const userEmail = `${RUN}-frank@example.com`;
    const cu = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Users`,
      adminToken,
      {
        userName: userEmail,
        externalId: `okta-${userEmail}`,
        emails: [{ value: userEmail, primary: true }],
      },
    );
    assert.equal(cu.status, 201);
    const userId = (cu.body as { id: string }).id;

    // Create group WITHOUT a mapping, push members.
    const cg = await call(
      handle.port,
      "POST",
      `/api/scim/v2/orgs/${orgId}/Groups`,
      adminToken,
      {
        displayName: `${RUN}-late-mapping`,
        members: [{ value: userId }],
      },
    );
    assert.equal(cg.status, 201);
    const groupId = (cg.body as { id: string }).id;

    // No approver grant yet.
    const before = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.email, userEmail),
          eq(userRolesTable.role, "approver"),
          eq(userRolesTable.grantedVia, "scim-group"),
        ),
      );
    assert.equal(before.length, 0);

    // Now set the mapping. Existing membership should be projected.
    const setMap = await call(
      handle.port,
      "PUT",
      `/api/admin/scim/groups/${groupId}/role-mapping`,
      adminToken,
      { roleMapping: "approver" },
    );
    assert.equal(setMap.status, 200);

    const after = await db
      .select()
      .from(userRolesTable)
      .where(
        and(
          eq(userRolesTable.orgId, orgId),
          eq(userRolesTable.email, userEmail),
          eq(userRolesTable.role, "approver"),
          eq(userRolesTable.grantedVia, "scim-group"),
        ),
      );
    assert.ok(
      after[0] && after[0].revokedAt === null,
      "changing the mapping should immediately mint approver grants for existing members",
    );

    // Clear mapping → grant revoked.
    const clear = await call(
      handle.port,
      "PUT",
      `/api/admin/scim/groups/${groupId}/role-mapping`,
      adminToken,
      { roleMapping: null },
    );
    assert.equal(clear.status, 200);
    const cleared = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.id, after[0]!.id));
    assert.ok(
      cleared[0]?.revokedAt !== null,
      "clearing the mapping must revoke previously-minted grants",
    );

    // Cannot map to platform_admin.
    const bad = await call(
      handle.port,
      "PUT",
      `/api/admin/scim/groups/${groupId}/role-mapping`,
      adminToken,
      { roleMapping: "platform_admin" },
    );
    assert.equal(bad.status, 400);
  } finally {
    await handle.close();
    await cleanup(orgId, `${RUN}-late`);
  }
});
