import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  type ChartConfig,
} from '@/charts';

export interface ThroughputChartProps {
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  buckets: Array<{ ts: number; count: number }>;
  count: number;
  /** Chart line color from tokens.type.*. */
  color: string;
  /** Optional earnings estimate; if provided, renders below the chart. */
  earningsEst?: string | null;
}

export function ThroughputChart({
  buckets,
  status,
  count,
  color,
  earningsEst,
}: ThroughputChartProps) {
  if (status === 'loading') {
    return (
      <div className="flex h-24 items-center justify-center" role="status" aria-label="Loading chart">
        <svg className="h-5 w-5 animate-spin text-ink/30" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="31.4 31.4" />
        </svg>
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <p className="py-2 text-xs text-ink/40">
        Volume chart requires connector v3.4+ (endpoint not yet available).
      </p>
    );
  }

  if (status === 'error') {
    return <p className="py-2 text-xs text-ink/40">Could not load chart data.</p>;
  }

  const chartConfig: ChartConfig = {
    count: {
      label: 'Per hour',
      color,
    },
  };

  const chartData = buckets.map((b) => ({
    ts: new Date(b.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    count: b.count,
  }));

  const showEarnings = !!earningsEst && count > 0;

  return (
    <div>
      <ChartContainer config={chartConfig} className="h-24">
        <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
          <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} width={28} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Line
            type="monotone"
            dataKey="count"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
          />
        </LineChart>
      </ChartContainer>
      {showEarnings && (
        <p className="font-geist-mono mt-1 text-xs text-ink/50">{earningsEst}</p>
      )}
    </div>
  );
}
