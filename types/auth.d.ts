export interface AuthConfig {
    secret: string;
    cookieName?: string;
    expiresIn?: string;
    secureCookie?: boolean;
}

export interface AuthUser {
    id: string | number;
    email?: string;
    [key: string]: unknown;
}

export interface AuthHelper {
    signToken: (user: AuthUser) => string;
    setTokenCookie: (res: any, token: string) => void;
    clearTokenCookie: (res: any) => void;
    requireAuth: (req: any, res: any, next: (err?: unknown) => void) => unknown;
    optionalAuth: (req: any, res: any, next: (err?: unknown) => void) => void;
}

export declare function createAuth(config: AuthConfig): AuthHelper;
