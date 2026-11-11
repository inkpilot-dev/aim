import { describe, it, expect } from 'vitest';
import { extensionSyncAction, parseExtensionVersion, readBundledExtensionVersion } from '../extension-sync.js';

describe('extension sync', () => {
  it('parses the extension version from the hello string', () => {
    expect(parseExtensionVersion('edge/142.0.3595.53 ext/0.1.6')).toBe('0.1.6');
    expect(parseExtensionVersion('chrome/140.0 ext/0.1.0')).toBe('0.1.0');
    expect(parseExtensionVersion('edge/142.0')).toBeUndefined();
    expect(parseExtensionVersion(undefined)).toBeUndefined();
  });
  it('reads the bundled manifest version', () => {
    expect(readBundledExtensionVersion('/x/manifest.json', () => '{"version":"0.1.6"}')).toBe('0.1.6');
    expect(readBundledExtensionVersion('/x/manifest.json', () => { throw new Error('ENOENT'); })).toBeUndefined();
  });
  it('asks an older extension to reload once, then reports a stale folder', () => {
    const requested = new Set<string>();
    expect(extensionSyncAction('0.1.0', '0.1.6', requested)).toBe('reload');
    requested.add('0.1.0');
    expect(extensionSyncAction('0.1.0', '0.1.6', requested)).toBe('stale-folder');
    expect(extensionSyncAction('0.1.6', '0.1.6', requested)).toBe('none');
    expect(extensionSyncAction('0.1.7', '0.1.6', requested)).toBe('none');
    expect(extensionSyncAction(undefined, '0.1.6', requested)).toBe('none');
  });
});
