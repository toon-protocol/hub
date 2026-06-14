import { describe, it, expect } from 'vitest';
import {
  compareSemver,
  computeVersionInfo,
  lowerBound,
  readSelfPackage,
  satisfiesLowerBound,
} from './version.js';

describe('lowerBound', () => {
  it('strips range operators', () => {
    expect(lowerBound('>=0.26.0')).toBe('0.26.0');
    expect(lowerBound('^1.2.3')).toBe('1.2.3');
    expect(lowerBound('~0.5.0')).toBe('0.5.0');
    expect(lowerBound('0.26.0')).toBe('0.26.0');
  });
});

describe('compareSemver', () => {
  it('orders by major.minor.patch', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('0.26.1', '0.26.0')).toBe(1);
  });

  it('ignores pre-release tags', () => {
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(0);
  });
});

describe('satisfiesLowerBound', () => {
  it('treats * as always satisfied', () => {
    expect(satisfiesLowerBound('0.0.1', '*')).toBe(true);
  });
  it('checks the floor of a >= range', () => {
    expect(satisfiesLowerBound('0.26.0', '>=0.26.0')).toBe(true);
    expect(satisfiesLowerBound('0.27.3', '>=0.26.0')).toBe(true);
    expect(satisfiesLowerBound('0.25.9', '>=0.26.0')).toBe(false);
  });
});

describe('computeVersionInfo', () => {
  const self = { version: '0.1.0', peerRange: '>=0.26.0' };

  it('reports satisfies:true for a recent CLI', async () => {
    const info = await computeVersionInfo(self, async () => '0.26.0');
    expect(info).toMatchObject({
      mcpVersion: '0.1.0',
      expectedTownhouseRange: '>=0.26.0',
      detectedCliVersion: '0.26.0',
      satisfies: true,
    });
  });

  it('reports satisfies:false for a too-old CLI', async () => {
    const info = await computeVersionInfo(self, async () => '0.25.0');
    expect(info.satisfies).toBe(false);
    expect(info.note).toMatch(/older than/);
  });

  it('reports satisfies:null when the CLI cannot be probed', async () => {
    const info = await computeVersionInfo(self, async () => undefined);
    expect(info.detectedCliVersion).toBeNull();
    expect(info.satisfies).toBeNull();
    expect(info.note).toMatch(/Could not probe/);
  });

  it('surfaces the TOWNHOUSE_BIN hint when the probe throws CliNotFoundError', async () => {
    const notFound = Object.assign(
      new Error('townhouse CLI not found ... Set TOWNHOUSE_BIN to the CLI'),
      { name: 'CliNotFoundError' }
    );
    const info = await computeVersionInfo(self, async () => {
      throw notFound;
    });
    expect(info.detectedCliVersion).toBeNull();
    expect(info.satisfies).toBeNull();
    expect(info.note).toMatch(/TOWNHOUSE_BIN/);
  });

  it('falls back to "could not probe" for a non-CliNotFound probe error', async () => {
    const info = await computeVersionInfo(self, async () => {
      throw new Error('some other failure');
    });
    expect(info.satisfies).toBeNull();
    expect(info.note).toMatch(/Could not probe/);
  });
});

describe('readSelfPackage', () => {
  it('reads version + peer range from package.json', () => {
    const fake = ((id: string) => {
      expect(id).toBe('../package.json');
      return {
        version: '9.9.9',
        peerDependencies: { '@toon-protocol/townhouse': '>=1.2.3' },
      };
    }) as unknown as NodeRequire;
    expect(readSelfPackage(fake)).toEqual({
      version: '9.9.9',
      peerRange: '>=1.2.3',
    });
  });

  it('degrades to defaults when package.json is unreadable', () => {
    const boom = (() => {
      throw new Error('not found');
    }) as unknown as NodeRequire;
    expect(readSelfPackage(boom)).toEqual({ version: '0.0.0', peerRange: '*' });
  });
});
