import { useEffect, useRef, useState } from 'react';
import type { WizardProgressMessage } from '@toon-protocol/townhouse';

export type WizardProgressStatus = 'connecting' | 'open' | 'closed';

export interface UseWizardProgressResult {
  messages: WizardProgressMessage[];
  status: WizardProgressStatus;
}

interface UseWizardProgressOptions {
  url?: string;
  /** Maximum reconnect attempts before giving up (default 5). Tests can pass 0. */
  maxReconnects?: number;
}

function defaultUrl(): string {
  if (typeof window === 'undefined')
    return 'ws://127.0.0.1:9400/api/wizard/progress';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/wizard/progress`;
}

/**
 * Opens WS /api/wizard/progress and accumulates progress messages.
 * Reconnects with bounded exponential backoff on transient drops; the server's
 * progressBuffer replays missed messages on reconnect. Auto-closes on unmount.
 */
export function useWizardProgress(
  options: UseWizardProgressOptions = {}
): UseWizardProgressResult {
  const url = options.url ?? defaultUrl();
  const maxReconnects = options.maxReconnects ?? 5;

  const [messages, setMessages] = useState<WizardProgressMessage[]>([]);
  const [status, setStatus] = useState<WizardProgressStatus>('connecting');
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    function connect(): void {
      if (cancelled) return;

      try {
        socket = new WebSocket(url);
      } catch {
        setStatus('closed');
        return;
      }
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (cancelled) return;
        attempt = 0;
        setStatus('open');
      });

      socket.addEventListener('message', (event) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(String(event.data)) as WizardProgressMessage;
          setMessages((prev) => [...prev, msg]);
        } catch {
          // Ignore malformed messages
        }
      });

      const onCloseOrError = () => {
        if (cancelled) return;
        if (attempt >= maxReconnects) {
          setStatus('closed');
          return;
        }
        attempt++;
        setStatus('connecting');
        // Bounded exponential backoff: 250ms, 500ms, 1s, 2s, 4s
        const delay = Math.min(250 * 2 ** (attempt - 1), 4000);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      };

      socket.addEventListener('close', onCloseOrError);
      socket.addEventListener('error', onCloseOrError);
    }

    connect();

    return () => {
      cancelled = true;
      socketRef.current = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        socket?.close();
      } catch {
        /* best-effort */
      }
    };
  }, [url, maxReconnects]);

  return { messages, status };
}
