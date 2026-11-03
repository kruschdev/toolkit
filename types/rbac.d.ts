import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export type RbacErrorCode =
    | 'RBAC_UNAUTHENTICATED'
    | 'RBAC_INVALID_POLICY'
    | 'RBAC_INVALID_PERMISSION'
    | 'RBAC_INVALID_RESOURCE'
    | 'RBAC_INVALID_OPTIONS'
    | 'RBAC_EXPLICIT_DENY'
    | 'RBAC_FORBIDDEN'
    | 'RBAC_MISSING_SUBJECT_TENANT'
    | 'RBAC_MISSING_RESOURCE_TENANT'
    | 'RBAC_CROSS_TENANT_DENIED'
    | 'RBAC_NOT_RESOURCE_OWNER'
    | 'RBAC_RESOLVER_ERROR'
    | (string & {});

export interface RbacRoleDefinition {
    allow?: readonly string[];
    deny?: readonly string[];
    inherits?: readonly string[];
    allowCrossTenant?: boolean;
    description?: string;
}

export interface RbacPolicyDefinition {
    roles?: Record<string, RbacRoleDefinition>;
}

export interface CreateRbacPolicyOptions {
    maxInheritanceDepth?: number;
}

export interface CompiledRbacRolePermissions {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
    readonly allowCrossTenant: boolean;
    readonly inherits: readonly string[];
    readonly description: string;
}

export interface RbacSubject {
    id?: string | number | null;
    tenantId?: string | null;
    role?: string | null;
    roles?: readonly string[];
    permissions?: readonly string[];
    denyPermissions?: readonly string[];
    allowCrossTenant?: boolean;
}

export interface RbacErrorDetails {
    statusCode: number;
    permission?: string | null;
    matchedDeny?: string;
    tenantField?: string;
    ownerField?: string;
    [key: string]: unknown;
}

export interface AssertTenantOwnershipOptions {
    allowCrossTenant?: boolean;
    checkOwner?: boolean;
    ownerField?: string;
    tenantField?: string;
    tool?: string;
}

export interface TenantOwnershipData {
    allowed: true;
    tenantId: string | null;
    resourceTenantId: string | null;
    crossTenant: boolean;
    ownerChecked: boolean;
    ownerId?: string | null;
}

export interface EvaluateAccessOptions {
    resource?: unknown;
    requireTenantMatch?: boolean;
    checkOwner?: boolean;
    ownerField?: string;
    tenantField?: string;
    tool?: string;
}

export interface AccessGrantData {
    allowed: true;
    subjectId: unknown;
    tenantId: unknown;
    permission: string;
    matchedGrant: string;
}

export interface RbacPolicy {
    listRoles(): string[];
    getRolePermissions(roleName: string): CompiledRbacRolePermissions | null;
    evaluate(
        subject: RbacSubject | object | null | undefined,
        permission: string,
        options?: EvaluateAccessOptions
    ): LegoEnvelope<AccessGrantData, RbacErrorDetails>;
}

export type RbacPermissionInput<TReq = Record<string, any>, TSubject = RbacSubject | null> =
    | string
    | ((req: TReq, subject: TSubject) => string | Promise<string>);

export interface RbacAuditEvent<TReq = Record<string, any>, TResource = unknown> {
    allowed: boolean;
    outcome: 'ALLOW' | 'DENY';
    code: string;
    subjectId: unknown;
    tenantId: unknown;
    permission: string;
    subject: unknown;
    resource: TResource | null;
    decision: LegoEnvelope<AccessGrantData, RbacErrorDetails>;
    req: TReq;
}

export interface CreateRbacGuardOptions<TReq = Record<string, any>, TResource = unknown> {
    resolveSubject?: ((req: TReq) => RbacSubject | object | null | undefined | Promise<RbacSubject | object | null | undefined>) | null;
    resolveResource?: ((req: TReq, subject: any) => TResource | null | undefined | Promise<TResource | null | undefined>) | null;
    requireTenantMatch?: boolean;
    checkOwner?: boolean;
    ownerField?: string;
    tenantField?: string;
    onAudit?: ((event: RbacAuditEvent<TReq, TResource>) => unknown | Promise<unknown>) | null;
    tool?: string;
}

export type RbacGuardNext = (err?: unknown) => unknown;

export type RbacGuardMiddleware<TReq = Record<string, any>, TRes = Record<string, any>> = (
    req: TReq,
    res: TRes,
    next?: RbacGuardNext
) => Promise<unknown>;

export declare function matchPermissionPattern(
    grantedPattern: string,
    requiredPermission: string
): boolean;

export declare function createRbacPolicy(
    policyDefinition?: RbacPolicyDefinition,
    options?: CreateRbacPolicyOptions
): RbacPolicy;

export declare function assertTenantOwnership(
    subject: RbacSubject | object | null | undefined,
    resource: object | null | undefined,
    options?: AssertTenantOwnershipOptions
): LegoEnvelope<TenantOwnershipData, RbacErrorDetails>;

export declare function evaluateAccess(
    policy: RbacPolicy,
    subject: RbacSubject | object | null | undefined,
    permission: string,
    options?: EvaluateAccessOptions
): LegoEnvelope<AccessGrantData, RbacErrorDetails>;

export declare function createRbacGuard<
    TReq = Record<string, any>,
    TRes = Record<string, any>,
    TResource = unknown
>(
    policy: RbacPolicy,
    permission: RbacPermissionInput<TReq>,
    options?: CreateRbacGuardOptions<TReq, TResource>
): RbacGuardMiddleware<TReq, TRes>;
