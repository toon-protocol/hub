import { Text } from 'ink';
import type { ReactElement } from 'react';
import { COPY } from '../copy.js';

interface QualifierProps {
  eventsRelayed: number;
}

export function Qualifier({ eventsRelayed }: QualifierProps): ReactElement {
  return (
    <Text color="yellow">
      {COPY.qualifierPrefix} · {COPY.qualifierEvents(eventsRelayed)} · {COPY.heroEarly}
    </Text>
  );
}
