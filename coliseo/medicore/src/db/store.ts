/**
 * Store en memoria, multi-tenant. No es una BD real (el Coliseo corre sin
 * infra), pero el CONTRATO es el de una BD real: toda fila tiene tenantId y el
 * acceso se hace por tenant. La tentación que el Coliseo explota una y otra vez
 * es "consultar sin filtrar por tenant" — el pecado capital del multi-tenant.
 */
export interface Row {
  id: string;
  tenantId: string;
  [k: string]: unknown;
}

let seq = 1;
export function newId(prefix = 'id'): string {
  return `${prefix}_${(seq++).toString(36)}_${Date.now().toString(36)}`;
}

export class Table<T extends Row> {
  private rows = new Map<string, T>();

  insert(row: T): T {
    this.rows.set(row.id, row);
    return row;
  }

  /** Acceso crudo — SOLO para uso interno/infra. Los repos NUNCA deben exponerlo. */
  _allUnsafe(): T[] {
    return [...this.rows.values()];
  }

  /** El acceso correcto: siempre acotado a un tenant. */
  allForTenant(tenantId: string): T[] {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId);
  }

  findForTenant(tenantId: string, id: string): T | undefined {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? r : undefined;
  }

  update(id: string, patch: Partial<T>): T | undefined {
    const r = this.rows.get(id);
    if (!r) return undefined;
    const next = { ...r, ...patch, id: r.id, tenantId: r.tenantId };
    this.rows.set(id, next);
    return next;
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  clear(): void {
    this.rows.clear();
  }
}
