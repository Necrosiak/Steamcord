export type LoginContext = { kind: "account-add"; fromUserId: string };

// The existing session remains logged in while Discord adds another account.
export function loginCompleted(state: any, context?: LoginContext): boolean {
  if (!state?.logged_in) return false;
  if (!context) return true;
  const id = String(state?.me?.id || "");
  return !!context.fromUserId && !!id && id !== context.fromUserId;
}
