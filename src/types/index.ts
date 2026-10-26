// Custom types for the application

export type AuthUser = {
  id: string;
  tenantId: string;
  outletId: string | null;
  role: string;
  fullName?: string;
  email?: string;
};

// Extend Hono context variables
declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
    tenantId: string;
  }
}
