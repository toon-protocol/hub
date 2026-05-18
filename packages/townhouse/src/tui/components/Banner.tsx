import { Text } from 'ink';
import type { ReactElement } from 'react';
import { COPY } from '../copy.js';

interface BannerProps {
  bannerKey: 'connector_unavailable' | 'fetch_failed' | null;
}

export function Banner({ bannerKey }: BannerProps): ReactElement | null {
  if (bannerKey === null) return null;

  const isError = bannerKey === 'fetch_failed';
  const text = isError
    ? COPY.banners.fetchFailed
    : COPY.banners.connectorUnavailable;

  return <Text color={isError ? 'red' : 'yellow'}>{text}</Text>;
}
