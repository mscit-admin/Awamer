/**
 * Companies (tenants) and the organizational hierarchy.
 *
 * A company owns an arbitrary-depth forest of `org_units` (departments →
 * sections → units → …). Everything here is plain CRUD; tenant scoping (who
 * may see which company) is enforced in the routes.
 */
import { v4 as uuid } from "uuid";
import type { Pool } from "../db/index.js";

export interface Company {
  id: string;
  name: string;
  slug: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrgUnit {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  kind: string;
  sort: number;
  createdAt: Date;
  updatedAt: Date;
}

interface CompanyRow {
  id: string; name: string; slug: string | null; is_active: boolean;
  created_at: Date; updated_at: Date;
}
interface OrgUnitRow {
  id: string; company_id: string; parent_id: string | null; name: string;
  kind: string; sort: number; created_at: Date; updated_at: Date;
}

const toCompany = (r: CompanyRow): Company => ({
  id: r.id, name: r.name, slug: r.slug, isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toUnit = (r: OrgUnitRow): OrgUnit => ({
  id: r.id, companyId: r.company_id, parentId: r.parent_id, name: r.name,
  kind: r.kind, sort: r.sort, createdAt: r.created_at, updatedAt: r.updated_at,
});

export class CompanyRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Company[]> {
    const { rows } = await this.pool.query<CompanyRow>(`SELECT * FROM companies ORDER BY name ASC`);
    return rows.map(toCompany);
  }

  async getById(id: string): Promise<Company | null> {
    const { rows } = await this.pool.query<CompanyRow>(`SELECT * FROM companies WHERE id = $1`, [id]);
    return rows[0] ? toCompany(rows[0]) : null;
  }

  async create(name: string, slug: string | null): Promise<Company> {
    const { rows } = await this.pool.query<CompanyRow>(
      `INSERT INTO companies (id, name, slug) VALUES ($1, $2, $3) RETURNING *`,
      [uuid(), name, slug],
    );
    return toCompany(rows[0]!);
  }

  async update(id: string, patch: { name?: string; slug?: string | null; isActive?: boolean }): Promise<Company | null> {
    const { rows } = await this.pool.query<CompanyRow>(
      `UPDATE companies
          SET name = COALESCE($2, name),
              slug = CASE WHEN $3::boolean THEN $4 ELSE slug END,
              is_active = COALESCE($5, is_active),
              updated_at = NOW()
        WHERE id = $1
      RETURNING *`,
      [id, patch.name ?? null, patch.slug !== undefined, patch.slug ?? null, patch.isActive ?? null],
    );
    return rows[0] ? toCompany(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM companies WHERE id = $1`, [id]);
  }

  /** How many users currently belong to a company. */
  async userCount(id: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM users WHERE company_id = $1`, [id]);
    return Number(rows[0]?.n ?? 0);
  }
}

export class OrgUnitRepository {
  constructor(private readonly pool: Pool) {}

  async listByCompany(companyId: string): Promise<OrgUnit[]> {
    const { rows } = await this.pool.query<OrgUnitRow>(
      `SELECT * FROM org_units WHERE company_id = $1 ORDER BY sort ASC, name ASC`,
      [companyId],
    );
    return rows.map(toUnit);
  }

  async getById(id: string): Promise<OrgUnit | null> {
    const { rows } = await this.pool.query<OrgUnitRow>(`SELECT * FROM org_units WHERE id = $1`, [id]);
    return rows[0] ? toUnit(rows[0]) : null;
  }

  async create(input: { companyId: string; parentId: string | null; name: string; kind: string; sort?: number }): Promise<OrgUnit> {
    const { rows } = await this.pool.query<OrgUnitRow>(
      `INSERT INTO org_units (id, company_id, parent_id, name, kind, sort)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [uuid(), input.companyId, input.parentId, input.name, input.kind, input.sort ?? 0],
    );
    return toUnit(rows[0]!);
  }

  async update(id: string, patch: { name?: string; kind?: string; parentId?: string | null; sort?: number }): Promise<OrgUnit | null> {
    const { rows } = await this.pool.query<OrgUnitRow>(
      `UPDATE org_units
          SET name = COALESCE($2, name),
              kind = COALESCE($3, kind),
              parent_id = CASE WHEN $4::boolean THEN $5 ELSE parent_id END,
              sort = COALESCE($6, sort),
              updated_at = NOW()
        WHERE id = $1
      RETURNING *`,
      [id, patch.name ?? null, patch.kind ?? null, patch.parentId !== undefined, patch.parentId ?? null, patch.sort ?? null],
    );
    return rows[0] ? toUnit(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    // Children cascade via the FK (ON DELETE CASCADE).
    await this.pool.query(`DELETE FROM org_units WHERE id = $1`, [id]);
  }
}
