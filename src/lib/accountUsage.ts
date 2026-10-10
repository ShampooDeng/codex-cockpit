/** Local declarations only: never attach these to feedback or sync payloads. */
export interface AccountUsageDeclaration {
  scope: string;
  mode: "exclusive" | "shared" | "unconfirmed";
  personId: string;
  effectiveFrom: string;
  declaredAt: string;
}

export interface AccountUsageContext {
  scope: string | null;
  declarations: readonly AccountUsageDeclaration[];
}

export const EMPTY_ACCOUNT_USAGE: AccountUsageContext = { scope: null, declarations: [] };
export const MAX_ACCOUNT_DECLARATIONS = 128;

export function validDeclarationDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function normalizeAccountUsage(value: unknown): AccountUsageDeclaration[] {
  if (!Array.isArray(value) || value.length > MAX_ACCOUNT_DECLARATIONS) return [];
  // Fail closed as a whole: dropping an invalid later boundary could revive an old exclusive declaration.
  const valid = value.every((item: Partial<AccountUsageDeclaration> | null) => item && typeof item === "object"
    && typeof item.scope === "string" && /^[a-f0-9]{64}$/.test(item.scope)
    && ["exclusive", "shared", "unconfirmed"].includes(item.mode ?? "")
    && typeof item.personId === "string" && item.personId.length > 0 && item.personId.length <= 128 && !/[\u0000-\u001f\u007f]/.test(item.personId)
    && typeof item.effectiveFrom === "string" && validDeclarationDate(item.effectiveFrom)
    && typeof item.declaredAt === "string" && Number.isFinite(Date.parse(item.declaredAt)));
  if (!valid) return [];
  return value.map(item => ({ scope: item.scope, mode: item.mode, personId: item.personId, effectiveFrom: item.effectiveFrom, declaredAt: item.declaredAt }));
}

/** A declaration applies until the next dated boundary in the same profile. */
export function accountUsageAt(context: AccountUsageContext, date: string): AccountUsageDeclaration | null {
  if (!context.scope || !validDeclarationDate(date)) return null;
  return context.declarations.filter(item => item.scope === context.scope && item.effectiveFrom <= date)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || Date.parse(b.declaredAt) - Date.parse(a.declaredAt))[0] ?? null;
}

export function addAccountUsageDeclaration(values: readonly AccountUsageDeclaration[], next: AccountUsageDeclaration): AccountUsageDeclaration[] {
  const result = [...values.filter(item => item.scope !== next.scope || item.effectiveFrom !== next.effectiveFrom), next];
  const normalized = normalizeAccountUsage(result);
  if (normalized.length !== result.length) throw new Error("Invalid account usage declaration");
  return normalized;
}
