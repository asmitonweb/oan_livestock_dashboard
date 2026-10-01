import type { ChartSource } from "./chart-source"
import type { ChartFilters, ChartId, Rows } from "./catalog"

/**
 * Reads charts from the registry's dashboard-api:
 *   GET <baseUrl>/api/v1/charts/<chartId>?<filters>  ->  JSON array of rows
 * The service may wrap the array as `{ data: [...] }`.
 *
 * The dashboard-api owns the registry database credentials; this process only
 * knows its cluster-internal URL. It is not exposed outside the cluster.
 */
export class HttpChartSource implements ChartSource {
  readonly name = "dashboard-api"

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async rows(chart: ChartId, filters: ChartFilters): Promise<Rows> {
    const query = new URLSearchParams(filters as Record<string, string>).toString()
    const url = `${this.baseUrl}/api/v1/charts/${encodeURIComponent(chart)}${query ? `?${query}` : ""}`
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(this.timeoutMs) })
    if (!res.ok) throw new Error(`${chart} returned HTTP ${res.status}`)
    const body: unknown = await res.json()
    if (Array.isArray(body)) return body as Rows
    const data = (body as { data?: unknown } | null)?.data
    if (Array.isArray(data)) return data as Rows
    throw new Error(`${chart} returned no rows`)
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { cache: "no-store", signal: AbortSignal.timeout(3_000) })
      return res.ok
    } catch {
      return false
    }
  }
}
