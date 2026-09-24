import type { Campaign, ImpactType } from "./types.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Margin impact of an issue, in EUR.
 * - overtime: extra hours paid at the overtime rate
 * - understaffing: billable hours not delivered (revenue lost)
 * - sla_penalty: contractual penalty at risk (defaults to one day's penalty)
 * - other: whatever amount the owner states
 */
export function impactAmount(
  c: Pick<Campaign, "hourly_cost" | "billing_rate" | "overtime_multiplier" | "sla_penalty_per_day">,
  type: ImpactType,
  hours: number,
  statedAmount?: number | null,
): number {
  switch (type) {
    case "none":
      return 0;
    case "overtime":
      return round2(hours * c.hourly_cost * c.overtime_multiplier);
    case "understaffing":
      return round2(hours * c.billing_rate);
    case "sla_penalty":
      return round2(statedAmount ?? c.sla_penalty_per_day);
    case "other":
      return round2(statedAmount ?? 0);
  }
}

/** Revenue at risk for a staffing gap over the hours left in the shift. */
export function gapCost(c: Pick<Campaign, "billing_rate">, gap: number, hoursLeft: number): number {
  return round2(Math.max(0, gap) * Math.max(0, hoursLeft) * c.billing_rate);
}

export interface DailyEconomics {
  revenue: number; labour_cost: number; sla_penalty: number; margin: number; margin_pct: number;
}

export function dailyEconomics(
  c: Pick<Campaign, "hourly_cost" | "billing_rate" | "overtime_multiplier" | "sla_target_pct" | "sla_penalty_per_day">,
  d: { billed_hours: number; paid_hours: number; overtime_hours: number; sla_pct: number },
): DailyEconomics {
  const revenue = d.billed_hours * c.billing_rate;
  const labour = d.paid_hours * c.hourly_cost + d.overtime_hours * c.hourly_cost * c.overtime_multiplier;
  const penalty = d.sla_pct < c.sla_target_pct ? c.sla_penalty_per_day : 0;
  const margin = revenue - labour - penalty;
  return {
    revenue: round2(revenue),
    labour_cost: round2(labour),
    sla_penalty: round2(penalty),
    margin: round2(margin),
    margin_pct: revenue > 0 ? round2((margin / revenue) * 100) : 0,
  };
}
