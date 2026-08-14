import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getCashEntries, type CashEntryFilters } from "@/lib/cash-register";

export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "cash_register.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;

  const filters: CashEntryFilters = {
    type: "EXPENSE",
    category,
    from: fromParam ? new Date(fromParam) : undefined,
    to: toParam ? new Date(toParam) : undefined,
  };

  const entries = await getCashEntries(user.tenantId, filters);
  return NextResponse.json({ entries });
}
