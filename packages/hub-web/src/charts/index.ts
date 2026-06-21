/**
 * Chart exports — all view stories import from here, never from 'recharts' directly.
 * Wraps shadcn/ui chart components (Recharts under the hood).
 */

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  type ChartConfig,
} from './chart';

// Re-export Recharts primitives for view stories that need them.
// Import from '@/charts', never from 'recharts' directly (AC-9 / no-direct-recharts rule).
export {
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
