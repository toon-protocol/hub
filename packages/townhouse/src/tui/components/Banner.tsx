import { Text } from 'ink';
import type { ReactElement } from 'react';
import { COPY } from '../copy.js';

interface BannerProps {
  bannerKey: 'connector_unavailable' | 'fetch_failed' | 'starting_up' | null;
}

export function Banner({ bannerKey }: BannerProps): ReactElement | null {
  if (bannerKey === null) return null;

  // 'starting_up' is the calm warm-up state (no successful fetch yet); the
  // others mean we had data and then lost it, which warrants a louder colour.
  if (bannerKey === 'starting_up') {
    return <Text color="cyan">{COPY.banners.startingUp}</Text>;
  }

  const isError = bannerKey === 'fetch_failed';
  const text = isError
    ? COPY.banners.fetchFailed
    : COPY.banners.connectorUnavailable;

  return <Text color={isError ? 'red' : 'yellow'}>{text}</Text>;
}
