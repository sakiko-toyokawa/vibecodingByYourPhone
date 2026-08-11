/**
 * Contract security level -> runtime-native permission projection.
 *
 * The intent contract is the source of truth for what a run may do. This
 * module turns that contract into the two surfaces the runtime actually
 * understands:
 *
 *  - permissionMode: the provider's native tool approval mode.
 *  - sandbox: the provider's OS/filesystem boundary (Codex), or "none"
 *    when the bridge has no OS sandbox (Claude).
 *  - approvalPolicy: how aggressively the runtime asks the server before a
 *    file/command action. Policy-hook runs use "untrusted" so every action
 *    reaches the loop policy hook instead of being auto-accepted by a
 *    permissive native mode.
 */

import type { PermissionMode, SecurityLevel } from "@yep-anywhere/shared";

export type RuntimeSandbox =
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
  | "none";

export type RuntimeApprovalPolicy = "untrusted" | "on-request" | "never";

export interface RuntimePermissionProjection {
  permissionMode: PermissionMode;
  sandbox: RuntimeSandbox;
  approvalPolicy: RuntimeApprovalPolicy;
}

const NATIVE_PERMISSION_BY_LEVEL: Record<
  SecurityLevel,
  RuntimePermissionProjection
> = {
  read_only: {
    permissionMode: "plan",
    sandbox: "read-only",
    approvalPolicy: "on-request",
  },
  workspace_write: {
    permissionMode: "default",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  },
  full_access: {
    permissionMode: "bypassPermissions",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  },
};

export function projectRuntimePermission(
  securityLevel: SecurityLevel,
  options: {
    policyHookWired: boolean;
    bridge: string;
  },
): RuntimePermissionProjection {
  const native =
    NATIVE_PERMISSION_BY_LEVEL[securityLevel] ??
    NATIVE_PERMISSION_BY_LEVEL.read_only;
  if (!options.policyHookWired) {
    return {
      ...native,
      sandbox: options.bridge === "agent_sdk" ? "none" : native.sandbox,
    };
  }
  return {
    permissionMode: native.permissionMode,
    // Claude's agent SDK has no OS sandbox; the policy hook plus read-only
    // tools are the boundary there. Codex keeps the native sandbox but asks
    // for every file/command action so the hook remains the decision source.
    sandbox: options.bridge === "agent_sdk" ? "none" : native.sandbox,
    approvalPolicy: "untrusted",
  };
}
