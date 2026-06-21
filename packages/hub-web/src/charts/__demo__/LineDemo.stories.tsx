import type { Meta, StoryObj } from '@storybook/react';
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
import { colors } from '@/theme/tokens';

const meta: Meta = {
  title: 'Charts/LineDemo',
  parameters: {
    layout: 'centered',
  },
};
export default meta;

type Story = StoryObj;

const chartConfig = {
  packets: {
    label: 'Packets Forwarded',
    color: colors.type.town,
  },
} satisfies ChartConfig;

// 24-hour synthetic dataset (Storybook fixture only — never used in product dev server)
const data = Array.from({ length: 24 }, (_, i) => ({
  hour: `${i.toString().padStart(2, '0')}:00`,
  packets: Math.floor(Math.random() * 1000 + 200),
}));

export const Default: Story = {
  render: () => (
    <div style={{ width: 600, height: 300 }}>
      <ChartContainer config={chartConfig} style={{ width: '100%', height: '100%' }}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
          <XAxis dataKey="hour" tick={{ fontSize: 11, fontFamily: 'Geist Mono, monospace' }} />
          <YAxis tick={{ fontSize: 11, fontFamily: 'Geist Mono, monospace' }} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Line
            type="monotone"
            dataKey="packets"
            stroke={colors.type.town}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ChartContainer>
    </div>
  ),
};
