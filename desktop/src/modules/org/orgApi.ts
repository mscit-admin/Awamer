/** Companies (tenants) + organizational hierarchy API. */
import { request } from "@/shared/lib/api";

export interface Company {
  id: string;
  name: string;
  slug: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrgUnit {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  kind: string;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

export const orgApi = {
  listCompanies() {
    return request<{ companies: Company[] }>("/api/v1/org/companies").then((r) => r.companies);
  },
  createCompany(name: string, slug?: string | null) {
    return request<{ company: Company }>("/api/v1/org/companies", { method: "POST", body: { name, slug: slug || null } }).then((r) => r.company);
  },
  updateCompany(id: string, patch: { name?: string; slug?: string | null; is_active?: boolean }) {
    return request<{ company: Company }>(`/api/v1/org/companies/${id}`, { method: "PUT", body: patch }).then((r) => r.company);
  },
  deleteCompany(id: string) {
    return request<void>(`/api/v1/org/companies/${id}`, { method: "DELETE" });
  },

  listUnits(companyId: string) {
    return request<{ units: OrgUnit[] }>(`/api/v1/org/companies/${companyId}/units`).then((r) => r.units);
  },
  createUnit(companyId: string, body: { name: string; kind: string; parent_id?: string | null }) {
    return request<{ unit: OrgUnit }>(`/api/v1/org/companies/${companyId}/units`, { method: "POST", body }).then((r) => r.unit);
  },
  updateUnit(id: string, patch: { name?: string; kind?: string; parent_id?: string | null }) {
    return request<{ unit: OrgUnit }>(`/api/v1/org/units/${id}`, { method: "PUT", body: patch }).then((r) => r.unit);
  },
  deleteUnit(id: string) {
    return request<void>(`/api/v1/org/units/${id}`, { method: "DELETE" });
  },

  assignUser(userId: string, body: { company_id?: string | null; org_unit_id?: string | null }) {
    return request<{ user: { id: string; company_id: string | null; org_unit_id: string | null } }>(
      `/api/v1/org/users/${userId}/assignment`,
      { method: "PUT", body },
    ).then((r) => r.user);
  },
};
