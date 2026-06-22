import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const inputWrapperVariants = cva('relative flex items-center shadow-border rounded-md bg-canvas', {
  variants: {
    variant: {
      default: '',
      slider: 'overflow-hidden px-3 py-2',
      numeric: 'font-geist-mono',
      chip: 'flex-row flex-wrap gap-1 px-2 py-1',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

const inputInnerVariants = cva(
  [
    'flex-1 bg-transparent px-3 py-2 text-sm text-ink outline-none',
    'font-geist-sans placeholder:text-ink/40 tracking-tight-14',
    'disabled:cursor-not-allowed disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        default: '',
        slider: 'h-2 cursor-pointer accent-ink p-0',
        numeric: 'font-geist-mono tabular-nums',
        chip: 'px-1 py-0 min-w-0 w-20',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

const chipPillClass =
  'inline-flex items-center gap-1 rounded shadow-border bg-canvas px-2 py-0.5 text-xs font-geist-mono';

export interface ChipValue {
  /** Stable ID used for keys + remove callback */
  id: string;
  /** Visible chip label */
  label: string;
}

type CommonInputAttrs = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'children' | 'onChange' | 'value' | 'type'
>;

interface BaseInputProps extends CommonInputAttrs, VariantProps<typeof inputWrapperVariants> {
  label?: string;
  /** Optional id used to wire <label htmlFor> to <input id>. Auto-generated if omitted. */
  id?: string;
}

interface DefaultInputProps extends BaseInputProps {
  variant?: 'default';
  type?: string;
  value?: string | number | readonly string[];
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
}

interface NumericInputProps extends BaseInputProps {
  variant: 'numeric';
  type?: 'number' | 'text';
  value?: string | number;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  min?: number | string;
  max?: number | string;
  step?: number | string;
}

interface SliderInputProps extends BaseInputProps {
  variant: 'slider';
  /** Slider value (controlled). */
  value?: number;
  /** Receives the change event and the parsed numeric value. */
  onChange?: (event: React.ChangeEvent<HTMLInputElement>, value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

interface ChipInputProps extends BaseInputProps {
  variant: 'chip';
  /** Currently selected chips. */
  chips: readonly ChipValue[];
  /** Called when a chip's × is clicked. */
  onChipRemove?: (id: string) => void;
  /** Text input value (for entering new chips). */
  value?: string;
  /** Standard onChange for the inner text input. */
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
}

export type InputProps =
  | DefaultInputProps
  | NumericInputProps
  | SliderInputProps
  | ChipInputProps;

let idCounter = 0;
function useStableId(passed?: string): string {
  const ref = React.useRef<string | null>(null);
  if (ref.current === null) {
    ref.current = passed ?? `hub-input-${++idCounter}`;
  }
  return passed ?? ref.current;
}

export function Input(props: InputProps) {
  const variant = props.variant ?? 'default';
  const id = useStableId(props.id);
  const wrapperCls = cn(inputWrapperVariants({ variant }), props.className);
  const innerCls = inputInnerVariants({ variant });

  if (props.variant === 'slider') {
    const { onChange, value, min, max, step, label, className: _c, id: _id, variant: _v, ...rest } = props;
    void _c; void _id; void _v;
    return (
      <div className={wrapperCls}>
        {label && (
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
        )}
        <input
          {...rest}
          id={id}
          type="range"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange?.(e, Number(e.target.value))}
          className={innerCls}
          aria-label={rest['aria-label'] ?? label}
        />
      </div>
    );
  }

  if (props.variant === 'chip') {
    const {
      chips,
      onChipRemove,
      onChange,
      value,
      label,
      className: _c,
      id: _id,
      variant: _v,
      ...rest
    } = props;
    void _c; void _id; void _v;
    return (
      <div className={wrapperCls}>
        {label && (
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
        )}
        {chips.map((chip) => (
          <span key={chip.id} className={chipPillClass}>
            {chip.label}
            {onChipRemove && (
              <button
                type="button"
                onClick={() => onChipRemove(chip.id)}
                aria-label={`Remove ${chip.label}`}
                className="text-ink/50 hover:text-ink"
              >
                ×
              </button>
            )}
          </span>
        ))}
        <input
          {...rest}
          id={id}
          type="text"
          value={value}
          onChange={onChange}
          className={innerCls}
          aria-label={rest['aria-label'] ?? label}
        />
      </div>
    );
  }

  if (props.variant === 'numeric') {
    const { onChange, value, type, label, className: _c, id: _id, variant: _v, ...rest } = props;
    void _c; void _id; void _v;
    return (
      <div className={wrapperCls}>
        {label && (
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
        )}
        <input
          {...rest}
          id={id}
          type={type ?? 'number'}
          inputMode="numeric"
          value={value}
          onChange={onChange}
          className={innerCls}
          aria-label={rest['aria-label'] ?? label}
        />
      </div>
    );
  }

  // default
  const { onChange, value, type, label, className: _c, id: _id, variant: _v, ...rest } = props;
  void _c; void _id; void _v;
  return (
    <div className={wrapperCls}>
      {label && (
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
      )}
      <input
        {...rest}
        id={id}
        type={type ?? 'text'}
        value={value}
        onChange={onChange}
        className={innerCls}
        aria-label={rest['aria-label'] ?? label}
      />
    </div>
  );
}

Input.displayName = 'Input';
